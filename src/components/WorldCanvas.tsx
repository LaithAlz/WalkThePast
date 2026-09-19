import { useEffect, useRef, useState } from "react";
import { Viewer, type EvidenceCounts, type Verdict, type ViewerStatus } from "../viewer/Viewer";
import { PhotoTransition, type Mode } from "../viewer/transition";
import type { WorldManifest } from "../viewer/world";

type Props = {
  worldId: string;
  evidence: boolean;
  onCounts?: (counts: EvidenceCounts) => void;
  onVerdict?: (verdict: Verdict | null) => void;
  onMode?: (mode: Mode) => void;
};

/**
 * The stage is letterboxed to the photograph's aspect so the photo overlay and the
 * rendered view share the exact same frame: that is what makes the crossfade from
 * the photograph into the photographer's pose line up.
 */
export function WorldCanvas({ worldId, evidence, onCounts, onVerdict, onMode }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLImageElement>(null);
  const handleRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<Viewer | null>(null);
  const transitionRef = useRef<PhotoTransition | null>(null);
  const [status, setStatus] = useState<ViewerStatus>({ kind: "idle" });
  const [manifest, setManifest] = useState<WorldManifest | null>(null);
  const [mode, setMode] = useState<Mode>("photo");
  const [aspect, setAspect] = useState<number | null>(null);

  // Callbacks change identity every render; keep them in a ref so the viewer is
  // built once rather than torn down and rebuilt on each parent render.
  const sinks = useRef({ onCounts, onVerdict, onMode });
  useEffect(() => {
    sinks.current = { onCounts, onVerdict, onMode };
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
        setAspect(null);
        transition.showPhoto();
        viewer.setInteractive(false);
      },
      onCounts: (counts) => sinks.current.onCounts?.(counts),
      onVerdict: (verdict) => sinks.current.onVerdict?.(verdict),
    });
    transition.onMode = (m) => {
      setMode(m);
      viewer.setInteractive(m === "world");
      sinks.current.onMode?.(m);
    };
    viewerRef.current = viewer;
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
    viewerRef.current?.setEvidenceMode(evidence);
  }, [evidence]);

  const ready = status.kind === "ready";
  const enter = async () => {
    const t = transitionRef.current;
    if (!t || t.mode !== "photo" || status.kind !== "ready") return;
    viewerRef.current?.resetToPhotographer(false);
    await t.enterWorld();
  };

  // the photo is known once the viewer has measured it; letterbox the stage to it
  useEffect(() => {
    if (status.kind !== "ready") return;
    setAspect(viewerRef.current?.photoAspect ?? null);
    if (!manifest?.source?.image) void enter(); // nothing to fade from
  }, [status]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const host = hostRef.current;
    const stage = stageRef.current;
    if (!host || !stage) return;
    const fit = () => {
      const W = host.clientWidth, H = host.clientHeight;
      const a = aspect ?? W / H;
      let w = W, h = W / a;
      if (h > H) { h = H; w = H * a; }
      stage.style.width = `${Math.round(w)}px`;
      stage.style.height = `${Math.round(h)}px`;
      viewerRef.current?.resize();
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(host);
    return () => ro.disconnect();
  }, [aspect]);

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

  const credit = manifest?.credit ?? {};
  const meta = [credit.photographer, credit.year, credit.place].filter(Boolean).join(" · ");

  return (
    <div className="explore-host" ref={hostRef}>
      <div className="explore-stage" ref={stageRef}>
        <canvas ref={canvasRef} className="explore-canvas" />
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
          <div className="photo-landing">
            <div className="photo-card">
              <p className="eyebrow">THE PHOTOGRAPH</p>
              <h2>{credit.title ?? manifest.name}</h2>
              {meta && <p className="photo-meta">{meta}</p>}
              {credit.licence && <p className="photo-licence">{credit.licence}</p>}
              <button className="button" disabled={!ready} onClick={() => void enter()}>
                {ready ? "Walk into the photograph" : describe(status)}
              </button>
              <p className="photo-hint">ENTER ↵ · then drag to look, WASD to walk · hold TAB to see the photograph · V to wipe</p>
            </div>
          </div>
        )}
      </div>
      {status.kind !== "ready" && mode !== "photo" && <div className="explore-loading">{describe(status)}</div>}
    </div>
  );
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
