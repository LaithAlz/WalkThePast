import { env } from "./env.ts";
/**
 * Where the guides live between visits.
 *
 * A GLB is a few megabytes of binary, which rules out localStorage, and it
 * belongs to this browser rather than to the account — nothing here is
 * uploaded anywhere. Metadata and model data are separate stores so the picker
 * can list a shelf of guides without pulling every model into memory to do it.
 *
 * Which guide is current, and whether you want one at all, are per-browser
 * preferences rather than data, so they sit in localStorage and degrade to
 * "the newest one" and "yes" when it is unavailable.
 */

const DB_NAME = "walk-the-past";
const DB_VERSION = 2;
/** Metadata: small, listed constantly. */
const GUIDES = "guides";
/** Model data: megabytes, read only when a guide is actually used. */
const MODELS = "models";
/** Version 1 kept a single guide, model and all, under one key. */
const LEGACY = "guide";
const LEGACY_KEY = "current";

const SELECTED_KEY = "wtp:guide:selected";
const ENABLED_KEY = "wtp:guide:enabled";

/** Everything the picker needs to draw a guide, without its model. */
export interface GuideSummary {
  id: string;
  /** The avatar service's own id, so a repeat export is recognisable. */
  avatarId: string;
  name: string;
  /** A JPEG data URL of the guide's face. */
  portrait?: string;
  createdAt: number;
}

export interface StoredGuide extends GuideSummary {
  glb: ArrayBuffer;
}

export function newGuideId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function read(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}

function write(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch { /* private mode: the fallbacks below cover it */ }
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (event) => {
      const db = request.result;
      const transaction = request.transaction!;
      if (!db.objectStoreNames.contains(GUIDES)) db.createObjectStore(GUIDES);
      if (!db.objectStoreNames.contains(MODELS)) db.createObjectStore(MODELS);
      // Carry the one guide version 1 could hold across, rather than making
      // someone who already made one make it again.
      if (event.oldVersion < 2 && db.objectStoreNames.contains(LEGACY)) {
        const legacy = transaction.objectStore(LEGACY);
        const existing = legacy.get(LEGACY_KEY);
        existing.onsuccess = () => {
          const old = existing.result as (Partial<StoredGuide> & { glb?: ArrayBuffer }) | undefined;
          if (!old?.glb) return;
          const id = newGuideId();
          transaction.objectStore(GUIDES).put({
            id, avatarId: old.avatarId ?? id, name: old.name ?? "Your guide",
            portrait: old.portrait, createdAt: old.createdAt ?? Date.now(),
          } satisfies GuideSummary, id);
          transaction.objectStore(MODELS).put(old.glb, id);
          write(SELECTED_KEY, id);
          legacy.delete(LEGACY_KEY);
        };
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB unavailable"));
    request.onblocked = () => reject(new Error("IndexedDB is blocked by another tab"));
  });
}

function run<T>(stores: string[], mode: IDBTransactionMode, work: (transaction: IDBTransaction) => IDBRequest<T>): Promise<T> {
  return open().then((db) => new Promise<T>((resolve, reject) => {
    const transaction = db.transaction(stores, mode);
    const request = work(transaction);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Guide storage failed"));
    transaction.oncomplete = () => db.close();
  }));
}

/**
 * Built-in guides ship with the site: public/characters/builtin/index.json lists them and each entry's
 * `file` is a rigged .glb in that folder. They appear for every visitor on every device, ahead of the
 * guides a browser made for itself, so a fresh browser walks with the team's guide by default.
 */
const BUILTIN_PREFIX = "builtin-";
type BuiltinSummary = GuideSummary & { file: string };
const builtinBase = () => `${(env.BASE_URL ?? "/").replace(/\/$/, "")}/characters/builtin`;
let builtinCache: Promise<BuiltinSummary[]> | null = null;
function listBuiltinGuides(): Promise<BuiltinSummary[]> {
  if (typeof fetch !== "function") return Promise.resolve([]);
  builtinCache ??= fetch(`${builtinBase()}/index.json`, { cache: "no-store" })
    .then((r) => (r.ok ? r.json() : []))
    .then((list: { id: string; name: string; file: string; portrait?: string }[]) => list.map((g) => ({ id: `${BUILTIN_PREFIX}${g.id}`, avatarId: g.id, name: g.name, portrait: g.portrait ? `${builtinBase()}/${g.portrait}` : undefined, createdAt: 0, file: g.file })))
    .then(async (list) => { for (const g of list) if (!g.portrait) g.portrait = await builtinPortrait(g); return list; })
    .catch(() => []);
  return builtinCache;
}

/** A built-in guide without a portrait image gets one rendered from its model, once per browser. */
async function builtinPortrait(g: BuiltinSummary): Promise<string | undefined> {
  if (typeof document === "undefined") return undefined;
  const key = `wtp.builtin.portrait.${g.avatarId}`;
  const cached = read(key);
  if (cached) return cached;
  try {
    const r = await fetch(`${builtinBase()}/${g.file}`);
    if (!r.ok) return undefined;
    const { renderPortrait } = await import("./avaturn.ts");
    const portrait = await renderPortrait(await r.arrayBuffer());
    write(key, portrait);
    return portrait;
  } catch {
    return undefined;
  }
}
const isBuiltin = (id: string) => id.startsWith(BUILTIN_PREFIX);

/** Every guide this browser can walk with: the built-in ones first, then its own, newest first. */
export async function listGuides(): Promise<GuideSummary[]> {
  const builtin = (await listBuiltinGuides()).map(({ file: _file, ...summary }) => summary);
  try {
    const all = await run<GuideSummary[]>([GUIDES], "readonly", (t) => t.objectStore(GUIDES).getAll());
    return [...builtin, ...all.sort((a, b) => b.createdAt - a.createdAt)];
  } catch {
    return builtin;
  }
}

export async function loadGuide(id: string): Promise<StoredGuide | null> {
  if (isBuiltin(id)) {
    const entry = (await listBuiltinGuides()).find((g) => g.id === id);
    if (!entry) return null;
    try {
      const r = await fetch(`${builtinBase()}/${entry.file}`);
      if (!r.ok) return null;
      const { file: _file, ...summary } = entry;
      return { ...summary, glb: await r.arrayBuffer() };
    } catch {
      return null;
    }
  }
  try {
    const summary = await run<GuideSummary | undefined>([GUIDES], "readonly", (t) => t.objectStore(GUIDES).get(id));
    if (!summary) return null;
    const glb = await run<ArrayBuffer | undefined>([MODELS], "readonly", (t) => t.objectStore(MODELS).get(id));
    return glb ? { ...summary, glb } : null;
  } catch {
    return null;
  }
}

/** Store a new guide and make it the current one. */
export async function saveGuide(guide: Omit<StoredGuide, "id" | "createdAt"> & Partial<Pick<StoredGuide, "id" | "createdAt">>): Promise<GuideSummary> {
  const summary: GuideSummary = {
    id: guide.id ?? newGuideId(),
    avatarId: guide.avatarId,
    name: guide.name,
    portrait: guide.portrait,
    createdAt: guide.createdAt ?? Date.now(),
  };
  await run([MODELS], "readwrite", (t) => t.objectStore(MODELS).put(guide.glb, summary.id));
  await run([GUIDES], "readwrite", (t) => t.objectStore(GUIDES).put(summary, summary.id));
  selectGuide(summary.id);
  return summary;
}

export async function deleteGuide(id: string): Promise<void> {
  if (isBuiltin(id)) return; // shipped with the site; not this browser's to delete
  try {
    await run([MODELS], "readwrite", (t) => t.objectStore(MODELS).delete(id));
    await run([GUIDES], "readwrite", (t) => t.objectStore(GUIDES).delete(id));
  } catch { /* already gone, or nowhere to delete from */ }
  if (selectedGuideId() === id) selectGuide(null);
}

export const selectedGuideId = () => read(SELECTED_KEY);
export const selectGuide = (id: string | null) => write(SELECTED_KEY, id);

/** Whether to walk with a guide at all. Defaults to yes. */
export const guideEnabled = () => read(ENABLED_KEY) !== "off";
export const setGuideEnabled = (on: boolean) => write(ENABLED_KEY, on ? "on" : "off");

/**
 * Which guide a world should use.
 *
 * Falling back to the newest rather than to nothing matters: a browser with no
 * localStorage, or one where the chosen guide has since been deleted, should
 * still walk you round with the guide you last made.
 */
export function chooseGuide<T extends { id: string }>(guides: T[], selected: string | null, enabled: boolean): T | null {
  if (!enabled || !guides.length) return null;
  return guides.find((guide) => guide.id === selected) ?? guides[0];
}

/** The guide this browser should be walking with, model and all. */
export async function loadSelectedGuide(): Promise<StoredGuide | null> {
  const chosen = chooseGuide(await listGuides(), selectedGuideId(), guideEnabled());
  return chosen ? loadGuide(chosen.id) : null;
}
