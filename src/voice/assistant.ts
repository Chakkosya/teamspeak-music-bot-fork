import type { ParsedCommand } from "../bot/commands.js";
import type { VoiceControlConfig } from "../data/config.js";
import { loadWakeDetector, VOICE_BYTES_PER_SECOND, VOICE_SAMPLE_RATE, type WakeDetector } from "./keyword.js";

interface ModelEndpoint {
  baseUrl: string;
  model: string;
  apiKey?: string;
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
  interpret(pcm: Buffer, signal: AbortSignal): Promise<ParsedCommand | null>;
}

export function createVoiceAssistant(config: VoiceControlConfig): VoiceAssistant | undefined {
  if (!config.enabled) return;
  if (!config.asrModel || !config.llmModel) throw new Error("启用语音控制时，请填写语音转文字模型和 LLM 模型。");
  const asrUrl = modelUrl(config.asrBaseUrl);
  const llmUrl = config.llmBaseUrl ? modelUrl(config.llmBaseUrl) : asrUrl;
  const asr: ModelEndpoint = {
    baseUrl: asrUrl,
    model: config.asrModel,
    apiKey: config.asrApiKey,
  };
  const llm: ModelEndpoint = {
    baseUrl: llmUrl,
    model: config.llmModel,
    apiKey: config.llmApiKey || (llmUrl === asrUrl ? asr.apiKey : undefined),
  };
  return { newWakeDetector: loadWakeDetector(config.kwsDir, config.wakeWord), interpret: createVoiceInterpreter(asr, llm) };
}

function modelUrl(input: string): string {
  const url = URL.parse(input);
  if (!url || !["http:", "https:"].includes(url.protocol) || url.search || url.hash) {
    throw new Error("服务地址须为 HTTP(S) API 根地址，例如 https://api.openai.com/v1。");
  }
  return url.href.replace(/\/+$/, "");
}

export function createVoiceInterpreter(asr: ModelEndpoint, llm: ModelEndpoint): VoiceAssistant["interpret"] {
  return async (pcm, signal) => {
    const audio = new FormData();
    audio.set("model", asr.model);
    audio.set("file", new Blob([wav(pcm)], { type: "audio/wav" }), "command.wav");
    const transcript = await request<{ text: string }>(asr, "/audio/transcriptions", audio, signal);
    const text = transcript.text.trim();
    if (!text) return null;

    const completion = await request<{
      choices: { message: { tool_calls?: { function: { name: string; arguments: string } }[] } }[];
    }>(llm, "/chat/completions", JSON.stringify({
      model: llm.model,
      messages: [
        { role: "system", content: "你控制音乐机器人。只在用户明确要求时调用一个工具。遇到闲聊、唤醒词、否定、引用、含糊或不支持的请求时，不调用工具。点歌时保留歌名和歌手。" },
        { role: "user", content: text },
      ],
      tools,
    }), signal);

    const calls = completion.choices[0]?.message.tool_calls;
    if (calls?.length !== 1) return null;
    const action = calls[0].function;
    if (action.name === "pause" || action.name === "next") {
      return { name: action.name, args: "", rawArgs: [], flags: new Set() };
    }
    if (action.name !== "play") return null;
    const parameters = JSON.parse(action.arguments) as { query?: unknown } | null;
    const query = typeof parameters?.query === "string" ? parameters.query.trim() : "";
    return query ? { name: "play", args: query, rawArgs: query.split(/\s+/), flags: new Set() } : null;
  };
}

async function request<T>(endpoint: ModelEndpoint, path: string, body: FormData | string, signal: AbortSignal): Promise<T> {
  const headers = new Headers();
  if (endpoint.apiKey) headers.set("Authorization", `Bearer ${endpoint.apiKey}`);
  if (typeof body === "string") headers.set("Content-Type", "application/json");
  const response = await fetch(`${endpoint.baseUrl.replace(/\/+$/, "")}${path}`, {
    method: "POST",
    headers,
    body,
    signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
  });
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return await response.json() as T;
}

function wav(pcm: Buffer): Buffer<ArrayBuffer> {
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
