import { useEffect, useRef, useState } from "react";
import { useAuth, useSignIn, useSignUp } from "@clerk/react";
import { WorldCanvas } from "./components/WorldCanvas";
import type { EvidenceCounts, Verdict } from "./viewer/Viewer";
import { generateWorld, getCredits, getJob, historicalPrompt, MODEL_CREDITS, type Job, type MarbleModel } from "./lib/api";
import { prepPhoto } from "./lib/prep";

type Screen = "landing" | "auth" | "upload" | "library" | "making" | "samples" | "explore";
type AuthMode = "login" | "signup";
type SourceKind = "image" | "video" | "text";
type UploadSource = { name: string; kind: SourceKind; file?: File };
type Generation = { jobId: string; name: string; sources: UploadSource[] };
/** `worldId` resolves to public/worlds/<id>/world.json. Without one the card is still a mock. */
type SampleWorld = { title: string; place: string; date: string; evidence: string; image: string; note: string; quote: string; worldId?: string };

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

const sampleWorlds: SampleWorld[] = [
  { title: "Rue Cardinale", place: "PARIS, FRANCE", date: "1922", evidence: "LIVE PROVENANCE", image: "/worlds/marble-paris-cropped/source.jpg", note: "Eugène Atget's plate, reconstructed from his camera position — 2M Gaussians classified against the photograph as you walk.", quote: "You’re standing where Atget stood.", worldId: "marble-paris-cropped" },
  { title: "Giza Plateau", place: "GIZA, EGYPT", date: "", evidence: "LIVE PROVENANCE", image: "/worlds/marble-giza/source.jpg", note: "A real reconstruction — 1.9M Gaussians, classified against the source image as you walk.", quote: "You’re standing where the source camera stood.", worldId: "marble-giza" },
  { title: "Rue de la Montagne", place: "PARIS, FRANCE", date: "1898", evidence: "41% SOURCE-VISIBLE", image: images.atget, note: "A quiet Paris street, reconstructed from Atget's camera position.", quote: "You’re standing where the original photographer stood." },
  { title: "Rue Mouffetard", place: "PARIS, FRANCE", date: "1898", evidence: "41% SOURCE-VISIBLE", image: images.mouffetard, note: "Market life and facades along one of Paris's oldest streets.", quote: "The market continues beyond the edge of the original plate." },
  { title: "Mulberry Street", place: "NEW YORK, USA", date: "1906", evidence: "38% SOURCE-VISIBLE", image: images.mulberry, note: "A dense Lower East Side street shaped by migration and trade.", quote: "The crowd is evidence; the street beyond it is carefully inferred." },
  { title: "Rue Montmartre", place: "PARIS, FRANCE", date: "1900", evidence: "44% SOURCE-VISIBLE", image: images.montmartre, note: "The boulevard at the turn of the century, seen at street level.", quote: "These buildings are anchored to what the camera captured." },
  { title: "Boulevard de la Madeleine", place: "PARIS, FRANCE", date: "1902", evidence: "52% SOURCE-VISIBLE", image: images.boulevard, note: "A broad avenue of carriages, storefronts, and early city movement.", quote: "This is our most evidence-rich sample world." },
];

export default function App() {
  const [screen, setScreen] = useState<Screen>("landing");
  const [authMode, setAuthMode] = useState<AuthMode>("login");
  const [evidence, setEvidence] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [generation, setGeneration] = useState<Generation | null>(null);
  const [activeSample, setActiveSample] = useState<SampleWorld>(sampleWorlds[0]);
  const [exploreReturn, setExploreReturn] = useState<"library" | "samples">("samples");
  const { isSignedIn } = useAuth();

  useEffect(() => {
    if (isSignedIn && screen === "landing") setScreen("library");
  }, [isSignedIn, screen]);

  useEffect(() => {
    const down = (event: KeyboardEvent) => {
      if (screen !== "explore") return;
      if (event.key.toLowerCase() === "e") setEvidence((value) => !value);
      if (event.code === "Space") { event.preventDefault(); setSpeaking(true); }
    };
    const up = (event: KeyboardEvent) => { if (event.code === "Space") setSpeaking(false); };
    window.addEventListener("keydown", down); window.addEventListener("keyup", up);
    return () => { window.removeEventListener("keydown", down); window.removeEventListener("keyup", up); };
  }, [screen]);

  const explore = () => { setActiveSample(sampleWorlds[0]); setExploreReturn("library"); setEvidence(false); setScreen("explore"); };
  const chooseSample = (sample: SampleWorld) => { setActiveSample(sample); setExploreReturn("samples"); setEvidence(false); setScreen("explore"); };
  const startGeneration = (gen: Generation) => { setGeneration(gen); setScreen("making"); };
  const openGenerated = (worldId: string, name: string) => {
    setActiveSample({ title: name, place: "YOUR PHOTOGRAPH", date: "", evidence: "LIVE PROVENANCE", image: `/worlds/${worldId}/source.jpg`, note: "Generated from your photograph and classified against it.", quote: "You’re standing where the photographer stood.", worldId });
    setExploreReturn("library");
    setEvidence(false);
    setScreen("explore");
  };

  const openAuth = (mode: AuthMode) => { setAuthMode(mode); setScreen("auth"); };

  if (screen === "auth") return <Auth mode={authMode} onBack={() => setScreen("landing")} onAuthenticated={() => setScreen("library")} onModeChange={setAuthMode} />;
  if (screen === "upload") return <Upload onBack={() => setScreen("landing")} onGenerate={startGeneration} onExplore={explore} onAuth={() => openAuth("signup")} onLogin={() => openAuth("login")} />;
  if (screen === "making") return <Making generation={generation} onLibrary={() => setScreen("library")} onReady={openGenerated} onRetry={() => setScreen("upload")} />;
  if (screen === "samples") return <SamplePicker onBack={() => setScreen("landing")} onChoose={chooseSample} />;
  if (screen === "library") return <Library onNew={() => setScreen("upload")} onExplore={explore} />;
  if (screen === "explore") return <Explore world={activeSample} evidence={evidence} speaking={speaking} onToggleEvidence={() => setEvidence((value) => !value)} onExit={() => setScreen(exploreReturn)} />;
  return <Landing onUpload={() => setScreen("upload")} onLogin={() => openAuth("login")} onSignUp={() => openAuth("signup")} onExplore={() => setScreen("samples")} />;
}

function Brand({ light = false }: { light?: boolean }) {
  return <button className={`brand ${light ? "brand-light" : ""}`} onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}><span className="brand-dot" /><span>WALK THE PAST</span></button>;
}

function Header({ onUpload, onLibrary, onLogin, signedOut = false }: { onUpload?: () => void; onLibrary?: () => void; onLogin?: () => void; signedOut?: boolean }) {
  return <header className="site-header"><Brand /><nav>{!signedOut && <button onClick={onUpload}>New world</button>}{!signedOut && <button onClick={onLibrary}>Library</button>}<button onClick={() => document.getElementById("method")?.scrollIntoView({ behavior: "smooth" })}>Method</button>{signedOut ? <><button className="auth-login" onClick={onLogin}>Log in</button><button className="button compact" onClick={onUpload}>Sign up</button></> : <button className="avatar" aria-label="Account" />}</nav></header>;
}

function Landing({ onUpload, onLogin, onSignUp, onExplore }: { onUpload: () => void; onLogin: () => void; onSignUp: () => void; onExplore: () => void }) {
  return <main className="page landing-page"><Header signedOut onLogin={onLogin} onUpload={onSignUp} /><section className="landing-hero"><div className="landing-copy"><p className="eyebrow blue">NO ACCOUNT NEEDED FOR YOUR FIRST WORLD</p><h1>Stand inside<br /><em>a moment.</em></h1><p className="lede">Start with a written memory, a photograph, a video, or any combination. We reconstruct the place around it and mark where the evidence ends and inference begins.</p><div className="actions"><button className="button" onClick={onUpload}>Create a world</button><button className="button ghost" onClick={onExplore}>Walk a sample world</button></div></div><div className="hero-visual"><img src={images.atget} alt="Historical Paris street scene" /><div className="image-scrim" /><div className="evidence-chips"><Chip color="green" text="SOURCE-VISIBLE 41%" /><Chip color="amber" text="INFERRED 34%" /><Chip color="purple" text="UNSUPPORTED 25%" /></div></div><p className="caption">SAMPLE WORLD · RUE DE LA MONTAGNE-SAINTE-GENEVIÈVE · PARIS</p></section><section className="steps" id="method"><Step n="01" title="Add source material" copy="Write a prompt, add images or video, or combine them." /><Step n="02" title="We build it in five minutes" copy="A navigable world, grounded in the evidence you provide." /><Step n="03" title="Walk it, and ask out loud" copy="A voice historian tells you where the evidence ends." /></section></main>;
}

function Step({ n, title, copy }: { n: string; title: string; copy: string }) { return <article className="step"><p className="eyebrow">{n}</p><h2>{title}</h2><p>{copy}</p></article>; }
function Chip({ color, text }: { color: "green" | "amber" | "purple"; text: string }) { return <span className={`chip ${color}`}>{text}</span>; }

function Auth({ mode, onBack, onAuthenticated, onModeChange }: { mode: AuthMode; onBack: () => void; onAuthenticated: () => void; onModeChange: (mode: AuthMode) => void }) {
  const { signIn } = useSignIn();
  const { signUp } = useSignUp();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [stage, setStage] = useState<"credentials" | "verify">("credentials");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const finish = async (attempt: { finalize: (options: { navigate: () => void }) => Promise<unknown> }) => {
    await attempt.finalize({ navigate: onAuthenticated });
  };
  const messageFor = (reason: unknown) => {
    if (typeof reason === "object" && reason && "errors" in reason) {
      const errors = (reason as { errors?: Array<{ longMessage?: string; message?: string }> }).errors;
      return errors?.[0]?.longMessage ?? errors?.[0]?.message ?? "We couldn't complete that request. Please try again.";
    }
    return "We couldn't complete that request. Please try again.";
  };
  const submitCredentials = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError("");
    setSubmitting(true);
    try {
      if (mode === "signup") {
        const { error: clerkError } = await signUp.password({ emailAddress: email, password });
        if (clerkError) { setError(messageFor(clerkError)); return; }
        if (signUp.status === "complete") { await finish(signUp); return; }
        await signUp.verifications.sendEmailCode();
        setStage("verify");
        return;
      }
      const { error: clerkError } = await signIn.password({ identifier: email, password });
      if (clerkError) { setError(messageFor(clerkError)); return; }
      if (signIn.status === "complete") { await finish(signIn); return; }
      if (signIn.status === "needs_client_trust") {
        await signIn.mfa.sendEmailCode();
        setStage("verify");
        return;
      }
      setError("This sign-in needs an additional verification step that is not available for this account.");
    } catch (reason) { setError(messageFor(reason)); }
    finally { setSubmitting(false); }
  };
  const continueWithGoogle = async () => {
    setError("");
    setSubmitting(true);
    try {
      const options = {
        strategy: "oauth_google" as const,
        redirectUrl: window.location.origin,
        redirectCallbackUrl: window.location.origin,
      };
      const { error: clerkError } = mode === "signup"
        ? await signUp.sso(options)
        : await signIn.sso(options);
      if (clerkError) setError(messageFor(clerkError));
    } catch (reason) { setError(messageFor(reason)); }
    finally { setSubmitting(false); }
  };
  const verifyCode = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(""); setSubmitting(true);
    try {
      if (mode === "signup") {
        const { error: clerkError } = await signUp.verifications.verifyEmailCode({ code });
        if (clerkError) { setError(messageFor(clerkError)); return; }
        if (signUp.status === "complete") await finish(signUp);
      } else {
        const { error: clerkError } = await signIn.mfa.verifyEmailCode({ code });
        if (clerkError) { setError(messageFor(clerkError)); return; }
        if (signIn.status === "complete") await finish(signIn);
      }
    } catch (reason) { setError(messageFor(reason)); }
    finally { setSubmitting(false); }
  };
  const switchMode = (nextMode: AuthMode) => { setError(""); setStage("credentials"); setCode(""); onModeChange(nextMode); };
  const verifying = stage === "verify";
  const title = mode === "signup" ? "Start your first world." : "Walk back in.";

  return <main className="auth-page"><div className="auth-backdrop" /><div className="auth-header"><Brand /><button className="quiet-button" onClick={onBack}>← Back</button></div><form className="auth-card" onSubmit={verifying ? verifyCode : submitCredentials}><div className="auth-tabs"><button className={mode === "login" ? "active" : ""} type="button" onClick={() => switchMode("login")}>Log in</button><button className={mode === "signup" ? "active" : ""} type="button" onClick={() => switchMode("signup")}>Sign up</button></div><h1>{verifying ? "Check your email." : title}</h1>{verifying ? <><p className="auth-note">We sent a verification code to <strong>{email}</strong>.</p><label><span>VERIFICATION CODE</span><input autoComplete="one-time-code" inputMode="numeric" value={code} onChange={(event) => setCode(event.target.value)} required /></label></> : <><label><span>EMAIL</span><input type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} required /></label><label><span>PASSWORD</span><input type="password" autoComplete={mode === "signup" ? "new-password" : "current-password"} value={password} onChange={(event) => setPassword(event.target.value)} required minLength={8} /></label></>}{error && <p className="auth-error" role="alert">{error}</p>}<button className="button full" type="submit" disabled={submitting}>{submitting ? "Please wait…" : verifying ? "Verify email" : mode === "signup" ? "Create account" : "Continue"}</button>{!verifying && <><div className="or">OR</div><button className="social" type="button" onClick={continueWithGoogle} disabled={submitting}>Continue with Google</button><p className="fine-print">{mode === "login" ? <>No account? <button type="button" onClick={() => switchMode("signup")}>Sign up</button></> : <>Already have an account? <button type="button" onClick={() => switchMode("login")}>Log in</button></>}</p></>}</form><p className="auth-quote">Every surface you walk past is marked by whether the camera saw it.</p></main>;
}

function Upload({ onBack, onGenerate, onExplore, onAuth, onLogin }: { onBack: () => void; onGenerate: (gen: Generation) => void; onExplore: () => void; onAuth: () => void; onLogin: () => void }) {
  const samples = [{ image: images.mouffetard, label: "PARIS · 1898" }, { image: images.mulberry, label: "NEW YORK · 1906" }, { image: images.montmartre, label: "PARIS · 1900" }];
  const [dragging, setDragging] = useState(false);
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<UploadSource[]>([]);
  const [model, setModel] = useState<MarbleModel>("marble-1.1");
  const [trim, setTrim] = useState(true);
  const [credits, setCredits] = useState<number | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  useEffect(() => { void getCredits().then(setCredits); }, []);
  const sourceForFile = (file: File): UploadSource | undefined => {
    const kind: SourceKind | undefined = file.type.startsWith("image/") ? "image"
      : file.type.startsWith("video/") ? "video"
        : file.type.startsWith("text/") || /\.(md|txt)$/i.test(file.name) ? "text"
          : undefined;
    return kind ? { name: file.name, kind, file } : undefined;
  };
  const imageFiles = attachments.filter((a) => a.kind === "image" && a.file);
  const generate = async () => {
    if (!imageFiles.length) { setError("Add at least one photograph. Text-only worlds are not wired yet."); return; }
    setError("");
    try {
      setBusy("preparing photographs…");
      const prepped = [];
      for (const a of imageFiles) prepped.push(await prepPhoto(a.file!, { trimBorder: trim }));
      setBusy("sending to Marble…");
      const name = text.trim() ? text.trim().split(/[.\n]/)[0].slice(0, 48) : imageFiles[0].name.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ");
      const jobId = await generateWorld({ name, text: text.trim() || historicalPrompt(), model, images: prepped });
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
  return <main className="page upload-page"><Header signedOut onUpload={onAuth} onLogin={onLogin} /><section className="upload-layout"><div className="upload-copy"><button className="back-link" onClick={onBack}>← Back</button><h1>Build from<br /><em>what you know.</em></h1><div className="guest-note"><span>GUEST SESSION</span><p>Combine a memory with photographs, video, or written records. Make one world, keep it for seven days, then decide if you want to save it.</p></div><button className="button ghost" onClick={onAuth}>Create an account instead</button></div><div className="upload-panel"><div className={`dropzone ${dragging ? "is-dragging" : ""}`} onDragEnter={beginDrag} onDragOver={beginDrag} onDragLeave={endDrag} onDrop={dropFiles}><span className="upload-mark">✦</span><strong>Build a world from evidence</strong><p className="source-intro">Add a prompt, reference files, or both. Every source helps shape the world.</p><label className="text-source"><span>WHAT SHOULD WE RECONSTRUCT?</span><textarea value={text} onChange={(event) => setText(event.target.value)} placeholder="Describe a place, moment, or scene you want to walk through…" /></label><div className="source-divider">ADD REFERENCE MATERIAL</div><input ref={fileInput} className="visually-hidden" type="file" multiple accept="image/jpeg,image/png,image/tiff,image/webp,video/mp4,video/webm,video/quicktime,text/plain,text/markdown,.txt,.md" onChange={(event) => { addFiles(event.target.files ?? []); event.currentTarget.value = ""; }} /><button className="add-source" type="button" onClick={() => fileInput.current?.click()}>+ Add images, video, or text files</button>{attachments.length > 0 && <div className="source-list" aria-label="Attached source material">{attachments.map((source, index) => <span className="source-chip" key={`${source.name}-${index}`}><i>{source.kind}</i>{source.name}<button type="button" aria-label={`Remove ${source.name}`} onClick={() => removeAttachment(index)}>×</button></span>)}</div>}<div className="gen-options"><label><span>MODEL</span><select value={model} onChange={(e) => setModel(e.target.value as MarbleModel)}><option value="marble-1.0-draft">Draft · 230 credits · 1 min · rough</option><option value="marble-1.1">Marble 1.1 · 1 580 credits · 5 min</option><option value="marble-1.1-plus">Marble 1.1 Plus · up to 3 080 · larger outdoor world</option></select></label><label className="check"><input type="checkbox" checked={trim} onChange={(e) => setTrim(e.target.checked)} /> trim scan borders (recommended: a paper border becomes a picture frame)</label><span className="credits">{credits === null ? "credits: —" : `credits: ${credits.toLocaleString()} · this run: ${MODEL_CREDITS[model]}`}</span></div>{error && <p className="auth-error" role="alert">{error}</p>}<button className="button text-generate" type="button" disabled={!sources.length || !!busy} onClick={() => void generate()}>{busy ?? `Generate world${sources.length ? ` · ${sources.length} source${sources.length === 1 ? "" : "s"}` : ""}`}</button></div><p className="eyebrow archive-label">OR WALK ONE OF OURS</p><div className="sample-grid">{samples.map((sample) => <button className="sample-card" key={sample.label} onClick={onExplore}><img src={sample.image} alt="" /><span>{sample.label}</span></button>)}</div></div></section><Historian className="upload-historian" hue="green" /></main>;
}

function SamplePicker({ onBack, onChoose }: { onBack: () => void; onChoose: (sample: SampleWorld) => void }) {
  // Worlds generated through the in-app bridge land in public/worlds/index.json; show them first.
  const [generated, setGenerated] = useState<SampleWorld[]>([]);
  useEffect(() => {
    fetch("/worlds/index.json").then((r) => (r.ok ? r.json() : [])).then((list: { id: string; name: string }[]) => {
      const known = new Set(sampleWorlds.map((w) => w.worldId));
      setGenerated(list.filter((w) => !known.has(w.id) && !w.id.startsWith("marble-sample")).map((w) => ({ title: w.name, place: "GENERATED WORLD", date: "", evidence: "LIVE PROVENANCE", image: `/worlds/${w.id}/source.jpg`, note: "Built from a photograph through Marble and classified against it.", quote: "You’re standing where the photographer stood.", worldId: w.id })));
    }).catch(() => undefined);
  }, []);
  const all = [...generated, ...sampleWorlds];
  return <main className="page sample-page"><header className="site-header"><Brand /><button className="quiet-button" onClick={onBack}>← Back</button></header><section className="sample-picker"><div className="sample-picker-intro"><h1>Choose a world<br /><em>to step into.</em></h1></div><div className="sample-picker-grid">{all.map((sample) => <button className="sample-picker-card" key={sample.title} onClick={() => onChoose(sample)}><div className="sample-picker-image"><img src={sample.image} alt="" /><span>READY TO WALK</span></div><div className="sample-picker-info"><p>{[sample.place, sample.date].filter(Boolean).join(" · ")}</p><h2>{sample.title}</h2><span>{sample.note}</span><b>{sample.evidence} <i>→</i></b></div></button>)}</div></section></main>;
}

function Library({ onNew, onExplore }: { onNew: () => void; onExplore: () => void }) {
  return <main className="page library-page"><Header onUpload={onNew} onLibrary={() => undefined} /><section className="library-intro"><div><h1>Your worlds</h1><p>6 reconstructions · 1 still building</p></div><div className="actions"><button className="select">Recent</button><button className="button compact" onClick={onNew}>New world</button></div></section><section className="world-grid">{worlds.map((world) => <WorldCard key={world.title} world={world} onClick={onExplore} />)}<button className="new-card" onClick={onNew}><span>+</span>Create a world</button></section></main>;
}

function WorldCard({ world, onClick }: { world: typeof worlds[number]; onClick: () => void }) { return <button className={`world-card ${world.building ? "building" : ""}`} onClick={onClick}><div className="world-image"><img src={world.image} alt="" /><span className="status">{world.building ? "BUILDING · 62%" : "READY"}</span>{world.building && <i />}</div><div className="world-info"><strong>{world.title}</strong><span>{world.detail}</span></div></button>; }

function Making({ generation, onLibrary, onReady, onRetry }: { generation: Generation | null; onLibrary: () => void; onReady: (worldId: string, name: string) => void; onRetry: () => void }) {
  const [job, setJob] = useState<Job | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  useEffect(() => {
    const file = generation?.sources.find((s) => s.kind === "image" && s.file)?.file;
    if (!file) return;
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [generation]);
  useEffect(() => {
    if (!generation) return;
    let stop = false;
    const tick = async () => {
      try {
        const j = await getJob(generation.jobId);
        if (stop) return;
        setJob(j);
        if (j.status === "ready" && j.worldId) { onReady(j.worldId, generation.name); return; }
        if (j.status === "error") return;
      } catch (e) {
        if (!stop) setJob((prev) => prev ? { ...prev, status: "error", error: String(e) } : null);
        return;
      }
      if (!stop) setTimeout(tick, 3000);
    };
    void tick();
    return () => { stop = true; };
  }, [generation]); // eslint-disable-line react-hooks/exhaustive-deps
  const elapsed = job ? `${Math.floor(job.elapsedS / 60)}:${String(job.elapsedS % 60).padStart(2, "0")}` : "0:00";
  const failed = job?.status === "error";
  const pct = job ? ({ queued: 4, uploading: 10, generating: Math.min(85, 15 + job.elapsedS / 4), downloading: 92, ready: 100, error: 100 } as Record<string, number>)[job.status] : 2;
  return <main className="making-page"><Brand /><div className="making-image"><img src={preview ?? images.mouffetard} alt="Your photograph" /></div><div className="point-field" /><section className="making-copy"><h1>{failed ? "That didn’t work." : "Making your world"}</h1><p>{failed ? job?.error : "Marble is building a walkable world from your photograph. About five minutes for the standard model, about one for a draft."}</p><div className="progress"><i style={{ width: `${pct}%` }} /></div><div className="progress-meta"><span>{(job?.stage ?? "starting").toUpperCase()}{generation ? ` · ${generation.name.toUpperCase()}` : ""}</span><span>{elapsed}</span></div></section><div className="making-actions">{failed ? <button className="button ghost" onClick={onRetry}>Try again</button> : null}<button className="quiet-button" onClick={onLibrary}>Back to library</button></div></main>;
}

function Explore({ world, evidence, speaking, onToggleEvidence, onExit }: { world: SampleWorld; evidence: boolean; speaking: boolean; onToggleEvidence: () => void; onExit: () => void }) {
  const [counts, setCounts] = useState<EvidenceCounts | null>(null);
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const live = !!world.worldId;
  // Percentages are real once the classifier has run; the mock cards keep their written copy.
  const share = (index: 0 | 1 | 2, fallback: string) => (counts ? `${counts[index].toFixed(1)}%` : fallback);
  // Class ids are ordered [unsupported, occluded, visible] — see provenance.ts.
  const hue: OrbHue = verdict ? (["purple", "amber", "green"] as const)[verdict.cls] : evidence ? "amber" : "green";
  return <main className={`explore-page ${evidence ? "evidence-mode" : ""}`}>{live ? <WorldCanvas worldId={world.worldId!} evidence={evidence} onCounts={setCounts} onVerdict={setVerdict} /> : <img className="explore-photo" src={world.image} alt={`${world.title}, ${world.place}`} />}<div className="explore-vignette" />{evidence && !live && <div className="evidence-map" />}{evidence && !live && <div className="frustum"><span>ORIGINAL PLATE — {world.date} · 6.4 M BEHIND YOU</span><i /><b /></div>}<div className="crosshair" /><div className="explore-top"><Brand light /><div className="explore-buttons"><button onClick={onToggleEvidence}>{evidence ? "Exit evidence" : "Evidence mode"}</button><button onClick={onExit}>Leave world</button></div></div>{evidence && <aside className="legend"><p>EVIDENCE · {world.title.toUpperCase()}</p><span><i className="green" />SOURCE-VISIBLE · {share(2, world.evidence.split(" ")[0])}</span><span><i className="amber" />OCCLUDED · INFERRED · {share(1, "34%")}</span><span><i className="purple" />UNSUPPORTED · {share(0, "25%")}</span></aside>}<div className="explore-caption"><Historian hue={hue} state={speaking ? "listening" : "idle"} /><blockquote>{evidence && verdict ? `“${verdict.reason}”` : evidence ? "“You're looking at a wall the camera never saw. Its height comes from the building opposite.”" : `“${world.quote}”`}</blockquote><p>{[world.place, world.date, live ? "DRAG TO LOOK · WASD TO WALK · R PHOTOGRAPHER · TAB PHOTOGRAPH · V WIPE · E EVIDENCE" : "HOLD SPACE TO SPEAK · PRESS E FOR EVIDENCE"].filter(Boolean).join(" · ")}</p></div></main>;
}

/** Hue carries the evidence state under the crosshair; state carries what the historian is doing. */
type OrbHue = "green" | "amber" | "purple";
type OrbState = "idle" | "listening" | "thinking" | "speaking";

function Historian({ className = "", hue, state = "idle" }: { className?: string; hue: OrbHue; state?: OrbState }) { return <span className={`historian ${className} ${hue} is-${state}`} aria-hidden="true" />; }
