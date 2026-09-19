import { useEffect } from "react";
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
  paused?: boolean;
};

export function VoiceHistorian({ world, evidence, counts, verdict, hue, onEntity, paused = false }: Props) {
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
  });
  const { pause, resume } = voice;
  const active = voice.status !== "idle" && voice.status !== "error";
  const orbState = voice.status === "speaking" ? "speaking" : voice.status === "thinking" || voice.status === "connecting" ? "thinking" : active ? "listening" : "idle";
  const label = voice.status === "idle" ? "Start voice historian"
    : voice.status === "connecting" ? "Connecting"
      : voice.status === "listening" ? voice.isMicMuted ? "Mic muted" : "Listening"
        : voice.status === "thinking" ? "Historian thinking"
          : voice.status === "speaking" ? "Historian speaking"
            : "Reconnect historian";
  const captionParts = enrichCaption(voice.caption, voice.entities);
  useEffect(() => {
    if (paused) pause();
    else resume();
  }, [paused, pause, resume]);

  return (
    <div className="voice-historian">
      <span className={`voice-state is-${paused ? "paused" : voice.status}`}>{paused ? "Historian paused" : label}</span>
      <div className="voice-orb-controls">
        <button
          className="voice-side-button voice-rewind-button"
          type="button"
          onClick={voice.replayLastSentence}
          disabled={!active || !voice.canReplay || voice.status !== "listening"}
          aria-label="Repeat previous sentence"
          title="Repeat previous sentence"
        >
          <svg className="voice-replay-icon" aria-hidden="true" viewBox="0 0 24 24">
            <path d="M4 4v5h5" />
            <path d="M4.7 8.3A8.5 8.5 0 1 1 3.5 15" />
          </svg>
        </button>
        <button
          className="voice-side-button voice-session-button"
          type="button"
          onClick={() => { if (active) voice.disconnect(); else void voice.connect(); }}
          aria-label={active ? "Pause voice historian" : "Start voice historian"}
          title={active ? "Pause voice historian" : "Start voice historian"}
        >
          {active ? (
            <svg aria-hidden="true" viewBox="0 0 24 24">
              <rect x="7" y="5" width="3.5" height="14" rx="1" />
              <rect x="13.5" y="5" width="3.5" height="14" rx="1" />
            </svg>
          ) : (
            <svg aria-hidden="true" viewBox="0 0 24 24">
              <path d="M8 5.5v13l10-6.5z" />
            </svg>
          )}
        </button>
        <div className="voice-orb-button is-active" aria-hidden="true">
          <span className={`historian ${hue} is-${orbState}`} aria-hidden="true" />
        </div>
        <button
          className={`voice-side-button voice-mute-button${voice.isMicMuted ? " is-muted" : ""}`}
          type="button"
          onClick={voice.toggleMic}
          disabled={!active || !voice.canToggleMic}
          aria-pressed={voice.isMicMuted}
          aria-label={voice.isMicMuted ? "Turn microphone on" : "Turn microphone off"}
          title={!active ? "Start the historian first" : voice.canToggleMic ? voice.isMicMuted ? "Turn microphone on" : "Turn microphone off" : "Microphone unlocks after the introduction"}
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
        </button>
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
