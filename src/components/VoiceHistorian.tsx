import { useEffect, useRef, useState } from "react";
import type { EvidenceCounts, Verdict } from "../viewer/Viewer";
import { useRealtimeHistorian } from "../voice/useRealtimeHistorian";
import { enrichCaption, type HistoricalEntity } from "../historian/entities";

type Props = {
  world: { title: string; place: string; date: string; note: string; image: string; worldId?: string };
  evidence: boolean;
  counts: EvidenceCounts | null;
  verdict: Verdict | null;
  hue: "green" | "amber" | "purple";
  onEntity: (entity: HistoricalEntity) => void;
  onPresentationReady?: () => void | Promise<void>;
  paused?: boolean;
  showMediaControls?: boolean;
};

export function VoiceHistorian({ world, evidence, counts, verdict, hue, onEntity, onPresentationReady, paused = false, showMediaControls = false }: Props) {
  const voice = useRealtimeHistorian({
    world: {
      id: world.worldId ?? "unknown",
      title: world.title,
      place: world.place,
      date: world.date,
      description: world.note,
      sourceImage: world.image,
    },
    evidenceEnabled: evidence,
    evidenceCounts: counts,
    verdict,
  }, { beforeFirstPlay: onPresentationReady });
  const { pause, resume, connect, setMicrophoneMuted } = voice;
  const connectRef = useRef(connect);
  useEffect(() => { connectRef.current = connect; }, [connect]);
  const [spaceHeld, setSpaceHeld] = useState(false);
  const spaceHeldRef = useRef(false);
  const active = voice.status !== "idle" && voice.status !== "error";
  const orbState = voice.isPaused ? "paused" : voice.status === "speaking" ? "speaking" : voice.status === "thinking" || voice.status === "connecting" ? "thinking" : active ? "listening" : "idle";
  const label = voice.status === "idle" ? "Start voice historian"
    : voice.status === "connecting" ? "Connecting"
      : voice.status === "listening" ? voice.isMicMuted ? "Mic muted" : "Listening"
        : voice.status === "thinking" ? "Historian thinking"
          : voice.status === "speaking" ? "Historian speaking"
            : "Reconnect historian";
  const captionParts = enrichCaption(voice.caption, voice.entities);
  useEffect(() => {
    if (voice.error) void onPresentationReady?.();
  }, [voice.error, onPresentationReady]);
  useEffect(() => {
    if (paused) pause("detour");
    else resume("detour");
  }, [paused, pause, resume]);
  useEffect(() => {
    const timer = window.setTimeout(() => { void connectRef.current(); }, 0);
    return () => window.clearTimeout(timer);
  }, []);
  const keyboardState = useRef({ active, canToggleMic: voice.canToggleMic, isPaused: voice.isPaused });
  useEffect(() => { keyboardState.current = { active, canToggleMic: voice.canToggleMic, isPaused: voice.isPaused }; });
  useEffect(() => {
    const keyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (event.code !== "Space" || event.repeat || target?.matches("input, textarea, [contenteditable=true]")) return;
      event.preventDefault();
      if (keyboardState.current.isPaused) return;
      spaceHeldRef.current = true;
      setSpaceHeld(true);
      if (keyboardState.current.active && keyboardState.current.canToggleMic) setMicrophoneMuted(false);
      else void connect().then(() => setMicrophoneMuted(!spaceHeldRef.current));
    };
    const release = () => {
      spaceHeldRef.current = false;
      setSpaceHeld(false);
      setMicrophoneMuted(true);
    };
    const keyUp = (event: KeyboardEvent) => {
      if (event.code !== "Space") return;
      event.preventDefault();
      release();
    };
    window.addEventListener("keydown", keyDown);
    window.addEventListener("keyup", keyUp);
    window.addEventListener("blur", release);
    return () => {
      window.removeEventListener("keydown", keyDown);
      window.removeEventListener("keyup", keyUp);
      window.removeEventListener("blur", release);
    };
  }, [connect, setMicrophoneMuted]);

  return (
    <div className={`voice-historian${showMediaControls ? " has-media-controls" : ""}`}>
      <span className={`voice-state is-${voice.isPaused ? "paused" : voice.status}`}>{voice.isPaused ? "Historian paused" : label}</span>
      <div className="voice-orb-controls">
        {showMediaControls && <button
          className="voice-side-button voice-rewind-button"
          type="button"
          onClick={voice.replayLastSentence}
          disabled={!active || voice.isPaused || !voice.canReplay || voice.status !== "listening"}
          aria-label="Repeat previous sentence"
          title="Repeat previous sentence"
        >
          <svg className="voice-replay-icon" aria-hidden="true" viewBox="0 0 24 24">
            <path d="M4 4v5h5" />
            <path d="M4.7 8.3A8.5 8.5 0 1 1 3.5 15" />
          </svg>
        </button>}
        {showMediaControls && <button
          className="voice-side-button voice-session-button"
          type="button"
          onClick={() => { if (!active) void voice.connect(); else voice.togglePlayback(); }}
          aria-label={!active ? "Start voice historian" : voice.isTransportPaused ? "Resume voice historian" : "Pause voice historian"}
          title={!active ? "Start voice historian" : voice.isTransportPaused ? "Resume voice historian" : "Pause voice historian"}
        >
          {active && !voice.isTransportPaused ? (
            <svg aria-hidden="true" viewBox="0 0 24 24">
              <rect x="7" y="5" width="3.5" height="14" rx="1" />
              <rect x="13.5" y="5" width="3.5" height="14" rx="1" />
            </svg>
          ) : (
            <svg aria-hidden="true" viewBox="0 0 24 24">
              <path d="M8 5.5v13l10-6.5z" />
            </svg>
          )}
        </button>}
        <button
          className={`voice-orb-button${spaceHeld ? " is-space-held" : ""}`}
          type="button"
          onClick={() => { if (!active) void voice.connect(); else voice.togglePlayback(); }}
          onKeyDown={(event) => { if (event.code === "Space" || event.code === "Enter") event.stopPropagation(); }}
          onKeyUp={(event) => {
            // Let an ongoing push-to-talk release reach the microphone handler.
            if (event.code === "Enter" || (event.code === "Space" && !spaceHeldRef.current)) event.stopPropagation();
          }}
          aria-label={!active ? "Start voice historian" : voice.isTransportPaused ? "Resume voice historian" : "Pause voice historian"}
          title={!active ? "Start voice historian" : voice.isTransportPaused ? "Resume voice historian" : "Pause voice historian"}
        >
          <span className={`historian ${hue} is-${orbState}`} aria-hidden="true" />
        </button>
        {showMediaControls && <button
          className={`voice-side-button voice-mute-button${voice.isMicMuted ? " is-muted" : ""}`}
          type="button"
          onClick={() => { if (active) voice.toggleMic(); else void voice.connect().then(voice.toggleMic); }}
          disabled={active && !voice.canToggleMic}
          aria-pressed={voice.isMicMuted}
          aria-label={voice.isMicMuted ? "Turn microphone on" : "Turn microphone off"}
          title={!active ? "Start historian with microphone" : voice.canToggleMic ? voice.isMicMuted ? "Turn microphone on and pause narration" : "Turn microphone off" : "Waiting for microphone access"}
        >
          {voice.isMicMuted ? (
            <svg aria-hidden="true" viewBox="0 0 24 24">
              <rect x="9" y="3" width="6" height="11" rx="3" />
              <path d="M6.5 11.5a5.5 5.5 0 0 0 11 0M12 17v4M9 21h6" />
              <path className="voice-mute-slash" d="M4 4l16 16" />
            </svg>
          ) : (
            <svg aria-hidden="true" viewBox="0 0 24 24">
              <rect x="9" y="3" width="6" height="11" rx="3" />
              <path d="M6.5 11.5a5.5 5.5 0 0 0 11 0M12 17v4M9 21h6" />
            </svg>
          )}
          <span className="visually-hidden">{voice.isMicMuted ? "Unmute mic" : "Mute mic"}</span>
        </button>}
      </div>
      <blockquote className={!voice.error && !voice.caption ? "is-empty" : undefined} aria-live="polite">
        {voice.error || captionParts.map((part, index) => part.entity ? (
          <button className={`caption-entity is-${part.entity.kind}`} type="button" key={`entity-${part.entity.id}-${index}`} onClick={() => onEntity(part.entity!)} title={`Explore ${part.entity.label}`}>
            {part.text}<span aria-hidden="true">{part.entity.coordinates ? "⌖" : "↗"}</span>
          </button>
        ) : <span className="voice-caption-word" key={`text-${index}`}>{part.text}</span>)}
      </blockquote>
      {voice.userCaption && <p className="voice-user-caption" aria-live="polite">YOU · {voice.userCaption}</p>}
    </div>
  );
}
