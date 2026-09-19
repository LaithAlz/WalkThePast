import { useEffect, useRef, useState } from "react";
import { useAuth, useSignIn, useSignUp } from "@clerk/react";

type Screen = "landing" | "auth" | "upload" | "library" | "making" | "explore";
type AuthMode = "login" | "signup";

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

export default function App() {
  const [screen, setScreen] = useState<Screen>("landing");
  const [authMode, setAuthMode] = useState<AuthMode>("login");
  const [evidence, setEvidence] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [uploadName, setUploadName] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
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

  const explore = () => { setEvidence(false); setScreen("explore"); };
  const chooseFile = (file?: File) => { if (file) { setUploadName(file.name); setScreen("making"); } };

  const openAuth = (mode: AuthMode) => { setAuthMode(mode); setScreen("auth"); };

  if (screen === "auth") return <Auth mode={authMode} onBack={() => setScreen("landing")} onAuthenticated={() => setScreen("library")} onModeChange={setAuthMode} />;
  if (screen === "upload") return <Upload onBack={() => setScreen("landing")} onBrowse={() => fileInput.current?.click()} onExplore={explore} onAuth={() => openAuth("signup")} onLogin={() => openAuth("login")}><input ref={fileInput} className="visually-hidden" type="file" accept="image/jpeg,image/png,image/tiff" onChange={(event) => chooseFile(event.target.files?.[0])} /></Upload>;
  if (screen === "making") return <Making name={uploadName} onLibrary={() => setScreen("library")} />;
  if (screen === "library") return <Library onNew={() => setScreen("upload")} onExplore={explore} />;
  if (screen === "explore") return <Explore evidence={evidence} speaking={speaking} onToggleEvidence={() => setEvidence((value) => !value)} onExit={() => setScreen("library")} />;
  return <Landing onUpload={() => setScreen("upload")} onLogin={() => openAuth("login")} onSignUp={() => openAuth("signup")} onExplore={explore} />;
}

function Brand({ light = false }: { light?: boolean }) {
  return <button className={`brand ${light ? "brand-light" : ""}`} onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}><span className="brand-dot" /><span>WALK THE PAST</span></button>;
}

function Header({ onUpload, onLibrary, onLogin, signedOut = false }: { onUpload?: () => void; onLibrary?: () => void; onLogin?: () => void; signedOut?: boolean }) {
  return <header className="site-header"><Brand /><nav>{!signedOut && <button onClick={onUpload}>New world</button>}{!signedOut && <button onClick={onLibrary}>Library</button>}<button onClick={() => document.getElementById("method")?.scrollIntoView({ behavior: "smooth" })}>Method</button>{signedOut ? <><button className="auth-login" onClick={onLogin}>Log in</button><button className="button compact" onClick={onUpload}>Sign up</button></> : <button className="avatar" aria-label="Account" />}</nav></header>;
}

function Landing({ onUpload, onLogin, onSignUp, onExplore }: { onUpload: () => void; onLogin: () => void; onSignUp: () => void; onExplore: () => void }) {
  return <main className="page landing-page"><Header signedOut onLogin={onLogin} onUpload={onSignUp} /><section className="landing-hero"><div className="landing-copy"><p className="eyebrow blue">NO ACCOUNT NEEDED FOR YOUR FIRST WORLD</p><h1>Stand inside<br /><em>a photograph.</em></h1><p className="lede">Upload one historical image. We reconstruct the street around it and mark every surface by whether the original camera saw it — or whether we inferred it. A voice historian walks with you.</p><div className="actions"><button className="button" onClick={onUpload}>Upload a photograph</button><button className="button ghost" onClick={onExplore}>Walk a sample world</button></div></div><div className="hero-visual"><img src={images.atget} alt="Historical Paris street scene" /><div className="image-scrim" /><div className="evidence-chips"><Chip color="green" text="SOURCE-VISIBLE 41%" /><Chip color="amber" text="INFERRED 34%" /><Chip color="purple" text="UNSUPPORTED 25%" /></div></div><p className="caption">SAMPLE WORLD · RUE DE LA MONTAGNE-SAINTE-GENEVIÈVE · PARIS</p></section><section className="steps" id="method"><Step n="01" title="Upload one photograph" copy="Any street-level image from 1850 onwards. No calibration data needed." /><Step n="02" title="We build it in five minutes" copy="A navigable world, mapped back to the source camera." /><Step n="03" title="Walk it, and ask out loud" copy="A voice historian tells you where the evidence ends." /></section></main>;
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
      const { error: clerkError } = await signIn.password({ emailAddress: email, password });
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

  return <main className="auth-page"><div className="auth-backdrop" /><div className="auth-header"><Brand /><button className="quiet-button" onClick={onBack}>← Back</button></div><form className="auth-card" onSubmit={verifying ? verifyCode : submitCredentials}><div className="auth-tabs"><button className={mode === "login" ? "active" : ""} type="button" onClick={() => switchMode("login")}>Log in</button><button className={mode === "signup" ? "active" : ""} type="button" onClick={() => switchMode("signup")}>Sign up</button></div><h1>{verifying ? "Check your email." : title}</h1>{verifying ? <><p className="auth-note">We sent a verification code to <strong>{email}</strong>.</p><label><span>VERIFICATION CODE</span><input autoComplete="one-time-code" inputMode="numeric" value={code} onChange={(event) => setCode(event.target.value)} required /></label></> : <><label><span>EMAIL</span><input type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} required /></label><label><span>PASSWORD</span><input type="password" autoComplete={mode === "signup" ? "new-password" : "current-password"} value={password} onChange={(event) => setPassword(event.target.value)} required minLength={8} /></label></>}{error && <p className="auth-error" role="alert">{error}</p>}<button className="button full" type="submit" disabled={submitting}>{submitting ? "Please wait…" : verifying ? "Verify email" : mode === "signup" ? "Create account" : "Continue"}</button>{!verifying && <><div className="or">OR</div><p className="fine-print">{mode === "login" ? <>No account? <button type="button" onClick={() => switchMode("signup")}>Sign up</button></> : <>Already have an account? <button type="button" onClick={() => switchMode("login")}>Log in</button></>}</p></>}</form><p className="auth-quote">Every surface you walk past is marked by whether the camera saw it.</p></main>;
}

function Upload({ onBack, onBrowse, onExplore, onAuth, onLogin, children }: { onBack: () => void; onBrowse: () => void; onExplore: () => void; onAuth: () => void; onLogin: () => void; children: React.ReactNode }) {
  const samples = [{ image: images.mouffetard, label: "PARIS · 1898" }, { image: images.mulberry, label: "NEW YORK · 1906" }, { image: images.montmartre, label: "PARIS · 1900" }];
  return <main className="page upload-page"><Header signedOut onUpload={onAuth} onLogin={onLogin} /><section className="upload-layout"><div className="upload-copy"><button className="back-link" onClick={onBack}>← Back</button><h1>Try one world,<br /><em>no account.</em></h1><div className="guest-note"><span>GUEST SESSION</span><p>Make one world, keep it for seven days, then decide if you want to save it.</p></div><button className="button ghost" onClick={onAuth}>Create an account instead</button></div><div className="upload-panel"><button className="dropzone" onClick={onBrowse}><span className="upload-mark">✦</span><strong>Drop a photograph</strong><small>JPG · TIFF · PNG — UP TO 80 MB</small><span className="button compact">Browse files</span></button><p className="eyebrow archive-label">OR WALK ONE OF OURS</p><div className="sample-grid">{samples.map((sample) => <button className="sample-card" key={sample.label} onClick={onExplore}><img src={sample.image} alt="" /><span>{sample.label}</span></button>)}</div></div></section><Historian className="upload-historian" color="green" />{children}</main>;
}

function Library({ onNew, onExplore }: { onNew: () => void; onExplore: () => void }) {
  return <main className="page library-page"><Header onUpload={onNew} onLibrary={() => undefined} /><section className="library-intro"><div><h1>Your worlds</h1><p>6 reconstructions · 1 still building</p></div><div className="actions"><button className="select">Recent</button><button className="button compact" onClick={onNew}>New world</button></div></section><section className="world-grid">{worlds.map((world) => <WorldCard key={world.title} world={world} onClick={onExplore} />)}<button className="new-card" onClick={onNew}><span>+</span>Upload a photograph</button></section></main>;
}

function WorldCard({ world, onClick }: { world: typeof worlds[number]; onClick: () => void }) { return <button className={`world-card ${world.building ? "building" : ""}`} onClick={onClick}><div className="world-image"><img src={world.image} alt="" /><span className="status">{world.building ? "BUILDING · 62%" : "READY"}</span>{world.building && <i />}</div><div className="world-info"><strong>{world.title}</strong><span>{world.detail}</span></div></button>; }

function Making({ name, onLibrary }: { name: string; onLibrary: () => void }) {
  return <main className="making-page"><Brand /><div className="making-image"><img src={images.mouffetard} alt="Historical street photograph" /></div><div className="point-field" /><section className="making-copy"><h1>Making your world</h1><p>This takes about five minutes. You can close this tab — we'll email you the moment it’s ready to walk.</p><div className="progress"><i /></div><div className="progress-meta"><span>{name ? name.toUpperCase() : "RUE MOUFFETARD · 1898"}</span><span>3:47 LEFT</span></div></section><div className="making-actions"><button className="button ghost" onClick={onLibrary}>Notify me and close</button><button className="quiet-button" onClick={onLibrary}>Back to library</button></div></main>;
}

function Explore({ evidence, speaking, onToggleEvidence, onExit }: { evidence: boolean; speaking: boolean; onToggleEvidence: () => void; onExit: () => void }) {
  return <main className={`explore-page ${evidence ? "evidence-mode" : ""}`}><img className="explore-photo" src={images.atget} alt="Historical street reconstruction view" /><div className="explore-vignette" />{evidence && <div className="evidence-map" />}{evidence && <div className="frustum"><span>ORIGINAL PLATE — 1898 · 6.4 M BEHIND YOU</span><i /><b /></div>}<div className="crosshair" /><div className="explore-top"><Brand light /><div className="explore-buttons"><button onClick={onToggleEvidence}>{evidence ? "Exit evidence" : "Evidence mode"}</button><button onClick={onExit}>Leave world</button></div></div>{evidence && <aside className="legend"><p>EVIDENCE</p><span><i className="green" />SOURCE-VISIBLE · 41%</span><span><i className="amber" />OCCLUDED · INFERRED · 34%</span><span><i className="purple" />UNSUPPORTED · 25%</span></aside>}<div className="explore-caption"><Historian color={evidence ? "amber" : "green"} speaking={speaking} /><blockquote>{evidence ? "“You're looking at a wall the camera never saw. Its height comes from the building opposite.”" : "“You’re standing where the original photographer stood.”"}</blockquote><p>HOLD SPACE TO SPEAK · PRESS E FOR EVIDENCE</p></div></main>;
}

function Historian({ className = "", color, speaking = false }: { className?: string; color: "green" | "amber"; speaking?: boolean }) { return <img className={`historian ${className} ${color} ${speaking ? "speaking" : ""}`} src="/assets/historian-amber-orb.png" alt="" />; }
