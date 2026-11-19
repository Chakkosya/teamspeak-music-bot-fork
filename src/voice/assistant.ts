import type { ParsedCommand } from "../bot/commands.js";
import type { VoiceControlConfig } from "../data/config.js";
import { decodeSpeech } from "../audio/speech.js";
import { loadWakeDetector, VOICE_BYTES_PER_SECOND, VOICE_SAMPLE_RATE, type WakeDetector } from "./keyword.js";

interface ModelEndpoint {
  baseUrl: string;
  model: string;
  apiKey?: string;
}

interface VoiceReply {
  command: ParsedCommand | null;
  text: string;
}

const tools = [
  {
    type: "function",
    function: {
      name: "play",
      description: "按歌曲名、歌手或搜索词点歌。需要明确的搜索词。",
      parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false },
    },
  },
  ...[
    ["pause", "暂停当前播放。"],
    ["next", "切换到下一首。"],
  ].map(([name, description]) => ({
    type: "function",
    function: { name, description, parameters: { type: "object", properties: {}, additionalProperties: false } },
  })),
];

export interface VoiceAssistant {
  newWakeDetector: () => WakeDetector;
  transcribe(pcm: Buffer, signal: AbortSignal): Promise<string>;
  reply(text: string, signal: AbortSignal): Promise<VoiceReply>;
  synthesize?: (text: string, signal: AbortSignal) => Promise<Buffer>;
}

export function createVoiceAssistant(config: VoiceControlConfig): VoiceAssistant | undefined {
  if (!config.enabled) return;
  const asr = transcriptionEndpoint(config);
  const llm = toolsEndpoint(config);
  const tts = config.ttsModel ? speechEndpoint(config) : undefined;
  return {
    newWakeDetector: loadWakeDetector(config.kwsDir, config.wakeWord),
    transcribe: (pcm, signal) => transcribeAudio(asr, wav(pcm), signal),
    reply: (text, signal) => getVoiceReply(llm, text, signal),
    synthesize: tts && ((text, signal) => synthesizeSpeech(tts, text, signal)),
  };
}

export function transcriptionEndpoint(config: VoiceControlConfig): ModelEndpoint {
  if (!config.asrModel) throw new Error("请填写语音转文字模型。");
  return {
    baseUrl: modelUrl(config.asrBaseUrl),
    model: config.asrModel,
    apiKey: config.asrApiKey,
  };
}

export function toolsEndpoint(config: VoiceControlConfig): ModelEndpoint {
  if (!config.llmModel) throw new Error("请填写 LLM 模型。");
  return sharedEndpoint(config.asrBaseUrl, config.asrApiKey, config.llmBaseUrl, config.llmModel, config.llmApiKey);
}

export function speechEndpoint(config: VoiceControlConfig) {
  return {
    ...sharedEndpoint(config.asrBaseUrl, config.asrApiKey, config.ttsBaseUrl, config.ttsModel, config.ttsApiKey),
    voice: config.ttsVoice || "alloy",
  };
}

function sharedEndpoint(asrBaseUrl: string, asrKey: string, url: string, model: string, apiKey: string): ModelEndpoint {
  const baseUrl = modelUrl(url || asrBaseUrl);
  const asrUrl = URL.parse(asrBaseUrl)?.href.replace(/\/+$/, "");
  return { baseUrl, model, apiKey: apiKey || (baseUrl === asrUrl ? asrKey : undefined) };
}

function modelUrl(input: string): string {
  const url = URL.parse(input);
  if (!url || !["http:", "https:"].includes(url.protocol) || url.search || url.hash) {
    throw new Error("服务地址须为 HTTP(S) API 根地址，例如 https://api.openai.com/v1。");
  }
  return url.href.replace(/\/+$/, "");
}

export async function transcribeAudio(asr: ModelEndpoint, wave: Buffer<ArrayBuffer>, signal: AbortSignal): Promise<string> {
  const audio = new FormData();
  audio.set("model", asr.model);
  audio.set("file", new Blob([wave], { type: "audio/wav" }), "command.wav");
  const transcript = await request(asr, "/audio/transcriptions", audio, signal, json<{ text?: string }>);
  if (typeof transcript?.text !== "string") throw new Error("转写接口未返回 text 字段。");
  return transcript.text.trim();
}

export async function getVoiceReply(llm: ModelEndpoint, text: string, signal: AbortSignal): Promise<VoiceReply> {
  type ToolCall = { function: { name: string; arguments: string } };
  type Completion = { choices: { message: { content?: string | null; tool_calls?: ToolCall[] } }[] };
  const completion = await request(llm, "/chat/completions", JSON.stringify({
    model: llm.model,
    messages: [
      { role: "system", content: "你是 TeamSpeak 频道里的音乐机器人。只在用户明确要求时调用一个播放工具，点歌时保留歌名和歌手。遇到闲聊、唤醒词、否定、引用、含糊或不支持的请求时，不调用工具，直接用一两句适合朗读的自然语言回答，不使用 Markdown。" },
      { role: "user", content: text },
    ],
    tools,
  }), signal, json<Completion>);

  const message = completion?.choices?.[0]?.message;
  if (!message) throw new Error("LLM 接口未返回聊天消息。");
  const calls = message.tool_calls;
  if (!calls?.length) return { command: null, text: message.content?.trim() ?? "" };
  return { command: calls.length === 1 ? parseAction(calls[0].function) : null, text: "" };
}

function parseAction(action: { name: string; arguments: string }): ParsedCommand | null {
  if (action.name === "pause" || action.name === "next") {
    return { name: action.name, args: "", rawArgs: [], flags: new Set() };
  }
  if (action.name !== "play") return null;
  let parameters: { query?: unknown } | null;
  try {
    parameters = JSON.parse(action.arguments);
  } catch {
    throw new Error("LLM 返回了无法解析的工具参数。");
  }
  const query = typeof parameters?.query === "string" ? parameters.query.trim() : "";
  return query ? { name: "play", args: query, rawArgs: query.split(/\s+/), flags: new Set() } : null;
}

export async function synthesizeSpeech(
  tts: ModelEndpoint & { voice: string }, text: string, signal: AbortSignal,
): Promise<Buffer> {
  const wave = await request(tts, "/audio/speech", JSON.stringify({
    model: tts.model,
    voice: tts.voice,
    input: text,
    response_format: "wav",
  }), signal, response => response.arrayBuffer());
  return decodeSpeech(Buffer.from(wave), signal);
}

async function json<T>(response: Response): Promise<T> {
  try {
    return await response.json() as T;
  } catch (err) {
    throw new Error("服务未返回 JSON，请检查 API 根地址。", { cause: err });
  }
}

async function request<T>(
  endpoint: ModelEndpoint, path: string, body: FormData | string, signal: AbortSignal, read: (response: Response) => Promise<T>,
): Promise<T> {
  const headers = new Headers();
  if (endpoint.apiKey) headers.set("Authorization", `Bearer ${endpoint.apiKey}`);
  if (typeof body === "string") headers.set("Content-Type", "application/json");
  const timeout = AbortSignal.timeout(20_000);
  let response: Response;
  try {
    response = await fetch(`${endpoint.baseUrl}${path}`, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.any([signal, timeout]),
    });
  } catch (err) {
    if (signal.aborted) throw err;
    throw new Error(timeout.aborted ? "服务请求超时。" : "无法连接服务，请检查接口地址和服务器网络。", { cause: err });
  }
  if (!response.ok) {
    const hints: Record<number, string> = {
      400: "请检查模型名和接口格式。",
      401: "请检查 API Key。",
      403: "请检查 API Key 和模型权限。",
      404: "请检查 API 根地址和模型名。",
      429: "请检查调用额度或频率限制。",
    };
    throw new Error(`HTTP ${response.status}。${hints[response.status] ?? ""}`);
  }
  try {
    return await read(response);
  } catch (err) {
    if (timeout.aborted && !signal.aborted) throw new Error("服务请求超时。", { cause: err });
    throw err;
  }
}

export function wav(pcm: Buffer): Buffer<ArrayBuffer> {
  const file = Buffer.alloc(44 + pcm.length);
  file.write("RIFF", 0);
  file.writeUInt32LE(file.length - 8, 4);
  file.write("WAVEfmt ", 8);
  file.writeUInt32LE(16, 16);
  file.writeUInt16LE(1, 20);
  file.writeUInt16LE(1, 22);
  file.writeUInt32LE(VOICE_SAMPLE_RATE, 24);
  file.writeUInt32LE(VOICE_BYTES_PER_SECOND, 28);
  file.writeUInt16LE(2, 32);
  file.writeUInt16LE(16, 34);
  file.write("data", 36);
  file.writeUInt32LE(pcm.length, 40);
  pcm.copy(file, 44);
  return file;
}
