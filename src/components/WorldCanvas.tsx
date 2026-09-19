import { useEffect, useRef, useState } from "react";
import { Viewer, type ViewerStatus } from "../viewer/Viewer";
import type { World } from "../worlds";
import { Hud } from "./Hud";

type Props = {
  world: World | null;
};

export function WorldCanvas({ world }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewerRef = useRef<Viewer | null>(null);
  const [status, setStatus] = useState<ViewerStatus>({ kind: "empty" });
  const [fps, setFps] = useState(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const viewer = new Viewer(canvas, { onStatus: setStatus, onFps: setFps });
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
    if (world) void viewerRef.current?.load(world);
  }, [world]);

  return (
    <div className="stage">
      <canvas ref={canvasRef} className="stage-canvas" />
      <Hud status={status} fps={fps} />
    </div>
  );
}
