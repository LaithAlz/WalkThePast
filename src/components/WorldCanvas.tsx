import { useEffect, useRef, useState } from "react";
import { Viewer, type EvidenceCounts, type Verdict, type ViewerStatus, type NavigationStatus } from "../viewer/Viewer";

type Props = {
  worldId: string;
  evidence: boolean;
  onCounts?: (counts: EvidenceCounts) => void;
  onVerdict?: (verdict: Verdict | null) => void;
  onExit?: () => void;
};

export function WorldCanvas({ worldId, evidence, onCounts, onVerdict, onExit }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewerRef = useRef<Viewer | null>(null);
  const [status, setStatus] = useState<ViewerStatus>({ kind: "idle" });
  const [navigation, setNavigation] = useState<NavigationStatus>({ mode: "loading", message: "Preparing walking…" });
  const [pauseMenu, setPauseMenu] = useState(false);
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

  // Callbacks change identity every render; keep them in a ref so the viewer is
  // built once rather than torn down and rebuilt on each parent render.
  const resume = () => {
    setPauseMenu(false);
    viewerRef.current?.setPaused(false);
  };
  const reset = () => {
    viewerRef.current?.resetToPhotographer();
    resume();
  };

  const sinks = useRef({ onCounts, onVerdict, resume });
  useEffect(() => {
    sinks.current = { onCounts, onVerdict, resume };
  });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const viewer = new Viewer(canvas, {
      onStatus: setStatus,
      onNavigation: (next) => {
        if (next.mode === "loading") setPauseMenu(false);
        setNavigation(next);
      },
      onPauseRequest: () => {
        viewerRef.current?.setPaused(true);
        setPauseMenu(true);
      },
      onResumeRequest: () => sinks.current.resume(),
      onCounts: (counts) => sinks.current.onCounts?.(counts),
      onVerdict: (verdict) => sinks.current.onVerdict?.(verdict),
    });
    viewerRef.current = viewer;
    // Read back rather than close over the state: this effect runs once, and it
    // runs before the effect that pushes later changes.
    viewer.setLookSensitivity(readSensitivity());
    viewer.start();

    const observer = new ResizeObserver(() => viewer.resize());
    observer.observe(canvas);

    return () => {
      observer.disconnect();
      viewer.dispose();
      viewerRef.current = null;
    };
  }, []);

  useEffect(() => {
    void viewerRef.current?.load(worldId);
  }, [worldId]);

  useEffect(() => {
    viewerRef.current?.setEvidenceMode(evidence);
  }, [evidence]);

  const updateTouch = (key: string, pressed: boolean) => {
    if (pressed) touchKeys.current.add(key); else touchKeys.current.delete(key);
    const keys = touchKeys.current;
    viewerRef.current?.setTouchMove(Number(keys.has("right")) - Number(keys.has("left")), Number(keys.has("back")) - Number(keys.has("forward")));
  };
  const canWalk = navigation.mode === "walking" || navigation.mode === "ground-only";

  return (
    <>
      <canvas ref={canvasRef} className="explore-canvas" tabIndex={0} aria-label="3D world. Move the pointer or scroll to turn. Press Escape for the menu. Use W A S D or arrow keys to walk, Shift to run, R to reset." />
      <div className="walking-toolbar">
        <span role="status" className={`walking-status ${navigation.mode}`}>{navigation.message}</span>
        <button disabled={!canWalk} onClick={() => viewerRef.current?.resetToPhotographer()}>Reset position</button>
      </div>
      {canWalk && <div className="walking-touch" aria-label="Walking controls">
        {([['forward', '↑'], ['left', '←'], ['back', '↓'], ['right', '→']] as const).map(([key, label]) => <button
          key={key} className={`walk-${key}`} aria-label={`Walk ${key}`}
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
          <p>Looking and walking are paused. Resume to carry on exploring.</p>
          <label className="walk-sensitivity">
            <span>Look sensitivity<b>{sensitivity.toFixed(2)}×</b></span>
            <input
              type="range" min="0.25" max="3" step="0.05" value={sensitivity}
              onChange={event => setSensitivity(Number(event.target.value))}
            />
          </label>
          <div className="walk-pause-actions">
            <button className="button" onClick={resume}>Resume walking</button>
            <button className="button ghost" onClick={reset}>Reset position</button>
            {onExit && <button className="quiet-button" onClick={onExit}>Leave world</button>}
          </div>
          <small>ESC MENU · WASD WALK · SHIFT RUN</small>
        </section>
      </div>}
      {status.kind !== "ready" && <div role="status" className="explore-loading">{describe(status)}</div>}
    </>
  );
}

const SENSITIVITY_KEY = "wtp:look-sensitivity";

function readSensitivity(): number {
  try {
    const stored = Number(localStorage.getItem(SENSITIVITY_KEY));
    if (Number.isFinite(stored) && stored > 0) return Math.min(3, Math.max(0.25, stored));
  } catch { /* private mode */ }
  return 1;
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
