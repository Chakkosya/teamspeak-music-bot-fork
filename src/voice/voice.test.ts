import opus from "@discordjs/opus";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createVoiceInterpreter } from "./assistant.js";
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
    const interpret = createVoiceInterpreter(
      { baseUrl: "https://asr.example/v1", model: "speech", apiKey: "asr-key" },
      { baseUrl: "https://llm.example/v1", model: "music", apiKey: "llm-key" },
    );
    const execute = vi.fn();
    const newWakeDetector = vi.fn().mockReturnValueOnce(() => null).mockReturnValueOnce(() => bytesPerFrame * 6);
    const session = new VoiceSession(newWakeDetector, (speaker, pcm, signal) => {
      void interpret(pcm, signal).then(command => execute(speaker, command));
    });

    speak(session, 8);
    await vi.advanceTimersByTimeAsync(700);
    expect(fetchMock).not.toHaveBeenCalled();
    speak(session, 7);
    await vi.advanceTimersByTimeAsync(700);

    const [[asrUrl, asrRequest], [llmUrl, llmRequest]] = fetchMock.mock.calls;
    expect(asrUrl).toBe("https://asr.example/v1/audio/transcriptions");
    expect(asrRequest.headers.get("Authorization")).toBe("Bearer asr-key");
    const file = asrRequest.body.get("file") as File;
    const wav = Buffer.from(await file.arrayBuffer());
    expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
    expect(wav.readUInt32LE(24)).toBe(VOICE_SAMPLE_RATE);
    expect(wav.readUInt32LE(40)).toBe(bytesPerFrame * (20 - 6));
    expect(llmUrl).toBe("https://llm.example/v1/chat/completions");
    expect(llmRequest.headers.get("Authorization")).toBe("Bearer llm-key");
    expect(JSON.parse(llmRequest.body).messages[1]).toEqual({ role: "user", content: "放周杰伦的晴天" });
    expect(execute).toHaveBeenCalledExactlyOnceWith(
      { clientId: 7, nickname: "Speaker 7" },
      { name: "play", args: "周杰伦 晴天", rawArgs: ["周杰伦", "晴天"], flags: new Set() },
    );
  });

  it("reserves a wake-only follow-up for its speaker and cancels it when the speaker leaves", async () => {
    vi.useFakeTimers();
    const onAudio = vi.fn();
    const newWakeDetector = vi.fn().mockReturnValueOnce(() => bytesPerFrame * 20).mockReturnValue(() => null);
    const session = new VoiceSession(newWakeDetector, onAudio);
    speak(session, 7);
    await vi.advanceTimersByTimeAsync(700);
    speak(session, 8);
    await vi.advanceTimersByTimeAsync(700);
    expect(onAudio).not.toHaveBeenCalled();

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
    [{ function: { name: "pause", arguments: "{}" } }, { function: { name: "next", arguments: "{}" } }],
  ].map(calls => [calls]))("does not produce a command for tool calls %j", async (calls) => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(Response.json({ text: "不确定" }))
      .mockResolvedValueOnce(Response.json({ choices: [{ message: { tool_calls: calls } }] })));
    const endpoint = { baseUrl: "https://model.example/v1", model: "test" };
    const interpret = createVoiceInterpreter(endpoint, endpoint);
    await expect(interpret(Buffer.alloc(12_800), new AbortController().signal)).resolves.toBeNull();
  });
});
