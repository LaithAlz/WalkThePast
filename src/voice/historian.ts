import type { EvidenceCounts, Verdict } from "../viewer/Viewer";

export type HistorianSceneContext = {
  world: {
    id: string;
    title: string;
    place: string;
    date: string;
    description: string;
    sourceImage: string;
  };
  evidenceEnabled: boolean;
  evidenceCounts: EvidenceCounts | null;
  verdict: Verdict | null;
};

export const HISTORIAN_INSTRUCTIONS = `
You are the Walk the Past voice historian: concise, warm, curious, and rigorous.
Speak in one or two short sentences unless the visitor asks for more.

Before each spoken answer, identify every named person, place, site, and historical period you expect to mention and call linkHistoricalEntity once for each one not already linked in the conversation. Make a best effort even for incidental named references; parallel calls are encouraged. Supply a directly relevant Wikipedia article, a one-sentence neutral summary, and coordinates only when you know a sensible map location. Do not link ordinary nouns, repeat an entity already linked, or invent coordinates.

The scene is a navigable Gaussian-splat reconstruction generated from a single source image. The source for this Giza demo is a modern, stylized stock illustration, not an archaeological photograph or primary historical record. Never describe details in that illustration as proof of ancient conditions. Clearly separate what the source image visibly depicts, what the 3D reconstruction infers, and generally established historical context. Do not lead with these source limitations or technical reconstruction details; mention them only when the visitor asks about visual accuracy, evidence, provenance, or how the scene was made.

Before answering what the visitor sees, call getCurrentWorld and getCurrentEvidenceState. For historical questions call getHistoricalContext. For nearby-object questions call getNearbyPOI. If a tool says something is unavailable, say so instead of guessing. Treat SOURCE_VISIBLE as present in the source image, OCCLUDED_INFERRED as reconstructed behind visible surfaces, and UNSUPPORTED as not supported by the source image. Do not equate those geometric labels with historical certainty.

For the first response, speak as a historical guide and give a vivid two- or three-sentence introduction to the Giza Plateau. Lead with established history: the plateau's Old Kingdom pyramid complexes were built roughly 4,500 years ago and are associated with the pharaohs Khufu, Khafre, and Menkaure. Briefly explain that these monuments belonged to larger royal funerary landscapes, then invite the visitor to ask a question. Do not mention the illustration, reconstruction, Gaussian splats, source limitations, evidence labels, or uncertainty in this opening. Do not describe unverified image details as historical fact.

A good opening sounds like: "Welcome to the Giza Plateau, where the pyramid complexes of Khufu, Khafre, and Menkaure have stood for roughly 4,500 years. Built during Egypt's Old Kingdom, these monuments formed part of vast royal funerary landscapes that included temples, causeways, tombs, and the Great Sphinx. What would you like to explore first?"
`.trim();

export const HISTORIAN_TOOLS = [
  {
    type: "function",
    name: "linkHistoricalEntity",
    description: "Attach a reference article and optional map location to each named person, place, site, or historical period in the spoken caption. Call once for every new named entity.",
    parameters: {
      type: "object",
      properties: {
        label: { type: "string", description: "Exact entity name as it will be spoken." },
        kind: { type: "string", enum: ["place", "site", "person", "period"] },
        articleUrl: { type: "string", description: "Direct URL to a relevant Wikipedia article." },
        summary: { type: "string", description: "One concise, neutral sentence explaining the entity." },
        longitude: { type: "number", minimum: -180, maximum: 180 },
        latitude: { type: "number", minimum: -90, maximum: 90 },
      },
      required: ["label", "kind", "articleUrl", "summary"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "getCurrentWorld",
    description: "Get the identity, source type, and reconstruction metadata for the world being explored.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    type: "function",
    name: "getNearbyPOI",
    description: "Get reviewed points of interest near or in front of the visitor. Returns unavailable when POIs have not been spatially mapped.",
    parameters: {
      type: "object",
      properties: { limit: { type: "integer", minimum: 1, maximum: 5 } },
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "getCurrentEvidenceState",
    description: "Get the provenance classification beneath the center crosshair and the overall evidence distribution.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    type: "function",
    name: "getHistoricalContext",
    description: "Get reviewed historical context and source limitations for this world. Use this before making historical claims.",
    parameters: {
      type: "object",
      properties: { question: { type: "string", description: "The visitor's historical question." } },
      required: ["question"],
      additionalProperties: false,
    },
  },
] as const;

export function runHistorianTool(name: string, args: Record<string, unknown>, context: HistorianSceneContext): unknown {
  switch (name) {
    case "linkHistoricalEntity":
      return { status: "linked", label: args.label };
    case "getCurrentWorld":
      return {
        ...context.world,
        reconstruction: {
          format: "Gaussian splat",
          gaussianCount: 1_920_000,
          generator: "Marble 1.1",
          metricScaleVerified: false,
        },
        source: {
          type: "modern stylized stock illustration",
          isPrimaryHistoricalEvidence: false,
          warning: "Visual details are artistic and must not be presented as evidence of ancient appearance or daily life.",
        },
      };
    case "getNearbyPOI":
      return {
        status: "not_spatially_mapped",
        points: [],
        message: "Specific pyramids and structures have not yet been mapped to coordinates in this splat. Describe only the overall Giza plateau scene unless the visitor identifies an object.",
        requestedLimit: args.limit ?? 3,
      };
    case "getCurrentEvidenceState":
      return {
        evidenceMode: context.evidenceEnabled,
        crosshair: context.verdict
          ? { class: ["UNSUPPORTED", "OCCLUDED_INFERRED", "SOURCE_VISIBLE"][context.verdict.cls], reason: context.verdict.reason }
          : { class: "NOT_AVAILABLE", reason: "The crosshair does not currently hit a classified Gaussian." },
        distributionPercent: context.evidenceCounts
          ? { unsupported: context.evidenceCounts[0], occludedInferred: context.evidenceCounts[1], sourceVisible: context.evidenceCounts[2] }
          : null,
        limitation: "This measures agreement with the supplied illustration, not archaeological or historical certainty.",
      };
    case "getHistoricalContext":
      return {
        question: args.question,
        reviewedContext: [
          "The Giza pyramid complex is on the Giza Plateau near Cairo, Egypt.",
          "Its best-known monuments include the pyramids associated with Khufu, Khafre, and Menkaure, as well as the Great Sphinx and related temples and cemeteries.",
          "The major pyramid complexes date to Egypt's Old Kingdom, but this demo does not yet include claim-level citations or spatially mapped monuments.",
        ],
        sourceLimitations: [
          "The image supplied to the model is a modern artistic illustration.",
          "No reviewed per-POI bibliography has been attached yet.",
          "Keep dates and disputed interpretations general; acknowledge uncertainty and offer to revisit once citations are added.",
        ],
      };
    default:
      return { error: "unknown_tool", name };
  }
}

export function sceneMetadata(context: HistorianSceneContext): string {
  return JSON.stringify({
    world: context.world,
    source: {
      type: "modern stylized stock illustration",
      dimensions: [512, 512],
      reconstruction: "1,920,000 Gaussian splats",
      sourceCamera: "unconfirmed; defaults to splat origin",
      provenanceWarning: "Classification is against the illustration and is not historical verification.",
    },
  });
}
