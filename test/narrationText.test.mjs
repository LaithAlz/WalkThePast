import assert from "node:assert/strict";
import { test } from "node:test";
import { splitNarrationText } from "../src/voice/narrationText.ts";

test("streamed text retains partial words and the final sentence", () => {
  const first = splitNarrationText("Welcome to Gi");
  assert.deepEqual(first, { clips: [], remainder: "Welcome to Gi" });
  const second = splitNarrationText(first.remainder + "za. These pyra");
  assert.deepEqual(second, { clips: ["Welcome to Giza."], remainder: "These pyra" });
  assert.deepEqual(splitNarrationText(second.remainder + "mids are ancient.", true), {
    clips: ["These pyramids are ancient."], remainder: "",
  });
});

test("abbreviations, initials and decimals stay in the same clip", () => {
  assert.deepEqual(splitNarrationText("Dr. A. Smith dates it to c. 2500 BCE, around 4.5 millennia ago. Next", false), {
    clips: ["Dr. A. Smith dates it to c. 2500 BCE, around 4.5 millennia ago."], remainder: "Next",
  });
});

test("long answers are bounded without dropping or duplicating words", () => {
  const text = Array.from({ length: 700 }, (_, index) => `word${index}`).join(" ");
  const result = splitNarrationText(text, true);
  assert.ok(result.clips.every((clip) => clip.length <= 1000));
  assert.equal(result.clips.join(" "), text);
});

test("many short words stay within the player's word limit", () => {
  const text = Array.from({ length: 500 }, () => "a").join(" ");
  const result = splitNarrationText(text, true);
  assert.ok(result.clips.every((clip) => clip.split(" ").length <= 200));
  assert.equal(result.clips.join(" "), text);
});
