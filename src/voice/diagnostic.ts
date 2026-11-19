import { readFile } from "node:fs/promises";
import type { VoiceControlConfig } from "../data/config.js";
import { getVoiceReply, speechEndpoint, synthesizeSpeech, toolsEndpoint, transcribeAudio, transcriptionEndpoint } from "./assistant.js";
import { loadWakeDetector } from "./keyword.js";

export async function testVoiceControl(config: VoiceControlConfig, signal: AbortSignal) {
  const stages = [
    testStage("wake", () => {
      try {
        loadWakeDetector(config.kwsDir, config.wakeWord);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          throw new Error("找不到唤醒模型文件，请检查服务端模型目录。");
        }
        throw err;
      }
      return `已加载「${config.wakeWord}」。请在 TeamSpeak 频道说出唤醒词，验证实际收音。`;
    }),
    testStage("asr", async () => {
      const endpoint = transcriptionEndpoint(config);
      const clip = await readFile(new URL("../../scripts/voice-test.wav", import.meta.url));
      const text = await transcribeAudio(endpoint, clip, signal);
      if (!text) throw new Error("内置录音「下一首」没有转写结果。");
      return `内置录音「下一首」的转写结果：${text}`;
    }),
    testStage("llm", async () => {
      const { command } = await getVoiceReply(toolsEndpoint(config), "下一首", signal);
      if (command?.name !== "next") {
        throw new Error(command ? `预期调用 next，模型调用了 ${command.name}。` : "模型没有为「下一首」返回可执行的工具调用。");
      }
      return "模型为「下一首」返回了 next。";
    }),
  ];
  if (config.ttsModel) {
    stages.push(testStage("tts", async () => {
      await synthesizeSpeech(speechEndpoint(config), "语音回复测试成功。", signal);
      return "语音已合成并解码，可以在 TeamSpeak 频道试用。";
    }));
  }
  return Promise.all(stages);
}

async function testStage(stage: "wake" | "asr" | "llm" | "tts", run: () => string | Promise<string>) {
  try {
    return { stage, ok: true, message: await run() };
  } catch (err) {
    return { stage, ok: false, message: (err as Error).message };
  }
}
