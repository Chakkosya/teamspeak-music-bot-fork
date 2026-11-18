import { accessSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pinyin } from "pinyin-pro";

export const VOICE_SAMPLE_RATE = 16_000;
export const VOICE_BYTES_PER_SECOND = VOICE_SAMPLE_RATE * 2;
export type WakeDetector = (pcm: Buffer) => number | null;

type KeywordStream = {
  acceptWaveform(wave: { sampleRate: number; samples: Float32Array }): void;
};

interface KeywordSpotter {
  createStream(): KeywordStream;
  isReady(stream: KeywordStream): boolean;
  decode(stream: KeywordStream): void;
  getResult(stream: KeywordStream): { keyword: string; start_time: number; timestamps: number[] };
}

export function encodeWakeWord(word: string, vocabulary: ReadonlySet<string>): string {
  const syllables = pinyin(word, { type: "all", initialPattern: "yw", toneSandhi: false });
  const tokens = syllables.flatMap(({ initial, pinyin: full }) => [initial, full.slice(initial.length)].filter(Boolean));
  if (syllables.length < 2 || syllables.some(({ isZh }) => !isZh) || tokens.some(token => !vocabulary.has(token))) {
    throw new Error("请输入唤醒模型支持的中文唤醒词（至少两个汉字）。");
  }
  const line = `${tokens.join(" ")} @${word}\n`;
  if (!word.includes("团子")) return line;
  const colloquial = [];
  for (const [index, syllable] of syllables.entries()) {
    const reduced = syllable.origin === "子" && syllables[index - 1]?.origin === "团";
    if (syllable.initial) colloquial.push(syllable.initial);
    if (reduced) colloquial.push("i");
    else colloquial.push(syllable.pinyin.slice(syllable.initial.length));
  }
  return line + `${colloquial.join(" ")} @${word}\n`;
}

export function loadWakeDetector(directory: string, wakeWord: string): () => WakeDetector {
  const modelFile = (component: string) =>
    join(directory, `${component}-epoch-12-avg-2-chunk-16-left-64.int8.onnx`);
  const transducer = { encoder: modelFile("encoder"), decoder: modelFile("decoder"), joiner: modelFile("joiner") };
  const tokens = join(directory, "tokens.txt");
  for (const file of Object.values(transducer)) accessSync(file);
  const vocabulary = new Set(readFileSync(tokens, "utf8").trim().split(/\r?\n/).map(line => line.split(" ")[0]));
  const keywordsBuf = encodeWakeWord(wakeWord, vocabulary);

  const sherpa = createRequire(import.meta.url)("sherpa-onnx-node") as {
    KeywordSpotter: new (config: object) => KeywordSpotter;
  };
  const spotter = new sherpa.KeywordSpotter({
    featConfig: { sampleRate: VOICE_SAMPLE_RATE, featureDim: 80 },
    modelConfig: { transducer, tokens, numThreads: 1, provider: "cpu" },
    keywordsBuf,
    keywordsBufSize: Buffer.byteLength(keywordsBuf),
  });

  return () => {
    const stream = spotter.createStream();
    return (pcm) => {
      const samples = new Float32Array(pcm.length / 2);
      for (let sample = 0; sample < samples.length; sample++) {
        samples[sample] = pcm.readInt16LE(sample * 2) / 32768;
      }
      stream.acceptWaveform({ sampleRate: VOICE_SAMPLE_RATE, samples });
      while (spotter.isReady(stream)) {
        spotter.decode(stream);
        const result = spotter.getResult(stream);
        if (result.keyword) {
          const end = result.start_time + result.timestamps[result.timestamps.length - 1] + 0.04;
          return Math.round(end * VOICE_SAMPLE_RATE) * 2;
        }
      }
      return null;
    };
  };
}
