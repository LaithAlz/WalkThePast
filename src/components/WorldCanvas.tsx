import { useEffect, useRef, useState } from "react";
import { Viewer, type EvidenceCounts, type Verdict, type ViewerStatus, type NavigationStatus } from "../viewer/Viewer";
import { DEFAULT_SENSITIVITY } from "../viewer/controls";
import { PhotoTransition, type Mode } from "../viewer/transition";
import type { WorldManifest } from "../viewer/world";

type Props = {
  worldId: string;
  evidence: boolean;
  autoEnter?: boolean;
  entryReady?: boolean;
  waitingMessage?: string;
  onLandingHidden?: () => void;
  onCounts?: (counts: EvidenceCounts) => void;
  onVerdict?: (verdict: Verdict | null) => void;
  onMode?: (mode: Mode) => void;
  onReady?: (ready: boolean) => void;
  suspended?: boolean;
  onSnapshot?: (dataUrl: string) => void;
  /** The pause menu is the only in-world chrome, so it carries the way out:
   * cursor-steering makes a button you must travel to hostile, and a paused
   * camera makes one you are already standing on safe. */
  onExit?: () => void;
  voice?: boolean;
  onPaused?: (paused: boolean) => void;
};

export function WorldCanvas({ worldId, evidence, autoEnter = false, entryReady = true, waitingMessage = "Preparing the experience…", onLandingHidden, onCounts, onVerdict, onMode, onReady, suspended = false, onSnapshot, onExit, voice = false, onPaused }: Props) {
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLImageElement>(null);
  const handleRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<Viewer | null>(null);
  const transitionRef = useRef<PhotoTransition | null>(null);
  const [status, setStatus] = useState<ViewerStatus>({ kind: "idle" });
  const [manifest, setManifest] = useState<WorldManifest | null>(null);
  const [mode, setMode] = useState<Mode>("photo");
  const [navigation, setNavigation] = useState<NavigationStatus>({ mode: "loading", message: "Preparing walking…" });
  const [pauseMenu, setPauseMenu] = useState(false);
  const [entering, setEntering] = useState(false);
  // Pointer lock is the browser's to give and take, so the prompt tracks what
  // it reports rather than what we last asked for.
  const [locked, setLocked] = useState(false);
  // Correct look speed depends on the user's mouse, so it is theirs to set and keep.
  const [sensitivity, setSensitivity] = useState(readSensitivity);
  const touchKeys = useRef(new Set<string>());

  useEffect(() => {
    viewerRef.current?.setLookSensitivity(sensitivity);
    try { localStorage.setItem(SENSITIVITY_KEY, String(sensitivity)); } catch { /* private mode */ }
  }, [sensitivity]);

  useEffect(() => {
    const clear = () => {
      touchKeys.current.clear();
      viewerRef.current?.setTouchMove(0, 0);
    };
    const onVisibility = () => { if (document.hidden) clear(); };
    clear();
    window.addEventListener("blur", clear);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clear();
      window.removeEventListener("blur", clear);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [worldId, navigation.mode]);

  const resume = () => {
    setPauseMenu(false);
    viewerRef.current?.setPaused(false);
    // Still inside the click that opened this, so the browser accepts it.
    viewerRef.current?.requestLook();
  };
  // Callbacks change identity every render; keep them in a ref so the viewer is
  // built once rather than torn down and rebuilt on each parent render.
  const sinks = useRef({ onCounts, onVerdict, onMode, onLandingHidden, resume });
  useEffect(() => {
    sinks.current = { onCounts, onVerdict, onMode, onLandingHidden, resume };
  });

  useEffect(() => {
    const canvas = canvasRef.current;
    const overlay = overlayRef.current;
    const handle = handleRef.current;
    const stage = stageRef.current;
    if (!canvas || !overlay || !handle || !stage) return;

    const transition = new PhotoTransition(overlay, handle, stage);
    transitionRef.current = transition;
    const viewer = new Viewer(canvas, {
      onStatus: setStatus,
      onManifest: (m) => {
        setManifest(m);
        setEntering(false);
        transition.showPhoto();
        viewer.setInteractive(false);
      },
      onNavigation: (next) => {
        if (next.mode === "loading") setPauseMenu(false);
        setNavigation(next);
      },
      onPauseRequest: () => {
        viewerRef.current?.setPaused(true);
        setPauseMenu(true);
      },
      onResumeRequest: () => sinks.current.resume(),
      onLockChange: setLocked,
      onCounts: (counts) => sinks.current.onCounts?.(counts),
      onVerdict: (verdict) => sinks.current.onVerdict?.(verdict),
    });
    transition.onMode = (m) => {
      setMode(m);
      viewer.setInteractive(m === "world");
      sinks.current.onMode?.(m);
    };
    viewerRef.current = viewer;
    // Read back rather than close over the state: this effect runs once, and it
    // runs before the effect that pushes later changes.
    viewer.setLookSensitivity(readSensitivity());
    viewer.start();
    if (import.meta.env.DEV) (window as unknown as { wtpTransition?: PhotoTransition }).wtpTransition = transition;

    const observer = new ResizeObserver(() => viewer.resize());
    observer.observe(canvas);

    return () => {
      observer.disconnect();
      viewer.dispose();
      viewerRef.current = null;
      transitionRef.current = null;
    };
  }, []);

  useEffect(() => {
    void viewerRef.current?.load(worldId);
  }, [worldId]);

  useEffect(() => {
    onReady?.(status.kind === "ready");
  }, [status, onReady]);

  useEffect(() => {
    onPaused?.(pauseMenu);
  }, [pauseMenu, onPaused]);

  useEffect(() => {
    viewerRef.current?.setEvidenceMode(evidence);
  }, [evidence]);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    if (suspended) {
      onSnapshot?.(viewer.captureSnapshot());
      viewer.setInteractive(false);
      viewer.stop();
    } else {
      viewer.start();
      viewer.setInteractive(mode === "world");
    }
  }, [suspended, onSnapshot, mode]);

  const ready = status.kind === "ready";
  const canEnter = ready && entryReady;
  const enter = async () => {
    const t = transitionRef.current;
    if (!t || t.mode !== "photo" || !canEnter) return;
    setEntering(true);
    viewerRef.current?.resetToPhotographer(false);
    await t.enterWorld();
    sinks.current.onLandingHidden?.();
  };

  useEffect(() => {
    if (!canEnter) return;
    if (autoEnter || !manifest?.source?.image) void enter(); // preview routes skip the photo landing
  }, [canEnter]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      const t = transitionRef.current;
      if (!t) return;
      if ((e.code === "Enter" || e.code === "Space") && t.mode === "photo") { e.preventDefault(); void enter(); }
      if (e.code === "Tab") { e.preventDefault(); t.peek(true); }
      if (e.code === "KeyV") t.toggleWipe();
      if (e.code === "KeyL") viewerRef.current?.savePose();
    };
    const up = (e: KeyboardEvent) => { if (e.code === "Tab") transitionRef.current?.peek(false); };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => { window.removeEventListener("keydown", down); window.removeEventListener("keyup", up); };
  }); // re-bound each render so `enter` sees the current status

  const updateTouch = (key: string, pressed: boolean) => {
    if (pressed) touchKeys.current.add(key); else touchKeys.current.delete(key);
    const keys = touchKeys.current;
    viewerRef.current?.setTouchMove(Number(keys.has("right")) - Number(keys.has("left")), Number(keys.has("back")) - Number(keys.has("forward")));
  };
  // Walking chrome belongs to the world, so it stays out of the way until the
  // photograph has been stepped through.
  const inWorld = mode === "world";
  const canWalk = inWorld && (navigation.mode === "walking" || navigation.mode === "ground-only");
  const credit = manifest?.credit ?? {};
  const meta = [credit.photographer, credit.year, credit.place].filter(Boolean).join(" · ");

  return (
    <div className="explore-host">
      <div className="explore-stage" ref={stageRef}>
        <canvas
          ref={canvasRef}
          className="explore-canvas"
          tabIndex={0}
          aria-label="3D world. Click to look around, then W A S D to move, Shift to run, R to reset. Press M to release the cursor and open the menu."
        />
        <img
          ref={overlayRef}
          className="explore-overlay"
          src={manifest?.source?.image ?? undefined}
          alt=""
          draggable={false}
          onLoad={() => transitionRef.current?.refresh()}
        />
        <div ref={handleRef} className="wipe-handle"><span /></div>
        {mode === "photo" && manifest?.source?.image && (
          <div className={`photo-landing${entering ? " is-entering" : ""}`} onTransitionEnd={(event) => { if (event.propertyName === "opacity" && entering) sinks.current.onLandingHidden?.(); }}>
            <div className="photo-card">
              <p className="eyebrow">THE PHOTOGRAPH</p>
              <h2>{credit.title ?? manifest.name}</h2>
              {meta && <p className="photo-meta">{meta}</p>}
              {credit.licence && <p className="photo-licence">{credit.licence}</p>}
              <div className="photo-actions">
                <button className="button" disabled={!canEnter} onClick={() => void enter()}>
                  {canEnter ? "Walk into the photograph" : ready ? "Preparing the historian" : "Preparing the world"}
                </button>
                {canEnter && <span className="photo-enter">or press <kbd>Enter</kbd></span>}
                {onExit && <button className="quiet-button photo-back" type="button" onClick={onExit}>← Back</button>}
              </div>
              {/* Controls live in the info card now, so the landing only has to
                  explain itself and show that something is still happening. */}
              {!canEnter && <p className="photo-progress" role="status"><i aria-hidden="true" /><span>{ready ? waitingMessage : describe(status)}</span></p>}
            </div>
          </div>
        )}
      </div>
      {/* While the cursor is captured nothing on screen can be clicked, so the
          way out has to be a key. This says which one, and the prompt it turns
          into is the way back in — it lets the click through to the canvas. */}
      {inWorld && ready && !pauseMenu && (locked
        ? <p className="look-hint"><kbd>M</kbd> free the cursor</p>
        : <div className="look-prompt" role="status">
            <p>
              <b>Click to look around</b>
              <span><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> move · <kbd>Shift</kbd> run · <kbd>M</kbd> release the cursor</span>
              {voice && <em>Hold <kbd>Space</kbd> to talk to your tutor</em>}
            </p>
          </div>)}
      {canWalk && <div className="walking-touch" aria-label="Walking controls">
        {([['forward', '↑', 'Walk forward'], ['left', '←', 'Step left'], ['back', '↓', 'Walk back'], ['right', '→', 'Step right']] as const).map(([key, label, description]) => <button
          key={key} className={`walk-${key}`} aria-label={description}
          onPointerDown={event => { event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); updateTouch(key, true); }}
          onPointerUp={() => updateTouch(key, false)} onPointerCancel={() => updateTouch(key, false)}
          onLostPointerCapture={() => updateTouch(key, false)} onBlur={() => updateTouch(key, false)}
          onKeyDown={event => { if (event.code === "Space" || event.code === "Enter") { event.preventDefault(); event.stopPropagation(); updateTouch(key, true); } }}
          onKeyUp={event => { if (event.code === "Space" || event.code === "Enter") { event.preventDefault(); event.stopPropagation(); updateTouch(key, false); } }}
        >{label}</button>)}
      </div>}
      {pauseMenu && <div className="walk-pause-backdrop" role="presentation">
        <section className="walk-pause-menu" role="dialog" aria-modal="true" aria-labelledby="walk-pause-title">
          <p className="eyebrow">WALK THE PAST</p>
          <h2 id="walk-pause-title">Paused</h2>
          <p>Walking, looking and the historian are all held. Resume to carry on where you left off.</p>
          <dl className="walk-shortcuts">
            <div><dt>Click</dt><dd>Look around</dd></div>
            <div><dt>W A S D</dt><dd>Move</dd></div>
            <div><dt>Mouse</dt><dd>Look</dd></div>
            <div><dt>Shift</dt><dd>Run</dd></div>
            <div><dt>M</dt><dd>Free the cursor</dd></div>
            {voice && <div><dt>Space</dt><dd>Hold to talk</dd></div>}
            <div><dt>M</dt><dd>This menu</dd></div>
            <div><dt>R</dt><dd>Reset position</dd></div>
            <div><dt>E</dt><dd>Evidence</dd></div>
            <div><dt>Tab</dt><dd>Hold for photo</dd></div>
            <div><dt>V</dt><dd>Image wipe</dd></div>
          </dl>
          <label className="walk-sensitivity">
            <span>Look sensitivity<b>{sensitivity.toFixed(2)}×</b></span>
            <input
              type="range" min="0.25" max="3" step="0.05" value={sensitivity}
              onChange={event => setSensitivity(Number(event.target.value))}
            />
          </label>
          <div className="walk-pause-actions">
            <button className="button" onClick={resume}>Resume walking</button>
            {onExit && <button className="quiet-button" onClick={onExit}>Leave world</button>}
          </div>
        </section>
      </div>}
      {status.kind !== "ready" && (mode !== "photo" || status.kind === "error") && <div role="status" className={`explore-loading${status.kind === "error" ? " is-error" : ""}`}>{describe(status)}</div>}
    </div>
  );
}

// Versioned: the slider persists on mount, so anyone who has opened the app
// already has the old default stored and would never see a new one. Bumping
// the key retires those saved values along with the controller they were
// chosen for — mouselook deltas are a different scale from cursor steering.
const SENSITIVITY_KEY = "wtp:look-sensitivity:pointerlock";

function readSensitivity(): number {
  try {
    const stored = Number(localStorage.getItem(SENSITIVITY_KEY));
    if (Number.isFinite(stored) && stored > 0) return Math.min(3, Math.max(0.25, stored));
  } catch { /* private mode */ }
  return DEFAULT_SENSITIVITY;
}

function describe(status: ViewerStatus): string {
  switch (status.kind) {
    case "idle":
      return "STARTING…";
    case "loading":
      return `${status.message.toUpperCase()}…`;
    case "ready":
      return `${status.splats.toLocaleString()} SPLATS`;
    case "error":
      return status.message.toUpperCase();
  }
}
