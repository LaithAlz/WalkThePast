export type HistoricalEntity = {
  id: string;
  label: string;
  aliases?: string[];
  kind: "place" | "site" | "person" | "period";
  articleUrl: string;
  summary: string;
  coordinates?: [longitude: number, latitude: number];
};


export type CaptionPart = { text: string; entity?: HistoricalEntity };

const CONNECTORS = new Set(["al", "bin", "da", "de", "del", "der", "di", "du", "la", "le", "of", "the", "van", "von"]);
const SENTENCE_WORDS = new Set([
  "a", "after", "again", "all", "also", "although", "am", "an", "and", "are", "as", "at", "be", "because", "before",
  "built", "but", "by", "can", "could", "did", "do", "does", "during", "each", "for", "from", "had", "has", "have",
  "he", "here", "how", "i", "if", "imagine", "in", "is", "it", "its", "like", "look", "many", "may", "might", "more",
  "most", "near", "no", "not", "now", "of", "on", "once", "or", "our", "she", "should", "so", "some", "than", "that",
  "the", "their", "them", "then", "there", "these", "they", "this", "those", "through", "to", "today", "travel", "up",
  "us", "was", "we", "welcome", "were", "what", "when", "where", "which", "while", "who", "why", "will", "with", "would",
  "yes", "you", "your",
]);
const PERIOD_WORDS = /\b(?:age|century|dynasty|empire|era|kingdom|period|republic)\b/iu;
const SITE_WORDS = /\b(?:abbey|acropolis|basilica|castle|cathedral|church|complex|fort|fortress|monument|mosque|museum|palace|plateau|pyramid|sphinx|temple|tomb|tower)\b/iu;
const PLACE_WORDS = /\b(?:avenue|bay|boulevard|city|country|desert|district|island|lake|mount|mountain|ocean|park|province|river|road|sea|square|state|street|valley)\b/iu;
const LOCATION_CUE = /\b(?:at|from|in|near|outside|through|to|within)\s+$/iu;
const PRONOUN_CONTRACTION = /^(?:he|how|i|it|she|that|there|they|we|what|when|where|who|why|you)['’](?:d|ll|m|re|s|t|ve)$/iu;

/** Reject tool mistakes and fallback guesses that are discourse, not names. */
export function isPlausibleEntityName(label: string): boolean {
  const clean = label.trim().replace(/\s+/gu, " ");
  if (!clean || clean.length > 96 || /[\r\n]/u.test(label) || PRONOUN_CONTRACTION.test(clean)) return false;
  const words = clean.match(/[\p{L}\p{N}][\p{L}\p{M}\p{N}'’.-]*/gu) ?? [];
  if (!words.length || words.length > 8) return false;
  const lower = words.map((word) => word.toLocaleLowerCase());
  if (words.length === 1 && (words[0].length < 2 || SENTENCE_WORDS.has(lower[0]) || CONNECTORS.has(lower[0]))) return false;
  if (SENTENCE_WORDS.has(lower[0]) || SENTENCE_WORDS.has(lower.at(-1)!)) return false;
  return lower.some((word) => !SENTENCE_WORDS.has(word) && !CONNECTORS.has(word));
}

function inferredKind(label: string, prefix: string): HistoricalEntity["kind"] {
  if (PERIOD_WORDS.test(label)) return "period";
  if (SITE_WORDS.test(label)) return "site";
  if (PLACE_WORDS.test(label) || LOCATION_CUE.test(prefix)) return "place";
  return "person";
}

/** Best-effort fallback for names the realtime model did not explicitly link. */
export function inferCaptionEntities(text: string, existing: HistoricalEntity[] = []): HistoricalEntity[] {
  const tokens = [...text.matchAll(/\S+/gu)].map((match) => {
    const raw = match[0];
    const leading = raw.match(/^[^\p{L}\p{N}]*/u)?.[0].length ?? 0;
    const value = raw.slice(leading).replace(/[.,;:!?]+$/gu, "").replace(/[^\p{L}\p{N}'’.-]+$/gu, "").replace(/['’]s$/iu, "");
    return { value, start: (match.index ?? 0) + leading, end: (match.index ?? 0) + leading + value.length };
  });
  const known = new Set(existing.flatMap((entity) => [entity.label, ...(entity.aliases ?? [])]).map((name) => name.toLocaleLowerCase()));
  const inferred: HistoricalEntity[] = [];
  const isName = (value: string) => /^\p{Lu}[\p{L}\p{M}'’.-]*$/u.test(value) || /^\p{Lu}{2,}$/u.test(value);
  const isNameAnchor = (value: string) => isName(value) && !SENTENCE_WORDS.has(value.toLocaleLowerCase())
    && !PRONOUN_CONTRACTION.test(value);
  for (let index = 0; index < tokens.length;) {
    if (!isNameAnchor(tokens[index].value)) { index += 1; continue; }
    const first = index;
    let last = index;
    while (last + 1 < tokens.length) {
      const directGap = text.slice(tokens[last].end, tokens[last + 1].start);
      if (/^\s+$/u.test(directGap) && isNameAnchor(tokens[last + 1].value)) { last += 1; continue; }
      const connectorGap = last + 2 < tokens.length ? text.slice(tokens[last + 1].end, tokens[last + 2].start) : "";
      if (/^\s+$/u.test(directGap) && /^\s+$/u.test(connectorGap)
        && CONNECTORS.has(tokens[last + 1].value.toLocaleLowerCase()) && last + 2 < tokens.length && isNameAnchor(tokens[last + 2].value)) {
        last += 2;
        continue;
      }
      break;
    }
    const label = text.slice(tokens[first].start, tokens[last].end);
    const lower = label.toLocaleLowerCase();
    const words = label.split(/\s+/u);
    const prefix = text.slice(0, tokens[first].start);
    const nearbyPrefix = prefix.slice(-24);
    const sentenceStart = !prefix.trim() || /[.!?;:]["'’”)]*\s*$/u.test(prefix);
    const strongSingle = LOCATION_CUE.test(nearbyPrefix) || PERIOD_WORDS.test(label) || SITE_WORDS.test(label)
      || PLACE_WORDS.test(label) || /^\p{Lu}{2,}$/u.test(label);
    const plausible = words.length > 1 || !sentenceStart || strongSingle;
    if (!known.has(lower) && plausible && isPlausibleEntityName(label)) {
      const kind = inferredKind(label, nearbyPrefix);
      const slug = lower.normalize("NFKD").replace(/\p{M}/gu, "").replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "");
      const entity: HistoricalEntity = {
        id: `inferred-${slug}`,
        label,
        kind,
        articleUrl: `https://en.wikipedia.org/wiki/Special:Search?search=${encodeURIComponent(label)}`,
        summary: `${label} is a named reference mentioned by the guide. These Wikipedia search results provide a starting point for verification and further context.`,
      };
      inferred.push(entity);
      known.add(lower);
    }
    index = last + 1;
  }
  return inferred;
}

/** Longest-match enrichment: explicit/reviewed entities first, then conservative inferred names. */
export function enrichCaption(text: string, additions: HistoricalEntity[] = []): CaptionPart[] {
  if (!text) return [];
  // Every linked entity comes from the historian's own tool calls; nothing is pre-written.
  const catalogue = [...additions, ...inferCaptionEntities(text, additions)];
  const names = catalogue.flatMap((entity) => [entity.label, ...(entity.aliases ?? [])].map((name) => ({ name, entity })))
    .filter(({ name }) => isPlausibleEntityName(name))
    .sort((a, b) => b.name.length - a.name.length);
  if (!names.length) return [{ text }];
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}])(${names.map(({ name }) => escapeRegExp(name)).join("|")})(?![\\p{L}\\p{N}])`, "giu");
  const lookup = new Map(names.map(({ name, entity }) => [name.toLocaleLowerCase(), entity]));
  return text.split(pattern).filter(Boolean).map((part) => ({ text: part, entity: lookup.get(part.toLocaleLowerCase()) }));
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
