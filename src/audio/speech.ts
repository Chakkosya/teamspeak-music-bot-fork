import { spawn } from "node:child_process";
import { once } from "node:events";
import { Readable } from "node:stream";
import { buffer } from "node:stream/consumers";
import { pipeline } from "node:stream/promises";
import { getFfmpegCommand } from "./player.js";

export async function decodeSpeech(wave: Buffer, signal: AbortSignal): Promise<Buffer> {
  const ffmpeg = spawn(getFfmpegCommand(), [
    "-i", "pipe:0", "-vn", "-f", "s16le", "-ar", "48000", "-ac", "2", "pipe:1",
  ], { signal, stdio: ["pipe", "pipe", "ignore"] });
  try {
    const [pcm, [code]] = await Promise.all([
      buffer(ffmpeg.stdout),
      once(ffmpeg, "close"),
      pipeline(Readable.from([wave]), ffmpeg.stdin),
    ]);
    if (code === 0 && pcm.length) return pcm;
  } catch (err) {
    if (signal.aborted) throw err;
    throw new Error("无法解码语音合成音频，请检查合成接口和服务器上的 FFmpeg。", { cause: err });
  }
  throw new Error("语音合成接口未返回可播放的音频。");
}
