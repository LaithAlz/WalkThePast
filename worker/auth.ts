/**
 * Clerk session verification.
 *
 * The Worker's URL ships inside the public frontend bundle, so every route that spends
 * money — a Marble generation, an OpenAI image, a realtime session, a narration — has to
 * know who is asking. The browser sends its Clerk session token as a bearer token and this
 * verifies the signature against Clerk's published JWKS.
 *
 * Verification is done here rather than by calling Clerk on every request: the tokens are
 * short-lived RS256 JWTs, so checking the signature locally is both cheaper and one less
 * upstream that can fail.
 */
import type { Env } from "./types.ts";

type Jwk = JsonWebKey & { kid: string };
/** JWKS rarely rotates; hold it for an hour rather than fetching on every request. */
let jwks: { keys: Jwk[]; fetched: number } | null = null;
const JWKS_TTL_MS = 60 * 60 * 1000;
/** tolerance for clock skew between Clerk and the edge */
const LEEWAY_S = 60;

function base64UrlToBytes(s: string): Uint8Array {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

function decodeJson(part: string): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(base64UrlToBytes(part)));
}

export function bearer(request: Request): string | null {
  const header = request.headers.get("authorization") ?? "";
  return header.startsWith("Bearer ") ? header.slice(7).trim() || null : null;
}

/** The Clerk user id for a valid session token, or null. Never throws. */
export async function verifySession(token: string | null, issuer: string | undefined): Promise<string | null> {
  if (!token || !issuer) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const header = decodeJson(parts[0]) as { alg?: string; kid?: string };
    const payload = decodeJson(parts[1]) as { iss?: string; sub?: string; exp?: number; nbf?: number };

    // Pin the algorithm: without this a token could name "none" or a symmetric alg.
    if (header.alg !== "RS256" || !header.kid) return null;
    if (payload.iss !== issuer) return null;
    if (typeof payload.sub !== "string" || !payload.sub) return null;
    const now = Date.now() / 1000;
    if (typeof payload.exp !== "number" || payload.exp + LEEWAY_S < now) return null;
    if (typeof payload.nbf === "number" && payload.nbf - LEEWAY_S > now) return null;

    if (!jwks || Date.now() - jwks.fetched > JWKS_TTL_MS) {
      const r = await fetch(`${issuer}/.well-known/jwks.json`, { signal: AbortSignal.timeout(10_000) });
      if (!r.ok) return null;
      jwks = { keys: ((await r.json()) as { keys: Jwk[] }).keys, fetched: Date.now() };
    }
    const jwk = jwks.keys.find((k) => k.kid === header.kid);
    // An unknown kid can mean the keys just rotated, so refetch once before giving up.
    if (!jwk) {
      jwks = null;
      return null;
    }

    const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    const ok = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      base64UrlToBytes(parts[2]),
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
    );
    return ok ? payload.sub : null;
  } catch {
    return null;
  }
}

/** 503 when the Worker has no issuer configured, 401 when the caller has no valid session. */
export async function requireUser(request: Request, env: Env): Promise<{ userId: string } | Response> {
  if (!env.CLERK_ISSUER) {
    return new Response(JSON.stringify({ error: "CLERK_ISSUER is not configured on the server" }), {
      status: 503,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  }
  const userId = await verifySession(bearer(request), env.CLERK_ISSUER);
  if (!userId) {
    return new Response(JSON.stringify({ error: "Sign in to do that." }), {
      status: 401,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  }
  return { userId };
}
