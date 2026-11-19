import opus from "@discordjs/opus";
import type { TS3VoiceFrame } from "../ts-protocol/client.js";
import { VOICE_BYTES_PER_SECOND, VOICE_SAMPLE_RATE, type WakeDetector } from "./keyword.js";

const FOLLOW_UP_MS = 4_000;
const MAX_AUDIO_BYTES = VOICE_BYTES_PER_SECOND * 10;
const MIN_COMMAND_BYTES = VOICE_BYTES_PER_SECOND * 0.18;
const WAKE_TAIL = Buffer.alloc(VOICE_BYTES_PER_SECOND * 0.4);

interface Utterance {
  frames: Buffer[];
  bytes: number;
  lastSpeechByte: number;
  detectWake?: WakeDetector;
  wakeAt: number | null;
  timer?: ReturnType<typeof setTimeout>;
}

interface SpeakerSession {
  decoder: opus.OpusEncoder;
  lifetime: AbortController;
  utterance?: Utterance;
  armedUntil: number;
}

type Speaker = Pick<TS3VoiceFrame, "clientId" | "nickname">;

export class VoiceSession {
  private speakers = new Map<number, SpeakerSession>();

  constructor(
    private endOfSpeechMs: number,
    private newWakeDetector: () => WakeDetector,
    private onAudio: (speaker: Speaker, pcm: Buffer, signal: AbortSignal) => void,
    private onWakeOnly: () => void,
  ) {}

  receive({ clientId, nickname, data }: TS3VoiceFrame): void {
    let speaker = this.speakers.get(clientId);
    if (!speaker) {
      speaker = { decoder: new opus.OpusEncoder(VOICE_SAMPLE_RATE, 1), lifetime: new AbortController(), armedUntil: 0 };
      this.speakers.set(clientId, speaker);
    }

    let pcm: Buffer;
    try {
      pcm = speaker.decoder.decode(Buffer.from(data));
    } catch {
      return;
    }
    const speech = containsSpeech(pcm);
    if (!speech && !speaker.utterance) return;
    if (!speaker.utterance) {
      const armed = Date.now() < speaker.armedUntil;
      speaker.armedUntil = 0;
      speaker.utterance = {
        frames: [], bytes: 0, lastSpeechByte: 0,
        detectWake: armed ? undefined : this.newWakeDetector(),
        wakeAt: armed ? 0 : null,
      };
    }
    const utterance = speaker.utterance;
    utterance.frames.push(pcm);
    utterance.bytes += pcm.length;
    if (utterance.wakeAt === null) utterance.wakeAt = utterance.detectWake!(pcm);
    if (speech) {
      utterance.lastSpeechByte = utterance.bytes;
      clearTimeout(utterance.timer);
      const currentSpeaker = speaker;
      utterance.timer = setTimeout(() => this.finish({ clientId, nickname }, currentSpeaker), this.endOfSpeechMs);
    }
    if (utterance.bytes >= MAX_AUDIO_BYTES) this.finish({ clientId, nickname }, speaker);
  }

  removeSpeaker(clientId: number): void {
    const speaker = this.speakers.get(clientId);
    if (!speaker) return;
    clearTimeout(speaker.utterance?.timer);
    speaker.lifetime.abort();
    this.speakers.delete(clientId);
  }

  reset(): void {
    for (const clientId of this.speakers.keys()) this.removeSpeaker(clientId);
  }

  private finish(source: Speaker, speaker: SpeakerSession): void {
    const utterance = speaker.utterance!;
    clearTimeout(utterance.timer);
    speaker.utterance = undefined;
    const audio = Buffer.concat(utterance.frames, utterance.lastSpeechByte);
    if (audio.length < MIN_COMMAND_BYTES) return;

    const start = utterance.wakeAt ?? utterance.detectWake!(WAKE_TAIL);
    if (start === null) return;
    const command = audio.subarray(start);
    if (command.length < MIN_COMMAND_BYTES) {
      if (utterance.detectWake) {
        speaker.armedUntil = Date.now() + FOLLOW_UP_MS;
        this.onWakeOnly();
      }
      return;
    }
    this.onAudio(source, command, speaker.lifetime.signal);
  }
}

function containsSpeech(pcm: Buffer): boolean {
  let energy = 0;
  for (let offset = 0; offset < pcm.length; offset += 2) {
    const sample = pcm.readInt16LE(offset);
    energy += sample * sample;
  }
  return energy > 250 ** 2 * (pcm.length / 2);
}
