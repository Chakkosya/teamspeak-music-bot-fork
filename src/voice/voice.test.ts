import opus from "@discordjs/opus";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getVoiceReply, transcribeAudio, wav } from "./assistant.js";
import { VOICE_SAMPLE_RATE } from "./keyword.js";
import { VoiceSession } from "./session.js";

const samplesPerFrame = VOICE_SAMPLE_RATE / 50;
const bytesPerFrame = samplesPerFrame * 2;

function speak(session: VoiceSession, clientId: number, frames = 20): void {
  const encoder = new opus.OpusEncoder(VOICE_SAMPLE_RATE, 1);
  const pcm = Buffer.alloc(bytesPerFrame);
  for (let sample = 0; sample < samplesPerFrame; sample++) {
    pcm.writeInt16LE(Math.round(12_000 * Math.sin(2 * Math.PI * 500 * sample / VOICE_SAMPLE_RATE)), sample * 2);
  }
  for (let frame = 0; frame < frames; frame++) {
    session.receive({ clientId, nickname: `Speaker ${clientId}`, codec: 4, data: encoder.encode(pcm) });
  }
}

describe("voice command pipeline", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("uploads only the command after a same-sentence wake and passes the transcript to the LLM", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ text: "放周杰伦的晴天" }))
      .mockResolvedValueOnce(Response.json({ choices: [{ message: { tool_calls: [
        { function: { name: "play", arguments: JSON.stringify({ query: "周杰伦 晴天" }) } },
      ] } }] }));
    vi.stubGlobal("fetch", fetchMock);
    const asr = { baseUrl: "https://asr.example/v1", model: "speech", apiKey: "asr-key" };
    const llm = { baseUrl: "https://llm.example/v1", model: "music", apiKey: "llm-key" };
    const execute = vi.fn();
    const newWakeDetector = vi.fn().mockReturnValueOnce(() => null).mockReturnValueOnce(() => bytesPerFrame * 6);
    const session = new VoiceSession(650, newWakeDetector, async (speaker, pcm, signal) => {
      const text = await transcribeAudio(asr, wav(pcm), signal);
      const { command } = await getVoiceReply(llm, text, signal);
      execute(speaker, command);
    }, vi.fn());

    speak(session, 8);
    await vi.advanceTimersByTimeAsync(700);
    expect(fetchMock).not.toHaveBeenCalled();
    speak(session, 7);
    await vi.advanceTimersByTimeAsync(700);

    const [[asrUrl, asrRequest], [llmUrl, llmRequest]] = fetchMock.mock.calls;
    expect(asrUrl).toBe("https://asr.example/v1/audio/transcriptions");
    expect(asrRequest.headers.get("Authorization")).toBe("Bearer asr-key");
    const file = asrRequest.body.get("file") as File;
    const wave = Buffer.from(await file.arrayBuffer());
    expect(wave.toString("ascii", 0, 4)).toBe("RIFF");
    expect(wave.readUInt32LE(24)).toBe(VOICE_SAMPLE_RATE);
    expect(wave.readUInt32LE(40)).toBe(bytesPerFrame * (20 - 6));
    expect(llmUrl).toBe("https://llm.example/v1/chat/completions");
    expect(llmRequest.headers.get("Authorization")).toBe("Bearer llm-key");
    expect(JSON.parse(llmRequest.body).messages[1]).toEqual({ role: "user", content: "放周杰伦的晴天" });
    expect(execute).toHaveBeenCalledExactlyOnceWith(
      { clientId: 7, nickname: "Speaker 7" },
      { name: "play", args: "周杰伦 晴天", rawArgs: ["周杰伦", "晴天"], flags: new Set() },
    );
  });

  it("keeps collecting during a pause shorter than the configured delay", () => {
    vi.useFakeTimers();
    const onAudio = vi.fn();
    const session = new VoiceSession(1200, () => () => bytesPerFrame * 6, onAudio, vi.fn());

    speak(session, 7);
    vi.advanceTimersByTime(800);
    expect(onAudio).not.toHaveBeenCalled();

    speak(session, 7);
    vi.advanceTimersByTime(1199);
    expect(onAudio).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onAudio).toHaveBeenCalledOnce();
    expect(onAudio.mock.calls[0][1]).toHaveLength(bytesPerFrame * (40 - 6));
  });

  it("reserves a wake-only follow-up for its speaker and cancels it when the speaker leaves", async () => {
    vi.useFakeTimers();
    const onAudio = vi.fn();
    const onWakeOnly = vi.fn();
    const newWakeDetector = vi.fn().mockReturnValueOnce(() => bytesPerFrame * 20).mockReturnValue(() => null);
    const session = new VoiceSession(650, newWakeDetector, onAudio, onWakeOnly);
    speak(session, 7);
    await vi.advanceTimersByTimeAsync(700);
    speak(session, 8);
    await vi.advanceTimersByTimeAsync(700);
    expect(onAudio).not.toHaveBeenCalled();
    expect(onWakeOnly).toHaveBeenCalledOnce();

    speak(session, 7);
    await vi.advanceTimersByTimeAsync(700);
    expect(onAudio).toHaveBeenCalledTimes(1);
    expect(onAudio.mock.calls[0][0]).toEqual({ clientId: 7, nickname: "Speaker 7" });
    const signal = onAudio.mock.calls[0][2] as AbortSignal;

    newWakeDetector.mockReturnValueOnce(() => bytesPerFrame * 20);
    speak(session, 7);
    await vi.advanceTimersByTimeAsync(700);
    session.removeSpeaker(7);
    expect(signal.aborted).toBe(true);
    speak(session, 7);
    await vi.advanceTimersByTimeAsync(700);
    expect(onAudio).toHaveBeenCalledTimes(1);
  });

  it.each([
    [],
    [{ function: { name: "clear", arguments: "{}" } }],
    [{ function: { name: "play", arguments: '{"query":" "}' } }],
    [{ function: { name: "set_volume", arguments: '{"percent":101}' } }],
    [{ function: { name: "set_play_mode", arguments: '{"mode":"single"}' } }],
    [{ function: { name: "pause", arguments: "{}" } }, { function: { name: "next", arguments: "{}" } }],
  ].map(calls => [calls]))("does not produce a command for tool calls %j", async (calls) => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(Response.json({ choices: [{ message: { tool_calls: calls } }] })));
    const endpoint = { baseUrl: "https://model.example/v1", model: "test" };
    const reply = await getVoiceReply(endpoint, "不确定", new AbortController().signal);
    expect(reply.command).toBeNull();
  });

  it.each([
    ["继续播放", "resume", {}, { name: "resume", args: "" }],
    ["上一首", "prev", {}, { name: "prev", args: "" }],
    ["停止播放并清空队列", "stop", {}, { name: "stop", args: "" }],
    ["音量调到六十", "set_volume", { percent: 60 }, { name: "vol", args: "60" }],
    ["小声一点", "adjust_volume", { delta: -10 }, { name: "vol", volumeDelta: -10 }],
    ["改成顺序播放", "set_play_mode", { mode: "seq" }, { name: "mode", args: "seq" }],
  ] as const)("exposes and converts the tool for %s", async (text, name, parameters, command) => {
    const fetchModel = vi.fn(async (_url: string, { body }: RequestInit) => {
      const request = JSON.parse(body as string) as { tools: { function: { name: string } }[] };
      expect(request.tools.some(tool => tool.function.name === name)).toBe(true);
      return Response.json({ choices: [{ message: { tool_calls: [
        { function: { name, arguments: JSON.stringify(parameters) } },
      ] } }] });
    });
    vi.stubGlobal("fetch", fetchModel);
    const endpoint = { baseUrl: "https://model.example/v1", model: "test" };
    const reply = await getVoiceReply(endpoint, text, new AbortController().signal);
    expect(reply.command).toMatchObject(command);
  });

  it("returns the LLM's text when there is no playback command", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({
      choices: [{ message: { content: "你好，想听什么歌？" } }],
    })));
    const endpoint = { baseUrl: "https://model.example/v1", model: "test" };
    await expect(getVoiceReply(endpoint, "你好", new AbortController().signal)).resolves.toEqual({
      command: null,
      text: "你好，想听什么歌？",
    });
  });
});
