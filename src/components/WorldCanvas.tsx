import { useEffect, useRef, useState } from "react";
import { Viewer, type EvidenceCounts, type Verdict, type ViewerStatus } from "../viewer/Viewer";
import { PhotoTransition, type Mode } from "../viewer/transition";
import type { WorldManifest } from "../viewer/world";

type Props = {
  worldId: string;
  evidence: boolean;
  autoEnter?: boolean;
  onCounts?: (counts: EvidenceCounts) => void;
  onVerdict?: (verdict: Verdict | null) => void;
  onMode?: (mode: Mode) => void;
  onReady?: (ready: boolean) => void;
  suspended?: boolean;
  onSnapshot?: (dataUrl: string) => void;
};

export function WorldCanvas({ worldId, evidence, autoEnter = false, onCounts, onVerdict, onMode, onReady, suspended = false, onSnapshot }: Props) {
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLImageElement>(null);
  const handleRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<Viewer | null>(null);
  const transitionRef = useRef<PhotoTransition | null>(null);
  const [status, setStatus] = useState<ViewerStatus>({ kind: "idle" });
  const [manifest, setManifest] = useState<WorldManifest | null>(null);
  const [mode, setMode] = useState<Mode>("photo");

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
    onReady?.(status.kind === "ready");
  }, [status, onReady]);

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
  const enter = async () => {
    const t = transitionRef.current;
    if (!t || t.mode !== "photo" || status.kind !== "ready") return;
    viewerRef.current?.resetToPhotographer(false);
    await t.enterWorld();
  };

  useEffect(() => {
    if (status.kind !== "ready") return;
    if (autoEnter || !manifest?.source?.image) void enter(); // preview routes skip the photo landing
  }, [status]); // eslint-disable-line react-hooks/exhaustive-deps

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
    <div className="explore-host">
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
      {status.kind !== "ready" && (mode !== "photo" || status.kind === "error") && <div className={`explore-loading${status.kind === "error" ? " is-error" : ""}`}>{describe(status)}</div>}
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
