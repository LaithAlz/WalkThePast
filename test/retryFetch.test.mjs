import assert from "node:assert/strict";
import test from "node:test";
import { fetchWithRetry } from "../server/retryFetch.ts";

test("transient network and OpenAI server failures are retried", async () => {
  const replies = [new TypeError("fetch failed"), new Response("busy", { status: 503 }), Response.json({ value: "ready" })];
  let calls = 0;
  const response = await fetchWithRetry(async () => {
    const reply = replies[calls++];
    if (reply instanceof Error) throw reply;
    return reply;
  }, "https://api.openai.com/test", { method: "POST" }, { baseDelayMs: 0 });
  assert.equal(calls, 3);
  assert.equal(response.status, 200);
});

test("permanent request failures are returned without retrying", async () => {
  let calls = 0;
  const response = await fetchWithRetry(async () => {
    calls += 1;
    return Response.json({ error: "invalid key" }, { status: 401 });
  }, "https://api.openai.com/test", {}, { baseDelayMs: 0 });
  assert.equal(calls, 1);
  assert.equal(response.status, 401);
});

test("an aborted caller stops retries", async () => {
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(fetchWithRetry(async () => {
    calls += 1;
    controller.abort(new Error("client left"));
    throw new TypeError("fetch failed");
  }, "https://api.openai.com/test", { signal: controller.signal }, { baseDelayMs: 0 }), /client left/);
  assert.equal(calls, 1);
});
