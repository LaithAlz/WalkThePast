/**
 * Local caching for hero worlds: a service worker serves /worlds/** cache-first,
 * and prefetchWorld() pulls every asset of a manifest into that cache so the
 * demo survives a reload with no network (and starts instantly).
 */
import type { WorldManifest } from "./world";

export const CACHE_NAME = "wtp-worlds-v1";

export async function registerWorker(): Promise<boolean> {
  if (!("serviceWorker" in navigator)) return false;
  try {
    await navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`);
    await navigator.storage?.persist?.();
    return true;
  } catch (e) {
    console.warn("service worker registration failed", e);
    return false;
  }
}

export function assetUrls(m: WorldManifest): string[] {
  const urls = [m.splat.url];
  if (m.source?.image) urls.push(m.source.image);
  if (m.pano?.url) urls.push(m.pano.url);
  return urls;
}

/** Returns total bytes stored. Progress callback gets (done, total, bytes). */
export async function prefetchWorld(m: WorldManifest, onProgress?: (done: number, total: number, bytes: number) => void): Promise<number> {
  if (!("caches" in window)) throw new Error("Cache API unavailable");
  const cache = await caches.open(CACHE_NAME);
  const urls = assetUrls(m);
  let bytes = 0;
  for (let i = 0; i < urls.length; i++) {
    const req = new Request(urls[i], { mode: "cors" });
    let res = await cache.match(req);
    if (!res) {
      res = await fetch(req);
      if (!res.ok) throw new Error(`${urls[i]} -> ${res.status}`);
      await cache.put(req, res.clone());
    }
    bytes += (await res.clone().blob()).size;
    onProgress?.(i + 1, urls.length, bytes);
  }
  return bytes;
}

export async function isWorldCached(m: WorldManifest): Promise<boolean> {
  if (!("caches" in window)) return false;
  const cache = await caches.open(CACHE_NAME);
  for (const u of assetUrls(m)) if (!(await cache.match(u))) return false;
  return true;
}
