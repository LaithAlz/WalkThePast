export type HistoricalEntity = {
  id: string;
  label: string;
  aliases?: string[];
  kind: "place" | "site" | "person" | "period";
  articleUrl: string;
  summary: string;
  coordinates?: [longitude: number, latitude: number];
};

export const HISTORICAL_ENTITIES: HistoricalEntity[] = [
  { id: "giza-plateau", label: "Giza Plateau", aliases: ["Giza"], kind: "site", articleUrl: "https://en.wikipedia.org/wiki/Giza_pyramid_complex", summary: "The plateau on Cairo's western edge holds the pyramid complexes of Khufu, Khafre, and Menkaure, the Great Sphinx, temples, causeways, and cemeteries.", coordinates: [31.1325, 29.9773] },
  { id: "great-sphinx", label: "Great Sphinx", aliases: ["Sphinx"], kind: "site", articleUrl: "https://en.wikipedia.org/wiki/Great_Sphinx_of_Giza", summary: "A monumental limestone statue on the Giza Plateau, generally dated to Egypt's Fourth Dynasty.", coordinates: [31.1376, 29.9753] },
  { id: "khufu", label: "Khufu", kind: "person", articleUrl: "https://en.wikipedia.org/wiki/Khufu", summary: "A Fourth Dynasty pharaoh for whom the Great Pyramid of Giza was built." },
  { id: "khafre", label: "Khafre", kind: "person", articleUrl: "https://en.wikipedia.org/wiki/Khafre", summary: "A Fourth Dynasty pharaoh associated with Giza's second-largest pyramid complex." },
  { id: "menkaure", label: "Menkaure", kind: "person", articleUrl: "https://en.wikipedia.org/wiki/Menkaure", summary: "A Fourth Dynasty pharaoh associated with the smallest of Giza's three principal pyramids." },
  { id: "old-kingdom", label: "Old Kingdom", kind: "period", articleUrl: "https://en.wikipedia.org/wiki/Old_Kingdom_of_Egypt", summary: "A major period of ancient Egyptian history, conventionally dated to roughly 2686–2181 BCE." },
  { id: "egypt", label: "Egypt", kind: "place", articleUrl: "https://en.wikipedia.org/wiki/Egypt", summary: "A country linking northeast Africa and southwest Asia, shaped by the Nile valley and delta.", coordinates: [30.8025, 26.8206] },
  { id: "cairo", label: "Cairo", kind: "place", articleUrl: "https://en.wikipedia.org/wiki/Cairo", summary: "Egypt's capital and largest city, immediately east of the Giza pyramid complex.", coordinates: [31.2357, 30.0444] },
  { id: "paris", label: "Paris", kind: "place", articleUrl: "https://en.wikipedia.org/wiki/Paris", summary: "France's capital, built along the Seine and transformed extensively during the nineteenth century.", coordinates: [2.3522, 48.8566] },
  { id: "rue-cardinale", label: "Rue Cardinale", kind: "place", articleUrl: "https://fr.wikipedia.org/wiki/Rue_du_Cardinal-Lemoine", summary: "A historic Paris street represented in this world through an early twentieth-century source photograph.", coordinates: [2.3528, 48.8475] },
  { id: "eugene-atget", label: "Eugène Atget", aliases: ["Atget"], kind: "person", articleUrl: "https://en.wikipedia.org/wiki/Eug%C3%A8ne_Atget", summary: "A French photographer remembered for his systematic documentation of Paris and its surroundings." },
  { id: "mulberry-street", label: "Mulberry Street", kind: "place", articleUrl: "https://en.wikipedia.org/wiki/Mulberry_Street_(Manhattan)", summary: "A street in Lower Manhattan closely associated with the history of Little Italy and the Lower East Side.", coordinates: [-73.9974, 40.7178] },
];

export type CaptionPart = { text: string; entity?: HistoricalEntity };

/** Longest-match caption enrichment. The catalogue is reviewed; unknown proper nouns stay plain text. */
export function enrichCaption(text: string, additions: HistoricalEntity[] = []): CaptionPart[] {
  if (!text) return [];
  const catalogue = [...additions, ...HISTORICAL_ENTITIES.filter((known) => !additions.some((item) => item.label.toLocaleLowerCase() === known.label.toLocaleLowerCase()))];
  const names = catalogue.flatMap((entity) => [entity.label, ...(entity.aliases ?? [])].map((name) => ({ name, entity })))
    .sort((a, b) => b.name.length - a.name.length);
  const pattern = new RegExp(`(${names.map(({ name }) => escapeRegExp(name)).join("|")})`, "giu");
  const lookup = new Map(names.map(({ name, entity }) => [name.toLocaleLowerCase(), entity]));
  return text.split(pattern).filter(Boolean).map((part) => ({ text: part, entity: lookup.get(part.toLocaleLowerCase()) }));
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
