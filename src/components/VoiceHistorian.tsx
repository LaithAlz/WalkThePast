import { useEffect, useRef, useState } from "react";
import { worlds } from "../lib/backend";
import type { EvidenceCounts, Verdict } from "../viewer/Viewer";
import { useRealtimeHistorian } from "../voice/useRealtimeHistorian";
import { enrichCaption, type HistoricalEntity } from "../historian/entities";
import type { GuideMood } from "../companion/Companion";

type Props = {
  world: { title: string; place: string; date: string; note: string; image: string; worldId?: string };
  evidence: boolean;
  counts: EvidenceCounts | null;
  verdict: Verdict | null;
  hue: "green" | "amber" | "purple";
  onEntity: (entity: HistoricalEntity) => void;
  onPresentationReady?: () => void | Promise<void>;
  captureCurrentView?: () => string | null;
  paused?: boolean;
  showMediaControls?: boolean;
  onQuizActiveChange?: (active: boolean) => void;
  /** Lifted so the guide standing in the world can act on what is being said. */
  onMood?: (mood: GuideMood) => void;
};

export function VoiceHistorian({ world, evidence, counts, verdict, hue, onEntity, onPresentationReady, captureCurrentView, paused = false, showMediaControls = false, onQuizActiveChange, onMood }: Props) {
  // Generated worlds carry the user's note, the world guide the scene was built from, and what the source was
  // in their manifest; the historian must speak about that, never about a stock example.
  const [manifestFacts, setManifestFacts] = useState<{ description?: string; guide?: string; sourceKind?: string }>({});
  // The session is not opened until these facts are in hand: the opening is written from
  // the metadata sent at connection time, so connecting first would welcome the visitor
  // to a world the historian knows nothing about.
  const [factsReady, setFactsReady] = useState(false);
  useEffect(() => {
    if (!world.worldId) { setManifestFacts({}); setFactsReady(true); return; }
    let stop = false;
    setFactsReady(false);
    fetch(worlds(`/worlds/${world.worldId}/world.json`), { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((m: { marble?: { prompt?: string | null; description?: string | null; painted?: boolean }; credit?: { photographer?: string } } | null) => {
        if (stop || !m) return;
        setManifestFacts({ description: m.marble?.description ?? undefined, guide: m.marble?.prompt ?? undefined, sourceKind: m.marble?.painted ? "photograph painted from the description" : m.credit?.photographer ?? undefined });
      })
      .catch(() => undefined)
      .finally(() => { if (!stop) setFactsReady(true); });
    return () => { stop = true; };
  }, [world.worldId]);
  // A generated world's card carries interface labels ("YOUR PHOTOGRAPH", "GENERATED WORLD")
  // where a sample world names its place. Those must never reach the historian as facts.
  const uiLabel = /^(your photograph|generated world|building|failed)$/i.test(world.place.trim());
  const voice = useRealtimeHistorian({
    world: {
      id: world.worldId ?? "unknown",
      title: world.title,
      place: uiLabel ? "" : world.place,
      date: world.date,
      description: uiLabel ? manifestFacts.description ?? "" : manifestFacts.description ? `${manifestFacts.description}. ${world.note}` : world.note,
      sourceImage: world.image,
      guide: manifestFacts.guide,
      sourceKind: manifestFacts.sourceKind,
    },
    evidenceEnabled: evidence,
    evidenceCounts: counts,
    verdict,
  }, { beforeFirstPlay: onPresentationReady, captureCurrentView });
  const { pause, resume, connect, cancelQuiz, setMicrophoneMuted } = voice;
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
  // Only a held Space counts as listening: the session sits in "listening" the
  // whole time it is connected, and a guide nodding at nothing is unnerving.
  const mood: GuideMood = voice.isPaused ? "idle"
    : voice.status === "speaking" ? "speaking"
      : voice.status === "thinking" || voice.status === "connecting" ? "thinking"
        : spaceHeld ? "listening" : "idle";
  useEffect(() => { onMood?.(mood); }, [mood, onMood]);
  useEffect(() => {
    if (voice.error) void onPresentationReady?.();
  }, [voice.error, onPresentationReady]);
  useEffect(() => {
    onQuizActiveChange?.(!!voice.quiz);
    return () => onQuizActiveChange?.(false);
  }, [voice.quiz, onQuizActiveChange]);
  useEffect(() => {
    if (paused) pause("detour");
    else resume("detour");
  }, [paused, pause, resume]);
  const autoConnected = useRef(false);
  useEffect(() => {
    if (!factsReady || autoConnected.current) return;
    autoConnected.current = true;
    const timer = window.setTimeout(() => { void connectRef.current(); }, 0);
    return () => window.clearTimeout(timer);
  }, [factsReady]);
  const keyboardState = useRef({ active, canToggleMic: voice.canToggleMic, isPaused: voice.isPaused });
  useEffect(() => { keyboardState.current = { active, canToggleMic: voice.canToggleMic, isPaused: voice.isPaused }; });
  useEffect(() => {
    const keyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (event.repeat || target?.matches("input, textarea, [contenteditable=true]")) return;
      // N holds the narration alone; the world keeps walking. N again picks it back up.
      if (event.code === "KeyN" && !event.altKey && !event.ctrlKey && !event.metaKey) {
        event.preventDefault();
        if (keyboardState.current.active) togglePlaybackRef.current();
        return;
      }
      if (event.code !== "Space") return;
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
  const togglePlaybackRef = useRef(voice.togglePlayback);
  useEffect(() => { togglePlaybackRef.current = voice.togglePlayback; }, [voice.togglePlayback]);
  const submitQuizAnswerRef = useRef(voice.submitQuizAnswer);
  useEffect(() => { submitQuizAnswerRef.current = voice.submitQuizAnswer; }, [voice.submitQuizAnswer]);
  useEffect(() => {
    // Answers are accepted while the historian is still reading the choices; only an unconnected or paused session blocks them.
    if (!voice.quiz || voice.quiz.selectedOption !== undefined || voice.status === "idle" || voice.status === "connecting" || voice.status === "error" || voice.isPaused) return;
    const answerWithLetter = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.matches("input, textarea, [contenteditable=true]") || event.altKey || event.ctrlKey || event.metaKey) return;
      const option = ["KeyA", "KeyB", "KeyC", "KeyD"].indexOf(event.code);
      if (option < 0) return;
      event.preventDefault();
      submitQuizAnswerRef.current(option);
    };
    window.addEventListener("keydown", answerWithLetter);
    return () => window.removeEventListener("keydown", answerWithLetter);
  }, [voice.quiz, voice.status, voice.isPaused]);
  useEffect(() => {
    if (!voice.quiz) return;
    const cancelWithEscape = (event: KeyboardEvent) => {
      if (event.code !== "Escape") return;
      event.preventDefault();
      cancelQuiz();
    };
    window.addEventListener("keydown", cancelWithEscape);
    return () => window.removeEventListener("keydown", cancelWithEscape);
  }, [voice.quiz, cancelQuiz]);

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
      {voice.quiz && <section className={`historian-quiz${voice.quiz.selectedOption !== undefined
        ? ` is-feedback ${voice.quiz.selectedOption === voice.quiz.correctOption ? "is-correct-feedback" : "is-wrong-feedback"}`
        : ""}`} aria-labelledby={`quiz-question-${voice.quiz.id}`}>
        <div className="historian-quiz-heading">
          <span>KNOWLEDGE CHECK</span>
          <div>
            <small>{voice.quiz.questionNumber} / {voice.quiz.totalQuestions}</small>
            <button type="button" onClick={cancelQuiz}>Cancel quiz</button>
          </div>
        </div>
        <h2 id={`quiz-question-${voice.quiz.id}`}>{voice.quiz.question}</h2>
        <div className="historian-quiz-options">
          {voice.quiz.options.map((option, index) => {
            const answered = voice.quiz?.selectedOption !== undefined;
            const selected = voice.quiz?.selectedOption === index;
            const correct = answered && voice.quiz?.correctOption === index;
            return <button
              type="button"
              key={`${voice.quiz?.id}-${index}`}
              className={`${selected ? "is-selected" : ""}${correct ? " is-correct" : ""}${selected && !correct ? " is-wrong" : ""}`}
              disabled={answered || voice.status === "idle" || voice.status === "connecting" || voice.status === "error" || voice.isPaused}
              onClick={() => voice.submitQuizAnswer(index)}
            >
              <b>{String.fromCharCode(65 + index)}</b><span>{option}</span>
            </button>;
          })}
        </div>
        {voice.quiz.selectedOption !== undefined && <p role="status">
          The correct answer is {String.fromCharCode(65 + voice.quiz.correctOption)}: {voice.quiz.options[voice.quiz.correctOption]}.
        </p>}
      </section>}
      <blockquote className={!voice.error && !voice.caption ? "is-empty" : undefined} aria-live="polite">
        {voice.error || captionParts.map((part, index) => part.entity ? (
          <button className={`caption-entity is-${part.entity.kind}`} type="button" key={`entity-${part.entity.id}-${index}`} onClick={() => onEntity(part.entity!)} title={`Explore ${part.entity.label}`}>
            {part.text}<span aria-hidden="true">{part.entity.coordinates ? "⌖" : "↗"}</span>
          </button>
        ) : <span className="voice-caption-word" key={`text-${index}`}>{part.text}</span>)}
      </blockquote>
      {voice.userCaption && <p className="voice-user-caption" aria-live="polite">YOU · {voice.userCaption}</p>}
      {voice.isTransportPaused && <p className="voice-paused-note" role="status">NARRATION PAUSED · press <kbd>N</kbd> to resume</p>}
    </div>
  );
}
