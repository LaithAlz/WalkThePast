import { useCallback, useEffect, useRef, useState } from "react";
import { SignInButton, SignUpButton, UserButton, useAuth } from "@clerk/react";
import { WorldCanvas } from "./components/WorldCanvas";
import type { Mode } from "./viewer/transition";
import { VoiceHistorian } from "./components/VoiceHistorian";
import { KnowledgePortal } from "./components/KnowledgePortal";
import { enrichCaption, type HistoricalEntity } from "./historian/entities";
import type { EvidenceCounts, Verdict } from "./viewer/Viewer";
import { deleteWorld, dismissJob, generateWorld, getCredits, imagineImage, listJobs, listWorlds, MODEL_CREDITS, writeGuide, type Job, type MarbleModel, type WorldImage } from "./lib/api";
import { api, worlds as worldAsset, setSessionTokenReader } from "./lib/backend";
import { prepPhoto, type PreppedImage } from "./lib/prep";

type Screen = "landing" | "upload" | "library" | "samples" | "explore";
type SourceKind = "image" | "video" | "text";
type UploadSource = { name: string; kind: SourceKind; file?: File };
type Generation = { jobId: string; name: string; sources: UploadSource[] };
/** `worldId` resolves to public/worlds/<id>/world.json. Without one the card is still a mock. */
type SampleWorld = { title: string; place: string; date: string; evidence: string; image: string; note: string; quote: string; worldId?: string; voicePreview?: boolean; /** progress % while a generation is still running */ building?: number; failed?: boolean };

// Each screen is a URL, so refresh, back and links work: / create, /worlds, /pick, /walk/<world id or sample-N>.
const PATHS: Record<Exclude<Screen, "explore">, string> = { landing: "/", upload: "/create", library: "/worlds", samples: "/pick" };
function screenFromLocation(): Screen {
  const path = location.pathname.replace(/\/+$/, "") || "/";
  if (path.startsWith("/walk/")) return "explore";
  return ((Object.keys(PATHS) as Exclude<Screen, "explore">[]).find((k) => PATHS[k] === path)) ?? "landing";
}
const walkIdFromLocation = () => decodeURIComponent(location.pathname.split("/walk/")[1] ?? "");

/** Generations running on the server, polled while any is still going; `onReady` fires when one finishes. */
function useJobs(onReady?: () => void): Job[] {
  const [jobs, setJobs] = useState<Job[]>([]);
  useEffect(() => {
    let stop = false;
    let readyIds: Set<string> | null = null;
    const tick = async () => {
      const list = await listJobs();
      if (stop) return;
      setJobs(list);
      const nowReady = new Set(list.filter((j) => j.status === "ready").map((j) => j.id));
      if (readyIds && [...nowReady].some((id) => !readyIds!.has(id))) onReady?.();
      readyIds = nowReady;
      if (list.some((j) => j.status !== "ready" && j.status !== "error")) setTimeout(tick, 3000);
    };
    void tick();
    return () => { stop = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return jobs;
}
const buildingWorlds = (jobs: Job[]): SampleWorld[] => jobs.filter((j) => j.status !== "ready").map((j) => ({ title: j.name, place: j.status === "error" ? "FAILED" : "BUILDING", date: j.status === "error" ? "" : `${Math.floor(j.elapsedS / 60)}:${String(j.elapsedS % 60).padStart(2, "0")}`, evidence: j.status === "error" ? (j.error ?? "failed").slice(0, 70) : j.stage.toUpperCase(), image: j.hasImage ? api(`/api/worlds/jobs/${j.id}/image`) : images.mouffetard, note: j.status === "error" ? "This generation did not finish." : "Building in the background. You can leave this page.", quote: "", worldId: `job-${j.id}`, building: j.status === "error" ? undefined : j.progress, failed: j.status === "error" }));
const generatedWorld = (w: { id: string; name: string }): SampleWorld => ({ title: w.name, place: "GENERATED WORLD", date: "", evidence: "LIVE PROVENANCE", image: worldAsset(`/worlds/${w.id}/source.jpg`), note: "Built from a photograph through Marble and classified against it.", quote: "You’re standing where the photographer stood.", worldId: w.id });

const images = {
  atget: "/assets/atget-paris.jpg",
  mouffetard: "/assets/rue-mouffetard.jpg",
  mulberry: "/assets/mulberry-street.jpg",
  montmartre: "/assets/rue-montmartre.jpg",
  boulevard: "/assets/boulevard-madeleine.jpg",
  omnibus: "/assets/boulevard-madeleine.jpg",
};

const worlds = [
  { title: "Rue Mouffetard", detail: "PARIS · 1898 · 41% SOURCE-VISIBLE", image: images.mouffetard },
  { title: "Mulberry Street", detail: "NEW YORK · 1906 · 38% SOURCE-VISIBLE", image: images.mulberry },
  { title: "Nihonbashi Bridge", detail: "TOKYO · 1911 · 3 MIN LEFT", image: images.montmartre, building: true },
  { title: "Kongens Nytorv", detail: "COPENHAGEN · 1902 · 52% SOURCE-VISIBLE", image: images.boulevard },
  { title: "Corso Buenos Aires", detail: "MILAN · 1913 · 29% SOURCE-VISIBLE", image: images.omnibus },
];

// Emptied for a clean slate: worlds come from public/worlds/index.json as they
// are generated. Nothing is hardcoded, so the picker is blank until one lands.
const sampleWorlds: SampleWorld[] = [];

export default function App() {
  const [screen, setScreenState] = useState<Screen>(screenFromLocation);
  const setScreen = (next: Screen, walkId?: string) => {
    setScreenState(next);
    const path = next === "explore" ? `/walk/${encodeURIComponent(walkId ?? "")}` : PATHS[next];
    if (location.pathname !== path) history.pushState({}, "", path);
  };
  useEffect(() => {
    // A path that maps to no screen — /auth from before Clerk's modal, a stale link —
    // renders the landing page, so put that in the address bar rather than leaving a URL
    // that no longer goes anywhere.
    if (screenFromLocation() === "landing" && location.pathname !== PATHS.landing) {
      history.replaceState({}, "", PATHS.landing);
    }
    const onPop = () => setScreenState(screenFromLocation());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const [evidence, setEvidence] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [activeSample, setActiveSample] = useState<SampleWorld | null>(sampleWorlds[0] ?? null);
  const [exploreReturn, setExploreReturn] = useState<"library" | "samples">("samples");
  const { isSignedIn, getToken } = useAuth();

  // The API functions are plain functions, so hand them the hook's token reader once.
  useEffect(() => {
    setSessionTokenReader(() => getToken());
    return () => setSessionTokenReader(null);
  }, [getToken]);

  useEffect(() => {
    if (isSignedIn && screen === "landing") setScreen("library");
  }, [isSignedIn, screen]);

  useEffect(() => {
    const down = (event: KeyboardEvent) => {
      if (screen !== "explore") return;
      if (document.querySelector(".explore-page.is-suspended")) return;
      if (event.key.toLowerCase() === "e" && !event.repeat) setEvidence((value) => !value);
      if (event.code === "Space") { event.preventDefault(); setSpeaking(true); }
    };
    const up = (event: KeyboardEvent) => { if (event.code === "Space") setSpeaking(false); };
    window.addEventListener("keydown", down); window.addEventListener("keyup", up);
    return () => { window.removeEventListener("keydown", down); window.removeEventListener("keyup", up); };
  }, [screen]);

  const walkIdOf = (sample: SampleWorld) => sample.worldId ?? `sample-${sampleWorlds.indexOf(sample)}`;
  // With no built-in samples left, "walk one of ours" has nothing to open directly,
  // so it shows the picker instead of dead-ending.
  const explore = () => {
    const first = sampleWorlds[0];
    setExploreReturn("library");
    setEvidence(false);
    if (!first) { setScreen("samples"); return; }
    setActiveSample(first);
    setScreen("explore", walkIdOf(first));
  };
  const chooseSample = (sample: SampleWorld) => { setActiveSample(sample); setExploreReturn("samples"); setEvidence(false); setScreen("explore", walkIdOf(sample)); };
  // Generation runs in the background on the server: the library shows it building, with a percentage.
  const startGeneration = () => setScreen("library");
  const openGenerated = (worldId: string, name: string) => {
    setActiveSample({ title: name, place: "YOUR PHOTOGRAPH", date: "", evidence: "LIVE PROVENANCE", image: worldAsset(`/worlds/${worldId}/source.jpg`), note: "Generated from your photograph and classified against it.", quote: "You’re standing where the photographer stood.", worldId });
    setExploreReturn("library");
    setEvidence(false);
    setScreen("explore", worldId);
  };
  // Deep link: /walk/<id> on load (refresh or a shared link) resolves the world before showing it.
  useEffect(() => {
    if (screen !== "explore") return;
    const id = walkIdFromLocation();
    if (activeSample && id === walkIdOf(activeSample)) return;
    const sampleIndex = /^sample-(\d+)$/.exec(id);
    if (sampleIndex) { const sample = sampleWorlds[+sampleIndex[1]]; if (sample) { setActiveSample(sample); setExploreReturn("samples"); } else setScreen("landing"); return; }
    void listWorlds().then((list) => {
      const w = list.find((x) => x.id === id);
      if (w) openGenerated(w.id, w.name); else setScreen("landing");
    });
  }, [screen]); // eslint-disable-line react-hooks/exhaustive-deps

  if (screen === "upload") return <Upload onBack={() => setScreen("landing")} onGenerate={startGeneration} onExplore={explore} onLibrary={() => setScreen("library")} />;
  if (screen === "samples") return <SamplePicker onBack={() => setScreen("landing")} onChoose={chooseSample} />;
  if (screen === "library") return <Library onNew={() => setScreen("upload")} onExplore={explore} onOpen={openGenerated} />;
  if (screen === "explore" && activeSample) return <Explore world={activeSample} evidence={evidence} speaking={speaking} autoEnter={activeSample.voicePreview} voice={!!activeSample.worldId} onToggleEvidence={() => setEvidence((value) => !value)} onExit={() => setScreen(exploreReturn)} />;
  return <Landing signedIn={!!isSignedIn} onUpload={() => setScreen("upload")} onLibrary={() => setScreen("library")} onExplore={() => setScreen("samples")} />;
}

function Brand({ light = false, sceneName }: { light?: boolean; sceneName?: string }) {
  return <button className={`brand ${light ? "brand-light" : ""}`} onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}><span>Walk the Past{sceneName ? ` of ${sceneName}` : ""}</span></button>;
}

function Header({ onUpload, onLibrary, showMethod = false }: { onUpload?: () => void; onLibrary?: () => void; showMethod?: boolean }) {
  const { isSignedIn } = useAuth();
  const signedOut = !isSignedIn;
  return <header className="site-header"><Brand /><nav>{!signedOut && onUpload && <button onClick={onUpload}>New world</button>}{!signedOut && onLibrary && <button onClick={onLibrary}>Library</button>}{/* The section this scrolls to only exists on the landing page. */}{showMethod && <button onClick={() => document.getElementById("method")?.scrollIntoView({ behavior: "smooth" })}>Method</button>}{signedOut ? <><SignInButton mode="modal"><button className="auth-login" type="button">Log in</button></SignInButton><SignUpButton mode="modal"><button className="button compact" type="button">Sign up</button></SignUpButton></> : <UserButton />}</nav></header>;
}

function Landing({ signedIn, onUpload, onLibrary, onExplore }: { signedIn: boolean; onUpload: () => void; onLibrary: () => void; onExplore: () => void }) {
  return <main className="page landing-page"><Header onUpload={onUpload} onLibrary={onLibrary} showMethod /><section className="landing-hero"><div className="landing-copy"><p className="eyebrow blue">WALK A SAMPLE WORLD FREE · SIGN IN TO BUILD YOUR OWN</p><h1>Stand inside<br /><em>a moment.</em></h1><p className="lede">Start with a written memory, a photograph, a video, or any combination. We reconstruct the place around it and mark where the evidence ends and inference begins.</p><div className="actions">{signedIn ? <button className="button" onClick={onUpload}>Create a world</button> : <SignUpButton mode="modal"><button className="button" type="button">Create a world</button></SignUpButton>}<button className="button ghost" onClick={onExplore}>Walk a sample world</button></div></div><div className="hero-visual"><img src={images.atget} alt="Historical Paris street scene" /><div className="image-scrim" /><div className="evidence-chips"><Chip color="green" text="SOURCE-VISIBLE 41%" /><Chip color="amber" text="INFERRED 34%" /><Chip color="purple" text="UNSUPPORTED 25%" /></div></div><p className="caption">SAMPLE WORLD · RUE DE LA MONTAGNE-SAINTE-GENEVIÈVE · PARIS</p></section><section className="steps" id="method"><Step n="01" title="Add source material" copy="Write a prompt, add images or video, or combine them." /><Step n="02" title="We build it in five minutes" copy="A navigable world, grounded in the evidence you provide." /><Step n="03" title="Walk it, and ask out loud" copy="A voice historian tells you where the evidence ends." /></section></main>;
}

function Step({ n, title, copy }: { n: string; title: string; copy: string }) { return <article className="step"><p className="eyebrow">{n}</p><h2>{title}</h2><p>{copy}</p></article>; }
function Chip({ color, text }: { color: "green" | "amber" | "purple"; text: string }) { return <span className={`chip ${color}`}>{text}</span>; }

function Upload({ onBack, onGenerate, onExplore, onLibrary }: { onBack: () => void; onGenerate: (gen: Generation) => void; onExplore: () => void; onLibrary: () => void }) {
  const samples = [{ image: images.mouffetard, label: "PARIS · 1898" }, { image: images.mulberry, label: "NEW YORK · 1906" }, { image: images.montmartre, label: "PARIS · 1900" }];
  const [dragging, setDragging] = useState(false);
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<UploadSource[]>([]);
  const [model, setModel] = useState<MarbleModel>("marble-1.1");
  const [trim, setTrim] = useState(true);
  const [credits, setCredits] = useState<number | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [prepped, setPrepped] = useState<PreppedImage | null>(null);
  // The world guide: OpenAI's long description of the whole scene, including what lies outside the frame.
  // Flow 1: photograph (+ brief description) -> guide -> Marble. Flow 2: description -> guide -> painted photograph -> Marble.
  const [guide, setGuide] = useState("");
  const [imagined, setImagined] = useState<{ mime: string; dataBase64: string } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  useEffect(() => { void getCredits().then(setCredits); }, []);
  const preparePhoto = async (): Promise<PreppedImage | null> => {
    const first = attachments.find((a) => a.kind === "image" && a.file);
    if (!first?.file) return null;
    const p = prepped ?? (await prepPhoto(first.file, { trimBorder: trim }));
    setPrepped(p);
    return p;
  };
  const composeGuide = async (): Promise<string> => {
    setBusy("writing the world guide…");
    const p = await preparePhoto();
    const g = await writeGuide(p, text.trim() || undefined);
    setGuide(g);
    return g;
  };
  const paintPhotograph = async (g: string) => {
    setBusy("painting the photograph…");
    const im = await imagineImage(g);
    setImagined(im);
    return im;
  };
  const runStep = async (step: () => Promise<unknown>) => {
    setError("");
    try { await step(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(null); }
  };
  const sourceForFile = (file: File): UploadSource | undefined => {
    const kind: SourceKind | undefined = file.type.startsWith("image/") ? "image"
      : file.type.startsWith("video/") ? "video"
        : file.type.startsWith("text/") || /\.(md|txt)$/i.test(file.name) ? "text"
          : undefined;
    return kind ? { name: file.name, kind, file } : undefined;
  };
  const imageFiles = attachments.filter((a) => a.kind === "image" && a.file);
  // One click: the server writes the guide, paints the photograph if there is none, and runs Marble, all in the
  // background. The library shows the world building with a percentage; the user can leave this screen.
  const generate = async () => {
    if (!imageFiles.length && !text.trim()) { setError("Add a photograph, or describe the place."); return; }
    setError("");
    try {
      setBusy("starting…");
      const photo = await preparePhoto(); // the real photograph stays the only provenance source
      const images: WorldImage[] = photo ? [photo] : imagined ? [{ name: "imagined.png", mime: imagined.mime, dataBase64: imagined.dataBase64 }] : [];
      const name = text.trim() ? text.trim().split(/[.\n]/)[0].slice(0, 48) : imageFiles[0].name.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ");
      const jobId = await generateWorld({ name, description: text.trim() || undefined, text: guide.trim() || undefined, model, images, mode: "single" });
      onGenerate({ jobId, name, sources });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };
  const addFiles = (files: FileList | File[]) => setAttachments((current) => [...current, ...Array.from(files).map(sourceForFile).filter((source): source is UploadSource => Boolean(source))]);
  const removeAttachment = (index: number) => setAttachments((current) => current.filter((_, currentIndex) => currentIndex !== index));
  const beginDrag = (event: React.DragEvent<HTMLDivElement>) => { event.preventDefault(); setDragging(true); };
  const endDrag = (event: React.DragEvent<HTMLDivElement>) => { event.preventDefault(); if (event.currentTarget === event.target) setDragging(false); };
  const dropFiles = (event: React.DragEvent<HTMLDivElement>) => { event.preventDefault(); setDragging(false); addFiles(event.dataTransfer.files); };
  const sources = [...(text.trim() ? [{ name: text.trim().slice(0, 60), kind: "text" as const }] : []), ...attachments];
  return <main className="page upload-page"><Header onLibrary={onLibrary} /><section className="upload-layout"><div className="upload-copy"><button className="back-link" onClick={onBack}>← Back</button><h1>Build from<br /><em>what you know.</em></h1><div className="guest-note"><span>ACCOUNT REQUIRED</span><p>Combine a memory with photographs, video, or written records. Building a world runs a paid reconstruction, so sign in first — your worlds are then kept in your library.</p></div><SignUpButton mode="modal"><button className="button ghost" type="button">Create an account instead</button></SignUpButton></div><div className="upload-panel"><div className={`dropzone ${dragging ? "is-dragging" : ""}`} onDragEnter={beginDrag} onDragOver={beginDrag} onDragLeave={endDrag} onDrop={dropFiles}><span className="upload-mark">✦</span><strong>Build a world from evidence</strong><p className="source-intro">Add a prompt, reference files, or both. Every source helps shape the world.</p><label className="text-source"><span>WHAT SHOULD WE RECONSTRUCT?</span><textarea value={text} onChange={(event) => setText(event.target.value)} placeholder="Describe a place, moment, or scene you want to walk through…" /></label><div className="source-divider">ADD REFERENCE MATERIAL</div><input ref={fileInput} className="visually-hidden" type="file" multiple accept="image/jpeg,image/png,image/tiff,image/webp,video/mp4,video/webm,video/quicktime,text/plain,text/markdown,.txt,.md" onChange={(event) => { /* Copy the list before clearing the input: setAttachments defers its updater to render, and clearing the input empties the live FileList it would have read. */ const picked = Array.from(event.target.files ?? []); event.currentTarget.value = ""; addFiles(picked); }} /><button className="add-source" type="button" onClick={() => fileInput.current?.click()}>+ Add images, video, or text files</button>{attachments.length > 0 && <div className="source-list" aria-label="Attached source material">{attachments.map((source, index) => <span className="source-chip" key={`${source.name}-${index}`}><i>{source.kind}</i>{source.name}<button type="button" aria-label={`Remove ${source.name}`} onClick={() => removeAttachment(index)}>×</button></span>)}</div>}{(imageFiles.length > 0 || text.trim()) && <details className="guide-details"><summary>Preview the world guide<span>optional · written for you when you generate</span></summary><div className="views-step"><div className="views-head"><span className="eyebrow">WORLD GUIDE</span><button className="quiet-button" type="button" disabled={!!busy} onClick={() => void runStep(composeGuide)}>{guide ? "Rewrite" : "Write it now"}</button></div><p className="views-note">{imageFiles.length ? "What Marble builds beyond your photograph. It is sent as the prompt." : "No photograph: the guide describes the place from your note; a photograph is painted from it, then both go to Marble."}</p><p className="guide">{guide || "Nothing yet. Generate, or write it now."}</p>{!imageFiles.length && guide.trim() && <div className="views-head"><span className="eyebrow">PAINTED PHOTOGRAPH</span><button className="quiet-button" type="button" disabled={!!busy} onClick={() => void runStep(() => paintPhotograph(guide.trim()))}>{imagined ? "Repaint" : "Paint it now"}</button></div>}{imagined && <img className="imagined" src={`data:${imagined.mime};base64,${imagined.dataBase64}`} alt="" />}</div></details>}<div className="gen-options"><label><span>MODEL</span><select value={model} onChange={(e) => setModel(e.target.value as MarbleModel)}><option value="marble-1.0-draft">Draft · 230 credits · 1 min · rough</option><option value="marble-1.1">Marble 1.1 · 1 580 credits · 5 min</option><option value="marble-1.1-plus">Marble 1.1 Plus · up to 3 080 · larger outdoor world</option></select></label><label className="check"><input type="checkbox" checked={trim} onChange={(e) => setTrim(e.target.checked)} /> trim scan borders (recommended: a paper border becomes a picture frame)</label><span className="credits">{credits === null ? "credits: —" : `credits: ${credits.toLocaleString()} · this run: ${MODEL_CREDITS[model]}`}</span></div>{error && <p className="auth-error" role="alert">{error}</p>}<button className="button text-generate" type="button" disabled={!sources.length || !!busy} onClick={() => void generate()}>{busy ?? `Generate world${sources.length ? ` · ${sources.length} source${sources.length === 1 ? "" : "s"}` : ""}`}</button></div><p className="eyebrow archive-label">OR WALK ONE OF OURS</p><div className="sample-grid">{samples.map((sample) => <button className="sample-card" key={sample.label} onClick={onExplore}><img src={sample.image} alt="" /><span>{sample.label}</span></button>)}</div></div></section><Historian className="upload-historian" hue="green" /></main>;
}

function SamplePicker({ onBack, onChoose }: { onBack: () => void; onChoose: (sample: SampleWorld) => void }) {
  // Worlds generated through the in-app bridge land in public/worlds/index.json, newest first; generations still
  // running on the server show first of all, with their progress.
  const [generated, setGenerated] = useState<SampleWorld[]>([]);
  const load = () => listWorlds().then((list) => {
    const known = new Set(sampleWorlds.map((w) => w.worldId));
    setGenerated(list.filter((w) => !known.has(w.id) && !w.id.startsWith("marble-sample")).map(generatedWorld));
  }).catch(() => undefined);
  useEffect(() => { void load(); }, []);
  const jobs = useJobs(load);
  const all = [...buildingWorlds(jobs), ...generated, ...sampleWorlds];
  return <main className="page sample-page"><header className="site-header"><Brand /><button className="quiet-button" onClick={onBack}>← Back</button></header><section className="sample-picker"><div className="sample-picker-intro"><h1>Choose a world<br /><em>to step into.</em></h1></div><div className="sample-picker-grid">{all.map((sample) => <button className={`sample-picker-card ${sample.building !== undefined ? "building" : ""} ${sample.failed ? "failed" : ""}`} key={sample.worldId ?? sample.title} disabled={sample.building !== undefined || sample.failed} onClick={() => onChoose(sample)}><div className="sample-picker-image"><img src={sample.image} alt="" /><span>{sample.failed ? "FAILED" : sample.building !== undefined ? `BUILDING · ${sample.building}%` : "READY TO WALK"}</span>{sample.building !== undefined && <i style={{ width: `${sample.building}%` }} />}</div><div className="sample-picker-info"><p>{[sample.place, sample.date].filter(Boolean).join(" · ")}</p><h2>{sample.title}</h2><span>{sample.note}</span><b>{sample.evidence} {sample.building === undefined && !sample.failed && <i>→</i>}</b></div></button>)}</div></section></main>;
}

type LibraryWorld = { id: string; title: string; detail: string; image: string; building?: boolean; failed?: boolean; pct?: number; open?: () => void; /** absent for the sample cards, which are part of the app rather than anyone's library */ remove?: () => Promise<void> };

function Library({ onNew, onExplore, onOpen }: { onNew: () => void; onExplore: () => void; onOpen: (worldId: string, name: string) => void }) {
  const [generated, setGenerated] = useState<{ id: string; name: string }[]>([]);
  const load = () => listWorlds().then((list) => setGenerated(list.filter((w) => !w.id.startsWith("marble-sample")))).catch(() => undefined);
  useEffect(() => { void load(); }, []);
  const jobs = useJobs(load);
  const building: LibraryWorld[] = jobs.filter((j) => j.status !== "ready").map((j) => ({ id: `job-${j.id}`, title: j.name, detail: j.status === "error" ? (j.error ?? "failed").slice(0, 60) : `${j.stage.toUpperCase()} · ${Math.floor(j.elapsedS / 60)}:${String(j.elapsedS % 60).padStart(2, "0")}`, image: j.hasImage ? api(`/api/worlds/jobs/${j.id}/image`) : images.mouffetard, building: j.status !== "error", failed: j.status === "error", pct: j.progress, remove: j.status === "error" ? () => dismissJob(j.id) : undefined }));
  const ready: LibraryWorld[] = generated.map((w) => ({ id: w.id, title: w.name, detail: "GENERATED WORLD · WALKABLE", image: worldAsset(`/worlds/${w.id}/source.jpg`), open: () => onOpen(w.id, w.name), remove: () => deleteWorld(w.id) }));
  const demo: LibraryWorld[] = worlds.map((w) => ({ id: `demo-${w.title}`, title: w.title, detail: w.detail, image: w.image, open: onExplore }));
  const all = [...building, ...ready, ...demo];
  const stillBuilding = building.filter((w) => w.building).length;
  return <main className="page library-page"><Header onUpload={onNew} onLibrary={() => undefined} /><section className="library-intro"><div><h1>Your worlds</h1><p>{ready.length + demo.length} reconstructions{stillBuilding ? ` · ${stillBuilding} still building` : ""}</p></div><div className="actions"><button className="select">Recent</button><button className="button compact" onClick={onNew}>New world</button></div></section><section className="world-grid">{all.map((world) => <WorldCard key={world.id} world={world} onClick={world.open ?? (() => undefined)} onRemoved={load} />)}<button className="new-card" onClick={onNew}><span>+</span>Create a world</button></section></main>;
}

function WorldCard({ world, onClick, onRemoved }: { world: LibraryWorld; onClick: () => void; onRemoved: () => void }) {
  // Deleting is not reversible and the world cost credits to make, so the first press
  // only asks. Clicking anywhere else puts the question away.
  const [confirming, setConfirming] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!confirming) return;
    const cancel = () => setConfirming(false);
    window.addEventListener("click", cancel);
    return () => window.removeEventListener("click", cancel);
  }, [confirming]);
  const remove = async () => {
    if (!world.remove) return;
    setRemoving(true);
    setError("");
    try { await world.remove(); onRemoved(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "could not delete that"); setRemoving(false); setConfirming(false); }
  };
  return <div className="world-card-wrap">
    <button className={`world-card ${world.building ? "building" : ""} ${world.failed ? "failed" : ""}`} onClick={onClick} disabled={!!world.building}><div className="world-image"><img src={world.image} alt="" /><span className="status">{world.failed ? "FAILED" : world.building ? `BUILDING · ${world.pct ?? 0}%` : "READY"}</span>{world.building && <i style={{ width: `${world.pct ?? 0}%` }} />}</div><div className="world-info"><strong>{world.title}</strong><span>{error || world.detail}</span></div></button>
    {world.remove && (confirming
      ? <button className="world-delete confirming" type="button" disabled={removing} onClick={(event) => { event.stopPropagation(); void remove(); }}>{removing ? "Deleting…" : "Delete?"}</button>
      : <button className="world-delete" type="button" aria-label={`Delete ${world.title}`} title={`Delete ${world.title}`} onClick={(event) => { event.stopPropagation(); setConfirming(true); }}>×</button>)}
  </div>;
}


function Explore({ world, evidence, speaking, autoEnter = false, voice = false, onToggleEvidence, onExit }: { world: SampleWorld; evidence: boolean; speaking: boolean; autoEnter?: boolean; voice?: boolean; onToggleEvidence: () => void; onExit: () => void }) {
  const [counts, setCounts] = useState<EvidenceCounts | null>(null);
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const [entity, setEntity] = useState<HistoricalEntity | null>(null);
  const [entityTab, setEntityTab] = useState<"article" | "map">("article");
  const [snapshot, setSnapshot] = useState<string | null>(null);
  const [portalPhase, setPortalPhase] = useState<"entering" | "active" | "leaving">("entering");
  const [suspended, setSuspended] = useState(false);
  const [splatReady, setSplatReady] = useState(false);
  const [readyHistorianWorld, setReadyHistorianWorld] = useState<string | null>(null);
  const [hiddenLandingWorld, setHiddenLandingWorld] = useState<string | null>(null);
  const [infoOpen, setInfoOpen] = useState(false);
  // The pause menu holds the historian too, so it has to reach up here: the
  // voice lives beside the canvas, not inside it.
  const [worldPaused, setWorldPaused] = useState(false);
  // "photo" until the landing has been stepped through, so the in-world chrome
  // does not render on top of the photograph.
  const [mode, setMode] = useState<Mode>("photo");
  const live = !!world.worldId;
  // Percentages are real once the classifier has run; the mock cards keep their written copy.
  const share = (index: 0 | 1 | 2, fallback: string) => (counts ? `${counts[index].toFixed(1)}%` : fallback);
  // Class ids are ordered [unsupported, occluded, visible] — see provenance.ts.
  const hue: OrbHue = verdict ? (["purple", "amber", "green"] as const)[verdict.cls] : evidence ? "amber" : "green";
  const openEntity = (next: HistoricalEntity) => {
    setEntity(next);
    setEntityTab("article");
    setSnapshot(live ? null : world.image);
    setSuspended(true);
  };
  const showMap = () => {
    if (!entity?.coordinates) return;
    setPortalPhase("entering");
    setEntityTab("map");
  };
  const acceptSnapshot = useCallback((dataUrl: string) => {
    setSnapshot(dataUrl);
  }, []);
  const historianWorld = world.worldId ?? world.title;
  const prepareVoice = voice && autoEnter && live;
  const historianReady = !prepareVoice || readyHistorianWorld === historianWorld;
  const landingFadeResolveRef = useRef<(() => void) | null>(null);
  const beginHistorianPresentation = useCallback(() => {
    setReadyHistorianWorld(historianWorld);
    return new Promise<void>((resolve) => { landingFadeResolveRef.current = resolve; });
  }, [historianWorld]);
  const finishLandingFade = useCallback(() => {
    setHiddenLandingWorld(historianWorld);
    const resolve = landingFadeResolveRef.current;
    landingFadeResolveRef.current = null;
    if (resolve) window.requestAnimationFrame(resolve);
  }, [historianWorld]);
  useEffect(() => {
    if (entityTab === "map" && snapshot) requestAnimationFrame(() => requestAnimationFrame(() => setPortalPhase("active")));
  }, [entityTab, snapshot]);
  const closePortal = () => {
    setPortalPhase("leaving");
    window.setTimeout(() => { setSuspended(false); setEntityTab("article"); setEntity(null); setSnapshot(null); }, 680);
  };
  const closeEntity = () => {
    setSuspended(false);
    setEntity(null);
    setSnapshot(null);
  };
  const caption = evidence && verdict ? verdict.reason : evidence ? "You're looking at a wall the camera never saw. Its height comes from the building opposite." : world.quote;

  return <main className={`explore-page ${evidence ? "evidence-mode" : ""} ${suspended ? "is-suspended" : ""}`}>
    {live ? <WorldCanvas worldId={world.worldId!} evidence={evidence} autoEnter={autoEnter} entryReady={historianReady} waitingMessage="CONNECTING TO OPENAI…" onLandingHidden={finishLandingFade} onCounts={setCounts} onVerdict={setVerdict} onMode={setMode} onReady={setSplatReady} suspended={suspended} onSnapshot={acceptSnapshot} onExit={onExit} voice={voice} onPaused={setWorldPaused} /> : <img className="explore-photo" src={world.image} alt={`${world.title}, ${world.place}`} />}
    <div className="explore-vignette" />
    {evidence && !live && <div className="evidence-map" />}
    {evidence && !live && <div className="frustum"><span>ORIGINAL PLATE — {world.date} · 6.4 M BEHIND YOU</span><i /><b /></div>}
    <div className="crosshair" />
    <div className="explore-top">
      <Brand light sceneName={world.title} />
      {/* A flat photograph has no camera to steer, so a corner button is safe
          here. A live world does, and the trip to the corner costs you your
          bearings — there, press M for the pause menu instead. */}
      {!live && <div className="explore-info">
        <button className="explore-info-trigger" type="button" aria-label="World information and controls" aria-expanded={infoOpen} onClick={() => setInfoOpen((open) => !open)}>
          <span aria-hidden="true">i</span>
        </button>
        {infoOpen && <div className="explore-info-card">
          <p>World controls</p>
          <dl className="explore-shortcuts">
            <div><dt>Space</dt><dd>Hold to talk</dd></div>
            <div><dt>E</dt><dd>Evidence</dd></div>
          </dl>
          <button type="button" onClick={() => { onToggleEvidence(); setInfoOpen(false); }}>{evidence ? "Exit evidence" : "Evidence mode"}</button>
          <button type="button" onClick={onExit}>Leave world</button>
        </div>}
      </div>}
    </div>
    {evidence && <aside className="legend"><p>EVIDENCE · {world.title.toUpperCase()}</p><span><i className="green" />SOURCE-VISIBLE · {share(2, world.evidence.split(" ")[0])}</span><span><i className="amber" />OCCLUDED · INFERRED · {share(1, "34%")}</span><span><i className="purple" />UNSUPPORTED · {share(0, "25%")}</span></aside>}
    {(!live || (splatReady && (mode === "world" || prepareVoice))) && (
      <div className={`explore-caption ${voice ? "has-voice" : ""} ${mode !== "world" && hiddenLandingWorld !== historianWorld && live ? "is-preparing" : ""}`} aria-hidden={mode !== "world" && hiddenLandingWorld !== historianWorld && live}>
        {voice ? <VoiceHistorian world={world} evidence={evidence} counts={counts} verdict={verdict} hue={hue} onEntity={openEntity} onPresentationReady={prepareVoice ? beginHistorianPresentation : undefined} paused={!!entity || worldPaused} /> : <><Historian hue={hue} state={speaking ? "listening" : "idle"} /><blockquote>“<EntityCaption text={caption} onEntity={openEntity} />”</blockquote></>}
        <p>{[world.place, world.date].filter(Boolean).join(" · ")}</p>
      </div>
    )}
    {entity && entityTab === "article" && <EntityPanel entity={entity} onClose={closeEntity} onMap={showMap} />}
    {entity && entityTab === "map" && <KnowledgePortal entity={entity} snapshot={snapshot} phase={portalPhase} onBack={closePortal} />}
  </main>;
}

function EntityCaption({ text, onEntity }: { text: string; onEntity: (entity: HistoricalEntity) => void }) {
  return <>{enrichCaption(text).map((part, index) => part.entity ? <button className={`caption-entity is-${part.entity.kind}`} type="button" key={`${index}-${part.text}`} onClick={() => onEntity(part.entity!)}>{part.text}<span aria-hidden="true">{part.entity.coordinates ? "⌖" : "↗"}</span></button> : <span key={`${index}-${part.text}`}>{part.text}</span>)}</>;
}

function EntityPanel({ entity, onClose, onMap }: { entity: HistoricalEntity; onClose: () => void; onMap: () => void }) {
  return <><button className="entity-backdrop" type="button" onClick={onClose} aria-label="Close reference and resume world" /><aside className="entity-panel" aria-label={`Learn about ${entity.label}`}>
    <button className="entity-close" type="button" onClick={onClose} aria-label="Close">×</button>
    <p className="entity-kind">{entity.kind}</p><h2>{entity.label}</h2>
    <div className="entity-tabs"><button className="active" type="button">Article</button>{entity.coordinates && <button type="button" onClick={onMap}>Map <span>⌖</span></button>}</div>
    <p className="entity-summary">{entity.summary}</p>
    <a className="entity-source" href={entity.articleUrl} target="_blank" rel="noreferrer">Read the reference article <span>↗</span></a>
    <p className="entity-note">External reference · opens in a new tab</p>
  </aside></>;
}

/** Hue carries the evidence state under the crosshair; state carries what the historian is doing. */
type OrbHue = "green" | "amber" | "purple";
type OrbState = "idle" | "listening" | "thinking" | "speaking";

function Historian({ className = "", hue, state = "idle" }: { className?: string; hue: OrbHue; state?: OrbState }) { return <span className={`historian ${className} ${hue} is-${state}`} aria-hidden="true" />; }
