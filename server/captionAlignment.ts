export type TimedWord = { word: string; start: number; end: number };

const normalize = (text: string) => text.normalize("NFKC").toLocaleLowerCase("en")
  .replace(/(?<=\d)\.(?=\d)/g, "decimal")
  .replace(/(?<=\d)[–—-](?=\d)/g, "to")
  .replace(/^[-−](?=\d)/, "minus")
  .replace(/[^\p{L}\p{N}]/gu, "");

const smallNumbers: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40,
  fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};

function numericValue(text: string): number | null {
  const literal = text.replace(/,/g, "").trim();
  if (/^-?\d+(?:\.\d+)?[.,!?;:]?$/.test(literal)) return Number(literal.replace(/[.,!?;:]$/, ""));
  const parts = text.toLowerCase().replace(/[-–]/g, " ").replace(/[.,!?;:]/g, "").split(/\s+/).filter(Boolean);
  if (!parts.length) return null;
  const underHundred = (words: string[]): number | null => {
    if (words.length === 1 && words[0] in smallNumbers) return smallNumbers[words[0]];
    if (words.length === 2) {
      const tens = smallNumbers[words[0]];
      const units = smallNumbers[words[1]];
      if (tens >= 20 && tens % 10 === 0 && units > 0 && units < 10) return tens + units;
    }
    return null;
  };
  const groupValue = (words: string[]): number | null => {
    const hundred = words.indexOf("hundred");
    if (hundred === -1) return underHundred(words);
    const factor = underHundred(words.slice(0, hundred));
    if (factor === null || factor === 0) return null;
    const remainder = words.slice(hundred + 1);
    if (!remainder.length) return factor * 100;
    if (remainder[0] === "and") remainder.shift();
    const units = underHundred(remainder);
    return units === null ? null : factor * 100 + units;
  };
  let total = 0;
  let start = 0;
  let lastScale = Infinity;
  for (let index = 0; index < parts.length; index += 1) {
    const scale = ({ thousand: 1_000, million: 1_000_000, billion: 1_000_000_000 } as Record<string, number>)[parts[index]];
    if (!scale) continue;
    const factor = groupValue(parts.slice(start, index));
    if (factor === null || factor === 0 || scale >= lastScale) return null;
    total += factor * scale;
    lastScale = scale;
    start = index + 1;
  }
  if (start === parts.length) return total;
  const remainder = parts.slice(start);
  if (total && remainder[0] === "and") remainder.shift();
  const units = groupValue(remainder);
  return units === null ? null : total + units;
}

/**
 * Preserve the generated text, using only boundaries observed in the audio.
 * Whisper timestamps are ASR estimates, not mathematically exact forced alignment.
 * Shared ASR tokens share their time span; we never invent intra-word timing.
 */
export function alignCaptionWords(text: string, transcription: unknown, duration: number): TimedWord[] {
  if (!Array.isArray(transcription) || !transcription.length) throw new Error("Missing word timestamps");
  let previousStart = 0;
  const spoken: TimedWord[] = transcription.map((entry: unknown) => {
    if (!entry || typeof entry !== "object") throw new Error("Invalid word timestamps");
    const { word, start, end } = entry as Partial<TimedWord>;
    if (typeof word !== "string" || typeof start !== "number" || typeof end !== "number"
      || !Number.isFinite(start) || !Number.isFinite(end) || start < previousStart || start < 0
      || end < start || end > duration + 0.15) throw new Error("Invalid word timestamps");
    previousStart = start;
    return { word, start: Math.min(start, duration), end: Math.min(end, duration) };
  }).filter((entry) => normalize(entry.word));
  const original = text.match(/\S+/g) ?? [];
  const lexical = original.map((word, index) => ({ word, index, normalized: normalize(word) }))
    .filter((entry) => entry.normalized);
  if (!lexical.length || !spoken.length) throw new Error("Missing spoken words");

  type Match = { source: number; sourceCount: number; audio: number; audioCount: number; exact: boolean };
  const failed = new Set<string>();
  const match = (source: number, audio: number): Match[] | null => {
    if (source === lexical.length && audio === spoken.length) return [];
    if (source === lexical.length || audio === spoken.length) return null;
    const key = `${source}:${audio}`;
    if (failed.has(key)) return null;
    // Small blocks cover hyphenated words, abbreviations, and spoken numerals.
    for (let sourceCount = 1; sourceCount <= Math.min(8, lexical.length - source); sourceCount += 1) {
      const sourceBlock = lexical.slice(source, source + sourceCount);
      const sourceNormalized = sourceBlock.map((entry) => entry.normalized).join("");
      const sourceNumber = numericValue(sourceBlock.map((entry) => entry.word).join(" "));
      for (let audioCount = 1; audioCount <= Math.min(12, spoken.length - audio); audioCount += 1) {
        const audioBlock = spoken.slice(audio, audio + audioCount);
        const exact = sourceNormalized === audioBlock.map((entry) => normalize(entry.word)).join("");
        if (!exact && (sourceNumber === null || sourceNumber !== numericValue(audioBlock.map((entry) => entry.word).join(" ")))) continue;
        const rest = match(source + sourceCount, audio + audioCount);
        if (rest) return [{ source, sourceCount, audio, audioCount, exact }, ...rest];
      }
    }
    failed.add(key);
    return null;
  };
  const matches = match(0, 0);
  if (!matches) throw new Error("Spoken words could not be aligned to the narration");
  const aligned: Array<TimedWord | undefined> = original.map(() => undefined);
  for (const block of matches) {
    const audioBlock = spoken.slice(block.audio, block.audio + block.audioCount);
    let sourceOffset = 0;
    for (const entry of lexical.slice(block.source, block.source + block.sourceCount)) {
      let audioOffset = 0;
      const overlapping = audioBlock.filter((word) => {
        const start = audioOffset;
        audioOffset += normalize(word.word).length;
        return !block.exact || (audioOffset > sourceOffset && start < sourceOffset + entry.normalized.length);
      });
      aligned[entry.index] = { word: entry.word, start: overlapping[0].start, end: overlapping[overlapping.length - 1].end };
      sourceOffset += entry.normalized.length;
    }
  }
  // Standalone punctuation has no spoken duration. Keep it with an adjacent word.
  return aligned.map((entry, index) => {
    if (entry) return entry;
    const next = aligned.slice(index + 1).find(Boolean);
    const previous = aligned.slice(0, index).reverse().find(Boolean);
    const time = next?.start ?? previous?.end ?? 0;
    return { word: original[index], start: time, end: time };
  });
}
