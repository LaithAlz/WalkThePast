/**
 * CORS for the split deployment: the frontend is served by Vercel, this Worker serves
 * the API and the worlds, so every call the browser makes is cross-origin.
 *
 * Origins are allowlisted from the ALLOWED_ORIGINS var (comma separated). An entry may
 * start with "*." to match any subdomain, which is what Vercel preview deployments need
 * — they get a fresh hostname per commit. Nothing here uses cookies, so credentials are
 * never allowed and echoing the matched origin is safe.
 */
import type { Env } from "./types.ts";

function allows(pattern: string, origin: string): boolean {
  if (pattern === origin) return true;
  if (!pattern.startsWith("*.")) return false;
  try {
    // "*.vercel.app" matches https://anything.vercel.app, but never https://vercel.app.evil.com
    const host = new URL(origin).hostname;
    return host.endsWith(pattern.slice(1)) && host.length > pattern.length - 1;
  } catch {
    return false;
  }
}

/** The matched origin, or null when the request has none or it is not allowed. */
export function allowedOrigin(request: Request, env: Env): string | null {
  const origin = request.headers.get("origin");
  if (!origin) return null;
  const patterns = (env.ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return patterns.some((p) => allows(p, origin)) ? origin : null;
}

/**
 * Add the CORS headers to a response that is about to go back to the browser.
 *
 * Vary is set even when this request carried no Origin. A library card loads a world's
 * photograph through a plain <img>, which sends no Origin and so gets no
 * Access-Control-Allow-Origin; that reply is cached immutable for a year. Without Vary the
 * browser then hands the same cached bytes to the viewer's crossOrigin image and to the
 * voice historian's fetch, both of which require the header — so they failed against a
 * world that had loaded perfectly a moment earlier.
 */
export function withCors(response: Response, origin: string | null): Response {
  const headers = new Headers(response.headers);
  headers.append("vary", "Origin");
  if (origin) headers.set("access-control-allow-origin", origin);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

/**
 * World assets are public, immutable and carry no credentials, so they answer every origin
 * with "*". One reply then works for a plain <img>, a crossOrigin image and a fetch alike,
 * which keeps a cached copy usable by all three.
 */
export function withPublicCors(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", "*");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

/** Preflight. Browsers send it for any request with a JSON content-type. */
export function preflight(request: Request, origin: string | null): Response {
  if (!origin) return new Response(null, { status: 403 });
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": origin,
      "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
      "access-control-allow-headers": request.headers.get("access-control-request-headers") ?? "content-type",
      "access-control-max-age": "86400",
      vary: "Origin, Access-Control-Request-Headers",
    },
  });
}
