/**
 * Clerk session verification.
 *
 * Every paid route refuses a caller without a valid session, so these check both halves:
 * a genuinely signed token is accepted, and the forgeries that matter are not. The keypair
 * is generated here and served through a stubbed JWKS fetch, so no Clerk account is needed.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { generateKeyPairSync, createSign } from "node:crypto";
import { verifySession } from "../worker/auth.ts";

const ISSUER = "https://example.clerk.accounts.dev";
const KID = "test-key-1";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: KID, alg: "RS256", use: "sig", kty: "RSA" };

const b64url = (buf) => Buffer.from(buf).toString("base64url");

function makeToken({ iss = ISSUER, sub = "user_123", alg = "RS256", kid = KID, expIn = 600, nbfOffset = -10, sign = true } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg, kid, typ: "JWT" }));
  const payload = b64url(JSON.stringify({ iss, sub, exp: now + expIn, nbf: now + nbfOffset, iat: now }));
  const body = `${header}.${payload}`;
  if (!sign) return `${body}.${b64url("not-a-signature")}`;
  const signer = createSign("RSA-SHA256");
  signer.update(body);
  return `${body}.${signer.sign(privateKey).toString("base64url")}`;
}

/** Serve the generated key as Clerk's JWKS, and count fetches so caching is observable. */
let jwksFetches = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  if (String(url).startsWith(ISSUER)) {
    jwksFetches++;
    return Response.json({ keys: [jwk] });
  }
  return realFetch(url);
};

test("a validly signed session token is accepted", async () => {
  assert.equal(await verifySession(makeToken(), ISSUER), "user_123");
});

test("the JWKS is cached rather than refetched per request", async () => {
  const before = jwksFetches;
  await verifySession(makeToken(), ISSUER);
  await verifySession(makeToken({ sub: "user_456" }), ISSUER);
  assert.equal(jwksFetches, before, "expected no further JWKS fetches");
});

test("a token signed by nobody is rejected", async () => {
  assert.equal(await verifySession(makeToken({ sign: false }), ISSUER), null);
});

test("alg:none is rejected rather than trusted", async () => {
  assert.equal(await verifySession(makeToken({ alg: "none", sign: false }), ISSUER), null);
});

test("a token from another issuer is rejected", async () => {
  assert.equal(await verifySession(makeToken({ iss: "https://attacker.example" }), ISSUER), null);
});

test("an expired token is rejected", async () => {
  assert.equal(await verifySession(makeToken({ expIn: -3600 }), ISSUER), null);
});

test("a token not yet valid is rejected", async () => {
  assert.equal(await verifySession(makeToken({ nbfOffset: 3600 }), ISSUER), null);
});

test("a tampered payload is rejected even with a real signature", async () => {
  const [header, , signature] = makeToken().split(".");
  const forged = b64url(JSON.stringify({ iss: ISSUER, sub: "user_admin", exp: Math.floor(Date.now() / 1000) + 600 }));
  assert.equal(await verifySession(`${header}.${forged}.${signature}`, ISSUER), null);
});

test("no token, and no configured issuer, both refuse", async () => {
  assert.equal(await verifySession(null, ISSUER), null);
  assert.equal(await verifySession(makeToken(), undefined), null);
});
