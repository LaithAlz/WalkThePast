/**
 * Where the backend lives.
 *
 * The frontend is served by Vercel as a static site; the API and the generated worlds
 * are served by the Cloudflare Worker (see wrangler.toml). `VITE_API_BASE` names that
 * Worker's origin at build time.
 *
 * Left unset — which is the case in `npm run dev` — it stays empty, so every path below
 * is relative and hits Vite's own dev middleware and `public/worlds/` exactly as before.
 * Nothing about local development changes.
 */
const configured = (import.meta.env.VITE_API_BASE ?? "").trim().replace(/\/+$/, "");

/** The Worker origin, or "" when the backend is same-origin (dev, or the Worker serving the site itself). */
export const API_BASE = configured;

/** An /api/... path on whichever backend is configured. */
export function api(path: string): string {
  return `${API_BASE}${path}`;
}

/**
 * The prefix world assets are served from. Falls back to Vite's BASE_URL so a same-origin
 * build keeps resolving `public/worlds/`; with a Worker configured, worlds come from R2.
 */
export const WORLDS_BASE = API_BASE || import.meta.env.BASE_URL.replace(/\/$/, "");

/** A /worlds/... path: the R2-backed world folder in production, public/worlds/ in dev. */
export function worlds(path: string): string {
  return `${WORLDS_BASE}${path}`;
}

/**
 * Read an error out of a failed response.
 *
 * Not every failure is JSON: a 404 from a static host is text/plain, a proxy timeout is
 * HTML. Parsing those as JSON throws a SyntaxError whose message ("The string did not
 * match the expected pattern." in Safari) hides the status code that would have explained
 * the failure. So fall back to the raw text, and finally to the status itself.
 */
export async function errorFrom(response: Response, fallback: string): Promise<string> {
  const text = await response.text().catch(() => "");
  try {
    const parsed = JSON.parse(text) as { error?: unknown };
    if (typeof parsed.error === "string" && parsed.error) return parsed.error;
  } catch {
    /* not JSON: use the body itself, trimmed to something readable */
  }
  const plain = text.trim().split("\n")[0].slice(0, 120);
  return plain ? `${fallback} (${response.status}): ${plain}` : `${fallback} (${response.status})`;
}

/** Parse a successful response, failing loudly if the body is not the JSON we expect. */
export async function jsonFrom<T>(response: Response, fallback: string): Promise<T> {
  const text = await response.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`${fallback}: the server did not return JSON (${response.status}). Is VITE_API_BASE pointing at the Worker?`);
  }
}
