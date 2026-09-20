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
 * The Clerk session token for API calls.
 *
 * Every /api route the Worker serves reaches a paid upstream, so it requires a signed-in
 * caller. getToken() comes from a React hook, but the api functions below are plain
 * functions, so App registers the getter once and they read it through here.
 */
let readToken: (() => Promise<string | null>) | null = null;

export function setSessionTokenReader(read: (() => Promise<string | null>) | null): void {
  readToken = read;
}

/** Authorization header for a signed-in caller, or nothing when signed out. */
export async function authHeaders(): Promise<Record<string, string>> {
  try {
    const token = await readToken?.();
    return token ? { authorization: `Bearer ${token}` } : {};
  } catch {
    return {};
  }
}

/**
 * A world's photograph is the one asset requested two different ways: a library card
 * shows it in a plain <img>, while the viewer and the voice historian need it with CORS.
 * Before the Worker answered every origin with "*", the plain request cached a reply
 * carrying no Access-Control-Allow-Origin — immutable, for a year — and the browser then
 * handed those same bytes to the requests that require the header.
 *
 * The server is right now, but a browser that cached the old reply keeps it until 2027
 * and cannot be told otherwise. The version below changes the URL, so those browsers ask
 * again instead. Bump it if a cached world asset ever has to be abandoned again.
 */
const SOURCE_IMAGE_VERSION = "2";

/** A world's source photograph, at a URL no browser has a pre-CORS copy of. */
export function sourceImage(path: string): string {
  return `${worlds(path)}?v=${SOURCE_IMAGE_VERSION}`;
}

/** The same version, for the viewer resolving a manifest's `source.image`. */
export const sourceImageVersion = SOURCE_IMAGE_VERSION;
