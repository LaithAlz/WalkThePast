import assert from "node:assert/strict";
import test from "node:test";
import { enrichCaption, inferCaptionEntities } from "../src/historian/entities.ts";

test("reviewed entities use longest matches and never match inside larger words", () => {
  const parts = enrichCaption("Giza Plateau is near Cairo; Gizans live nearby.");
  const linked = parts.filter((part) => part.entity);
  assert.deepEqual(linked.slice(0, 2).map((part) => [part.text, part.entity.id]), [
    ["Giza Plateau", "giza-plateau"],
    ["Cairo", "cairo"],
  ]);
  assert.notEqual(linked.find((part) => part.text === "Gizans")?.entity?.id, "giza-plateau");
});

test("unlinked proper names and places receive best-effort Wikipedia references", () => {
  const inferred = inferCaptionEntities("In Alexandria, Alexander the Great founded a city near Lake Mareotis.");
  assert.deepEqual(inferred.map(({ label, kind }) => [label, kind]), [
    ["Alexandria", "place"],
    ["Alexander the Great", "person"],
    ["Lake Mareotis", "place"],
  ]);
  assert.ok(inferred.every((entity) => entity.articleUrl.startsWith("https://en.wikipedia.org/wiki/Special:Search?search=")));
});

test("ordinary sentence-opening capitals remain plain text", () => {
  const parts = enrichCaption("Welcome to the plateau. These monuments are ancient.");
  assert.equal(parts.some((part) => part.entity), false);
});

test("pronoun contractions are never treated as named entities", () => {
  const inferred = inferCaptionEntities("I'll compare Memphis. I’ll explain why. We'll then visit Alexandria.");
  assert.deepEqual(inferred.map(({ label }) => label), ["Memphis", "Alexandria"]);
  const linkedText = enrichCaption("I'll discuss Cairo.").filter((part) => part.entity).map((part) => part.text);
  assert.deepEqual(linkedText, ["Cairo"]);
});

test("explicit model entities override inferred references", () => {
  const explicit = {
    id: "alexandria-reviewed", label: "Alexandria", kind: "place",
    articleUrl: "https://en.wikipedia.org/wiki/Alexandria", summary: "A Mediterranean city in Egypt.", coordinates: [29.9187, 31.2001],
  };
  const linked = enrichCaption("Travel to Alexandria.", [explicit]).find((part) => part.entity);
  assert.equal(linked?.entity, explicit);
});

test("ordinary words are rejected even when the model incorrectly supplies them as entities", () => {
  const mistaken = ["to", "you", "like"].map((label) => ({
    id: `bad-${label}`, label, kind: "person",
    articleUrl: `https://en.wikipedia.org/wiki/${label}`, summary: "Incorrect tool output.",
  }));
  const linked = enrichCaption("I would like to show you the temple.", mistaken).filter((part) => part.entity);
  assert.deepEqual(linked, []);
});

test("long names stop before adjacent discourse words instead of joining them", () => {
  const text = "Alexander the Great You can compare Temple of Karnak To other sites.";
  const inferred = inferCaptionEntities(text);
  assert.deepEqual(inferred.map(({ label }) => label), ["Alexander the Great", "Temple of Karnak"]);
  const linked = enrichCaption(text).filter((part) => part.entity).map((part) => part.text);
  assert.deepEqual(linked, ["Alexander the Great", "Temple of Karnak"]);
});

test("malformed long tool labels cannot absorb ordinary neighboring caption text", () => {
  const malformed = {
    id: "bad-joined", label: "Alexander the Great and you", kind: "person",
    articleUrl: "https://en.wikipedia.org/wiki/Alexander_the_Great", summary: "Incorrectly joined output.",
  };
  const linked = enrichCaption("Alexander the Great and you can continue.", [malformed])
    .filter((part) => part.entity).map((part) => part.text);
  assert.deepEqual(linked, ["Alexander the Great"]);
});
