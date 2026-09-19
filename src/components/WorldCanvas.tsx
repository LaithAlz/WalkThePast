import { useEffect, useRef, useState } from "react";
import { Viewer, type EvidenceCounts, type Verdict, type ViewerStatus } from "../viewer/Viewer";

type Props = {
  worldId: string;
  evidence: boolean;
  onCounts?: (counts: EvidenceCounts) => void;
  onVerdict?: (verdict: Verdict | null) => void;
};

export function WorldCanvas({ worldId, evidence, onCounts, onVerdict }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewerRef = useRef<Viewer | null>(null);
  const [status, setStatus] = useState<ViewerStatus>({ kind: "idle" });

  // Callbacks change identity every render; keep them in a ref so the viewer is
  // built once rather than torn down and rebuilt on each parent render.
  const sinks = useRef({ onCounts, onVerdict });
  useEffect(() => {
    sinks.current = { onCounts, onVerdict };
  });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const viewer = new Viewer(canvas, {
      onStatus: setStatus,
      onCounts: (counts) => sinks.current.onCounts?.(counts),
      onVerdict: (verdict) => sinks.current.onVerdict?.(verdict),
    });
    viewerRef.current = viewer;
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

  return (
    <>
      <canvas ref={canvasRef} className="explore-canvas" />
      {status.kind !== "ready" && <div className="explore-loading">{describe(status)}</div>}
    </>
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
