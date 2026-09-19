const MAX_CLIP_CHARACTERS = 1000;
const MAX_CLIP_WORDS = 200;
const ABBREVIATION = /(?:\b(?:mr|mrs|ms|dr|prof|st|sr|jr|vs|etc|ca)|\bc|\b[a-z]|\b(?:[a-z]\.)+[a-z])\.$/i;

/** Keep partial sentences until their boundary arrives; never split a streamed word. */
export function splitNarrationText(text: string, final = false): { clips: string[]; remainder: string } {
  const clips: string[] = [];
  let remainder = text;
  for (;;) {
    let boundary = 0;
    for (const match of remainder.matchAll(/[.!?][\u201d\u2019"')\]]*(?=\s)/gu)) {
      const end = match.index + match[0].length;
      if (match[0] === "." && ABBREVIATION.test(remainder.slice(0, end))) continue;
      boundary = end;
      break;
    }
    const extraWord = [...remainder.matchAll(/\S+/gu)][MAX_CLIP_WORDS];
    if (extraWord && (!boundary || extraWord.index < boundary)) boundary = extraWord.index;
    // Long answers without punctuation are still bounded. Split at a word boundary.
    if ((!boundary || boundary > MAX_CLIP_CHARACTERS) && remainder.length > MAX_CLIP_CHARACTERS) {
      const prefix = remainder.slice(0, MAX_CLIP_CHARACTERS + 1);
      boundary = Math.max(prefix.lastIndexOf(" "), prefix.lastIndexOf("\n"));
      if (boundary <= 0) throw new Error("The historian returned a word too long to narrate.");
    }
    if (!boundary) break;
    const clip = remainder.slice(0, boundary).trim();
    if (clip) clips.push(clip);
    remainder = remainder.slice(boundary).trimStart();
  }
  if (final && remainder.trim()) {
    clips.push(remainder.trim());
    remainder = "";
  }
  return { clips, remainder };
}
