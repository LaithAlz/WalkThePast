import type { ViewerStatus } from "../viewer/Viewer";

type Props = {
  status: ViewerStatus;
  fps: number;
};

export function Hud({ status, fps }: Props) {
  return (
    <div className="hud">
      <div className="hud-row">
        <span className="hud-title">Walk the Past</span>
        <span className={fpsClass(fps)}>{fps} fps</span>
      </div>
      <div className="hud-status">{describe(status)}</div>
      <div className="hud-hint">WASD / arrows to move · drag to look</div>
    </div>
  );
}

function describe(status: ViewerStatus): string {
  switch (status.kind) {
    case "empty":
      return "No world loaded — add a Marble export to src/worlds.ts or pass ?splat=<url>";
    case "loading":
      return `Loading ${status.world.title}… ${Math.round(status.progress * 100)}%`;
    case "ready":
      return `${status.world.title} · ${status.splats.toLocaleString()} splats`;
    case "error":
      return `Failed to load ${status.world.title}: ${status.message}`;
  }
}

// Phase 0's exit gate is a frame rate, so make a bad one impossible to miss.
function fpsClass(fps: number): string {
  if (fps === 0) return "hud-fps";
  if (fps < 30) return "hud-fps hud-fps-bad";
  if (fps < 55) return "hud-fps hud-fps-warn";
  return "hud-fps hud-fps-good";
}
