import { useCallback, useEffect, useRef, useState } from "react";
import { HISTORIAN_INSTRUCTIONS, HISTORIAN_TOOLS, runHistorianTool, sceneMetadata, type HistorianSceneContext } from "./historian";
import { isPlausibleEntityName, type HistoricalEntity } from "../historian/entities";
import { TimedNarrationPlayer } from "./TimedNarrationPlayer";
import { splitNarrationText } from "./narrationText";
import { api, authHeaders } from "../lib/backend";

export type VoiceStatus = "idle" | "connecting" | "listening" | "thinking" | "speaking" | "error";
type ResponseItem = {
  id?: string; type?: string; name?: string; call_id?: string; arguments?: string;
  content?: { type?: string; text?: string }[];
};
type ServerEvent = {
  type?: string; response_id?: string; item_id?: string; content_index?: number;
  delta?: string; text?: string; transcript?: string;
  error?: { message?: string }; name?: string; call_id?: string; arguments?: string;
  item?: ResponseItem;
  response?: { id?: string; status?: string; output?: ResponseItem[]; status_details?: { error?: { message?: string } } };
};
type TextPart = { received: string; pending: string; done: boolean };
export type HistorianQuiz = {
  id: string;
  question: string;
  options: [string, string, string, string];
  correctOption: number;
  explanation: string;
  questionNumber: number;
  totalQuestions: number;
  selectedOption?: number;
};

/** How long an ICE drop may last before the session is declared lost. */
const ICE_RECOVERY_MS = 8000;
/** Let the visitor answer before the guided narrative advances on its own. */
const GUIDED_PAUSE_MS = 7000;

export function useRealtimeHistorian(context: HistorianSceneContext, options: { beforeFirstPlay?: () => void | Promise<void>; captureCurrentView?: () => string | null } = {}) {
  const beforeFirstPlay = options.beforeFirstPlay;
  const captureCurrentViewRef = useRef(options.captureCurrentView);
  useEffect(() => { captureCurrentViewRef.current = options.captureCurrentView; }, [options.captureCurrentView]);
  const [status, setStatus] = useState<VoiceStatus>("idle");
  const [caption, setCaption] = useState("");
  const [userCaption, setUserCaption] = useState("");
  const [error, setError] = useState("");
  const [isMicMuted, setIsMicMuted] = useState(true);
  const [canToggleMic, setCanToggleMic] = useState(false);
  const [canReplay, setCanReplay] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [isTransportPaused, setIsTransportPaused] = useState(false);
  const [entities, setEntities] = useState<HistoricalEntity[]>([]);
  const [quiz, setQuiz] = useState<HistorianQuiz | null>(null);
  const contextRef = useRef(context);
  const peerRef = useRef<RTCPeerConnection | null>(null);
  const channelRef = useRef<RTCDataChannel | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const playerRef = useRef<TimedNarrationPlayer | null>(null);
  const connectionRef = useRef<AbortController | null>(null);
  const sessionGenerationRef = useRef(0);
  const connectingRef = useRef(false);
  const handledCalls = useRef(new Set<string>());
  const textPartsRef = useRef(new Map<string, TextPart>());
  const activeResponseRef = useRef<string | null>(null);
  const ignoredResponsesRef = useRef(new Set<string>());
  const responseRequestedRef = useRef(false);
  const cancelRequestedResponseRef = useRef(false);
  const toolContinuationRef = useRef(false);
  const userSpeakingRef = useRef(false);
  const userMutedRef = useRef(true);
  const pausedRef = useRef(false);
  const pauseReasonsRef = useRef(new Set<"transport" | "detour">());
  const recoveryTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const guidedPauseTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const quizRef = useRef<HistorianQuiz | null>(null);
  const holdRef = useRef(false); // push-to-talk key held
  /** instructions of the last requested response, re-sent on the continuation after tool calls */
  const lastInstructionsRef = useRef<string | undefined>(undefined);
  /** the last response.create payload, re-sent when the server was still busy with the previous one */
  const lastResponseRef = useRef<{ type: string; [key: string]: unknown } | null>(null);
  const createRetriesRef = useRef(0);
  /** true until the first words of the opening are queued, so they can be forced to start with Welcome */
  const openingPendingRef = useRef(false);
  /** a quiz card held back until the words spoken before it have been heard */
  const pendingQuizRef = useRef<HistorianQuiz | null>(null);
  /** the response that asked for the pending card; speech from any later reply reveals it */
  const pendingQuizResponseRef = useRef<string | null>(null);
  const spokeDuringHoldRef = useRef(false); // server VAD heard speech during this hold
  useEffect(() => { contextRef.current = context; }, [context]);

  const send = useCallback((event: { type: string; [key: string]: unknown }) => {
    const channel = channelRef.current;
    if (channel?.readyState === "open") {
      if (event.type === "response.create") {
        responseRequestedRef.current = true;
        lastResponseRef.current = event;
        const response = event.response as { instructions?: string; continuation?: boolean } | undefined;
        if (response?.continuation) {
          // Not an API field: it only marks a continuation so the original instructions are kept.
          const { continuation: _c, ...rest } = response;
          event = { ...event, response: rest };
        } else lastInstructionsRef.current = response?.instructions;
      }
      const payload = JSON.stringify(event);
      // SCTP drops the whole channel on an oversized message, so name the cause
      // rather than letting it surface as a generic event-channel failure.
      const limit = peerRef.current?.sctp?.maxMessageSize;
      if (limit && payload.length > limit) {
        console.error(`[historian] ${event.type} is ${payload.length} bytes, over the ${limit}-byte data channel limit`);
        return;
      }
      channel.send(payload);
    }
  }, []);

  const clearGuidedPause = useCallback(() => {
    clearTimeout(guidedPauseTimerRef.current);
    guidedPauseTimerRef.current = undefined;
  }, []);

  const scheduleGuidedContinuation = useCallback(() => {
    clearGuidedPause();
    // A held key means the visitor is about to speak: the tour must not talk over them,
    // and a continuation requested in that moment races their own turn and cancels it.
    if (quizRef.current || pausedRef.current || userSpeakingRef.current || holdRef.current || activeResponseRef.current || responseRequestedRef.current
      || channelRef.current?.readyState !== "open" || playerRef.current?.state !== "idle") return;
    guidedPauseTimerRef.current = setTimeout(() => {
      guidedPauseTimerRef.current = undefined;
      if (quizRef.current || pausedRef.current || userSpeakingRef.current || holdRef.current || activeResponseRef.current || responseRequestedRef.current
        || channelRef.current?.readyState !== "open" || playerRef.current?.state !== "idle") return;
      setStatus("thinking");
      send({
        type: "response.create",
        response: {
          output_modalities: ["text"],
          instructions: "The visitor has remained silent through the guided pause. Continue the historical tour with the most meaningful next topic; do not repeat the welcome or any introduction already given. Briefly connect it to the previous segment, add new historically grounded context, do not repeat yourself, and end with: Would you like me to quiz your understanding to fill in any gaps in your knowledge, or would you like me to keep explaining?",
        },
      });
    }, GUIDED_PAUSE_MS);
  }, [clearGuidedPause, send]);

  const interruptNarration = useCallback(() => {
    clearGuidedPause();
    if (responseRequestedRef.current) cancelRequestedResponseRef.current = true;
    const responseId = activeResponseRef.current;
    if (responseId) {
      ignoredResponsesRef.current.add(responseId);
      send({ type: "response.cancel", response_id: responseId });
    }
    activeResponseRef.current = null;
    toolContinuationRef.current = false;
    textPartsRef.current.clear();
    playerRef.current?.reset();
    setCanReplay(false);
    setCaption("");
  }, [clearGuidedPause, send]);

  const disconnect = useCallback(() => {
    // Fence setup, channel events, and pending audio requests before releasing resources.
    sessionGenerationRef.current += 1;
    connectionRef.current?.abort();
    connectionRef.current = null;
    connectingRef.current = false;
    clearTimeout(recoveryTimerRef.current);
    recoveryTimerRef.current = undefined;
    clearTimeout(guidedPauseTimerRef.current);
    guidedPauseTimerRef.current = undefined;
    const player = playerRef.current;
    playerRef.current = null;
    player?.dispose();
    channelRef.current?.close();
    peerRef.current?.close();
    streamRef.current?.getTracks().forEach((track) => { track.onended = null; track.stop(); });
    channelRef.current = null;
    peerRef.current = null;
    streamRef.current = null;
    handledCalls.current.clear();
    textPartsRef.current.clear();
    ignoredResponsesRef.current.clear();
    activeResponseRef.current = null;
    responseRequestedRef.current = false;
    cancelRequestedResponseRef.current = false;
    toolContinuationRef.current = false;
    userSpeakingRef.current = false;
    quizRef.current = null;
    userMutedRef.current = true;
    pausedRef.current = false;
    pauseReasonsRef.current.clear();
    setStatus("idle");
    setCaption("");
    setUserCaption("");
    setEntities([]);
    setQuiz(null);
    setIsMicMuted(true);
    setCanToggleMic(false);
    setCanReplay(false);
    setIsPaused(false);
    setIsTransportPaused(false);
  }, []);
  useEffect(() => disconnect, [disconnect]);

  const fail = useCallback((message: string) => {
    disconnect();
    setError(message);
    setStatus("error");
  }, [disconnect]);

  const replayLastSentence = useCallback(() => {
    if (pausedRef.current || activeResponseRef.current || responseRequestedRef.current || status !== "listening") return;
    if (playerRef.current?.replayLast()) setCanReplay(false);
  }, [status]);

  const setMicrophoneMuted = useCallback((nextMuted: boolean) => {
    if (!streamRef.current || (!nextMuted && pausedRef.current)) return;
    const tracks = streamRef.current.getAudioTracks().filter((track) => track.readyState === "live");
    if (!tracks.length) {
      setIsMicMuted(true);
      setCanToggleMic(false);
      setError("No live microphone track is available. Reconnect the historian.");
      return;
    }
    if (!nextMuted) {
      // Holding the key only holds the narration. It is cut off when the visitor actually speaks
      // (speech_started); a tap with nothing said resumes exactly where it was.
      holdRef.current = true;
      spokeDuringHoldRef.current = false;
      clearGuidedPause();
      playerRef.current?.pause();
      setStatus("listening");
    } else if (holdRef.current) {
      holdRef.current = false;
      // The hold is over either way. reset() keeps the player's paused flag on purpose, so
      // after the visitor spoke (which cut the narration) the player must be resumed here
      // or the historian's answer is queued into a paused player and never heard.
      if (!pausedRef.current) playerRef.current?.resume();
      if (!spokeDuringHoldRef.current) {
        if (playerRef.current?.state === "playing" || playerRef.current?.state === "buffering") setStatus("speaking");
        else scheduleGuidedContinuation();
      }
    }
    userMutedRef.current = nextMuted;
    tracks.forEach((track) => { track.enabled = !nextMuted && !pausedRef.current; });
    setIsMicMuted(nextMuted);
    if (nextMuted) {
      setUserCaption("");
      scheduleGuidedContinuation();
    }
  }, [interruptNarration, scheduleGuidedContinuation]);
  const toggleMic = useCallback(() => { setMicrophoneMuted(!userMutedRef.current); }, [setMicrophoneMuted]);

  const pause = useCallback((reason: "transport" | "detour" = "transport") => {
    clearGuidedPause();
    pauseReasonsRef.current.add(reason);
    if (reason === "transport") setIsTransportPaused(true);
    setIsPaused(true);
    if (pausedRef.current) return;
    pausedRef.current = true;
    playerRef.current?.pause();
    streamRef.current?.getAudioTracks().forEach((track) => { track.enabled = false; });
  }, [clearGuidedPause]);
  const resume = useCallback((reason: "transport" | "detour" = "transport") => {
    pauseReasonsRef.current.delete(reason);
    if (reason === "transport") setIsTransportPaused(false);
    if (pauseReasonsRef.current.size) return;
    setIsPaused(false);
    if (!pausedRef.current) return;
    pausedRef.current = false;
    playerRef.current?.resume();
    streamRef.current?.getAudioTracks().forEach((track) => { track.enabled = !userMutedRef.current; });
    scheduleGuidedContinuation();
  }, [scheduleGuidedContinuation]);
  const togglePlayback = useCallback(() => {
    if (pauseReasonsRef.current.has("transport")) resume("transport");
    else pause("transport");
  }, [pause, resume]);

  const answerTool = useCallback((event: ServerEvent) => {
    const call = event.item ?? event;
    const callId = call.call_id;
    if (!callId || handledCalls.current.has(callId)) return;
    handledCalls.current.add(callId);
    let args: Record<string, unknown> = {};
    try { args = JSON.parse(call.arguments || "{}"); } catch { args = {}; }
    let output: unknown;
    let capturedView: string | null = null;
    if (call.name === "inspectCurrentView") {
      try { capturedView = captureCurrentViewRef.current?.() ?? null; }
      catch (reason) { console.error("[historian] current-view capture failed", reason); }
      output = capturedView
        ? { status: "current_view_attached", instruction: "Analyze the input image in the next conversation item before answering." }
        : { status: "unavailable", message: "The current camera view could not be captured. Do not guess what is visible." };
    } else if (call.name === "presentQuizQuestion") {
      const nextQuiz = quizFromTool(callId, args);
      const shown = quizRef.current;
      if (nextQuiz && shown && shown.selectedOption === undefined && shown.questionNumber === nextQuiz.questionNumber) {
        // Asked for the same question twice: keep the card that is up and say so, otherwise
        // a model that repeats the call after each tool result never gets to speak.
        output = { status: "already_displayed", questionNumber: shown.questionNumber, totalQuestions: shown.totalQuestions, instruction: "Do not call presentQuizQuestion again. Say only that the question is on screen, then say exactly: You can answer now." };
      } else if (nextQuiz) {
        clearGuidedPause();
        quizRef.current = nextQuiz;
        // The call arrives the instant it is written, well before the lead-in has been
        // spoken. The card waits for the player to fall silent so the words come first.
        const state = playerRef.current?.state;
        if (state === "playing" || state === "buffering") {
          pendingQuizRef.current = nextQuiz;
          pendingQuizResponseRef.current = activeResponseRef.current;
        } else setQuiz(nextQuiz);
        output = { status: "question_displayed", questionNumber: nextQuiz.questionNumber, totalQuestions: nextQuiz.totalQuestions };
      } else output = { error: "invalid_quiz_question" };
    } else if (call.name === "recordQuizAnswer") {
      const selectedOption = args.selectedOption;
      const current = quizRef.current;
      if (current && typeof selectedOption === "number" && Number.isInteger(selectedOption) && selectedOption >= 0 && selectedOption <= 3) {
        const answered = { ...current, selectedOption };
        quizRef.current = answered;
        setQuiz(answered);
        output = {
          status: "answer_recorded",
          correct: selectedOption === current.correctOption,
          correctOption: current.correctOption,
          explanation: current.explanation,
          questionNumber: current.questionNumber,
          totalQuestions: current.totalQuestions,
        };
      } else output = { error: "no_active_quiz_question" };
    } else if (call.name === "linkHistoricalEntity") {
      const linked = historicalEntityFromTool(args);
      if (linked) setEntities((current) => [...current.filter((item) => item.label.toLocaleLowerCase() !== linked.label.toLocaleLowerCase()), linked]);
      output = runHistorianTool(call.name || "", args, contextRef.current);
    } else {
      output = runHistorianTool(call.name || "", args, contextRef.current);
    }
    send({ type: "conversation.item.create", item: { type: "function_call_output", call_id: callId, output: JSON.stringify(output) } });
    if (capturedView) {
      send({
        type: "conversation.item.create",
        item: {
          type: "message", role: "user",
          content: [
            { type: "input_image", image_url: capturedView },
            { type: "input_text", text: "This is the fresh still captured from my current camera view. Use it to answer my immediately preceding question." },
          ],
        },
      });
    }
    // Parallel tool calls cause one continuation after the originating response ends.
    toolContinuationRef.current = true;
  }, [clearGuidedPause, send]);

  const submitQuizAnswer = useCallback((selectedOption: number) => {
    const current = quizRef.current;
    if (!current || current.selectedOption !== undefined || !Number.isInteger(selectedOption)
      || selectedOption < 0 || selectedOption > 3 || channelRef.current?.readyState !== "open") return;
    // An answer can arrive while the historian is still reading the choices: stop that speech first,
    // then ask for the feedback. The cancel flag is reset so the feedback response is not cancelled too.
    interruptNarration();
    cancelRequestedResponseRef.current = false;
    responseRequestedRef.current = true;
    const answered = { ...current, selectedOption };
    quizRef.current = answered;
    pendingQuizRef.current = null;
    setQuiz(answered);
    // The verdict and the explanation were written with the question, so they are spoken
    // now, from here, instead of after another round trip to the model.
    const right = selectedOption === current.correctOption;
    playerRef.current?.enqueue(right ? `Correct. ${current.explanation}` : `Not quite. The answer is ${current.options[current.correctOption]}. ${current.explanation}`);
    setStatus("speaking");
    send({
      type: "conversation.item.create",
      item: {
        type: "message", role: "user",
        content: [{ type: "input_text", text: `Quiz answer: option ${selectedOption + 1}, "${current.options[selectedOption]}".` }],
      },
    });
    send({
      type: "response.create",
      response: {
        output_modalities: ["text"],
        instructions: `The visitor selected option ${selectedOption + 1}, "${current.options[selectedOption]}", which is ${right ? "correct" : "incorrect"}. The verdict and this explanation have already been spoken to the visitor: "${current.explanation}" Do not repeat either.${current.questionNumber < current.totalQuestions
          ? ` Add one or two sentences of historical colour that build on that explanation, then lead into the next question with a sentence and call presentQuizQuestion for question ${current.questionNumber + 1} of ${current.totalQuestions}. Do not read the question or its choices aloud: after the call, say only that the next question is on screen, then say exactly: "You can answer now."`
          : " That was the last question. Add one or two sentences that build on the explanation, briefly conclude the quiz, then make a natural transition: either move into the most relevant next historical subject, or ask whether the visitor would like to explore the current subject more deeply. Do not end with the standard pause sentence."}`,
      },
    });
  }, [interruptNarration, send]);

  const cancelQuiz = useCallback(() => {
    if (!quizRef.current) return;
    quizRef.current = null;
    setQuiz(null);
    interruptNarration();
    setUserCaption("");
    setStatus("thinking");
    send({
      type: "conversation.item.create",
      item: {
        type: "message", role: "user",
        content: [{ type: "input_text", text: "The visitor canceled the quiz. Do not continue it. Immediately acknowledge the cancellation and return to the normal historical conversation from before the quiz." }],
      },
    });
    send({
      type: "response.create",
      response: {
        output_modalities: ["text"],
        instructions: "The visitor just canceled the quiz. Begin with exactly: Let's jump back in where we left off. Then immediately resume the historical thread from before the quiz in a natural, concise way. Do not mention quiz questions, scores, or the cancellation again. Do not call presentQuizQuestion.",
      },
    });
  }, [interruptNarration, send]);

  const queueText = useCallback((event: ServerEvent, final: boolean) => {
    const key = (event.item_id ?? event.response_id) + ":" + (event.content_index ?? 0);
    const part = textPartsRef.current.get(key) ?? { received: "", pending: "", done: false };
    if (part.done) return;
    if (final && event.text !== undefined && !event.text.startsWith(part.received)) {
      throw new Error("The historian text changed while speech was being prepared. Please reconnect.");
    }
    const delta = final ? event.text?.slice(part.received.length) ?? "" : event.delta ?? "";
    part.received += delta;
    let text = part.pending + delta;
    if (openingPendingRef.current) {
      // Hold the first words back until there are enough to know how the opening starts.
      if (!final && part.received.length < 16) {
        part.pending = text;
        textPartsRef.current.set(key, part);
        return;
      }
      openingPendingRef.current = false;
      if (!/^\s*welcome/i.test(part.received)) {
        const world = contextRef.current.world;
        text = `Welcome to ${world.title || world.place}. ${text.trimStart()}`;
      }
    }
    const { clips, remainder } = splitNarrationText(text, final);
    part.pending = remainder;
    part.done = final;
    textPartsRef.current.set(key, part);
    for (const clip of clips) playerRef.current?.enqueue(clip, event.response_id);
  }, []);

  const handleEvent = useCallback((event: ServerEvent) => {
    const responseId = event.response_id ?? event.response?.id;
    if (import.meta.env.DEV && event.type !== "response.output_text.delta" && !event.type?.startsWith("input_audio_buffer") && !event.type?.includes("transcription")) {
      console.debug("[historian]", event.type, responseId ?? "", event.type === "response.done" ? event.response?.status : "", event.type === "response.function_call_arguments.done" ? event.name : "");
    }
    if (responseId && ignoredResponsesRef.current.has(responseId)) return;
    if (event.type?.startsWith("response.") && event.type !== "response.created" && responseId !== activeResponseRef.current) return;
    switch (event.type) {
      case "input_audio_buffer.speech_started":
        if (pausedRef.current) break;
        userSpeakingRef.current = true;
        spokeDuringHoldRef.current = true;
        interruptNarration();
        setStatus("listening");
        setUserCaption("Listening…");
        break;
      case "input_audio_buffer.speech_stopped":
        userSpeakingRef.current = false;
        // Whatever the server creates from here on is its answer to the visitor. A cancel
        // requested for a continuation the visitor talked over must not land on it.
        cancelRequestedResponseRef.current = false;
        if (!pausedRef.current) setStatus("thinking");
        break;
      case "conversation.item.input_audio_transcription.delta":
        setUserCaption((current) => (current === "Listening…" ? "" : current) + (event.delta || ""));
        break;
      case "conversation.item.input_audio_transcription.completed":
        setUserCaption(event.transcript || "");
        break;
      case "response.created":
        if (!responseId) break;
        clearGuidedPause();
        // A reply the server started itself, after the visitor spoke, owes nothing to the
        // last instructions this client sent; a continuation must not resurrect them.
        if (!responseRequestedRef.current) lastInstructionsRef.current = undefined;
        responseRequestedRef.current = false;
        createRetriesRef.current = 0;
        if (userSpeakingRef.current || cancelRequestedResponseRef.current) {
          cancelRequestedResponseRef.current = false;
          ignoredResponsesRef.current.add(responseId);
          send({ type: "response.cancel", response_id: responseId });
          break;
        }
        activeResponseRef.current = responseId;
        textPartsRef.current.clear();
        setCanReplay(false);
        if (playerRef.current?.state !== "playing") setStatus("thinking");
        break;
      case "response.output_text.delta":
        queueText(event, false);
        break;
      case "response.output_text.done":
        queueText(event, true);
        break;
      case "response.function_call_arguments.done":
        answerTool(event);
        break;
      case "response.done": {
        activeResponseRef.current = null;
        if (event.response?.status === "failed") {
          fail(event.response.status_details?.error?.message || "The historian could not finish its response.");
          break;
        }
        if (event.response?.status === "cancelled" || event.response?.status === "incomplete") {
          interruptNarration();
          setStatus("listening");
          break;
        }
        for (const item of event.response?.output ?? []) {
          if (item.type === "function_call") answerTool({ item });
          item.content?.forEach((part, index) => {
            if (part.type === "output_text" || part.type === "text") queueText({ response_id: responseId, item_id: item.id, content_index: index, text: part.text }, true);
          });
        }
        if (toolContinuationRef.current) {
          toolContinuationRef.current = false;
          // The reply that called the tools was asked for something specific (the welcome, the
          // next quiz question); without repeating that here the model answers the tools instead.
          const carried = lastInstructionsRef.current;
          const followUp = "Every tool named above has already been called and answered; do not call any of them again for the same thing. A quiz question that is displayed is on screen already. Now speak the reply itself, in full.";
          send({ type: "response.create", response: { output_modalities: ["text"], continuation: true, instructions: carried ? `${carried}\n\n${followUp}` : followUp } });
        } else {
          // Network generation completion is independent of local playback completion.
          playerRef.current?.finish();
          if (playerRef.current?.state === "idle") setStatus("listening");
        }
        break;
      }
      case "error": {
        // Cancelling a response that already finished is a race, not a failure: the server answers
        // "Cancellation failed: no active response found". Tearing the session down for it would
        // end the tour every time the visitor speaks just as the historian stops.
        const message = event.error?.message || "Realtime voice error";
        const code = (event.error as { code?: string } | undefined)?.code ?? "";
        if (code === "response_cancel_not_active" || /no active response/i.test(message)) { console.warn("[historian] ignored:", message); break; }
        // A reply asked for while the previous one was still being cancelled (a quiz answer
        // given mid-sentence) is refused, not queued. Ask again shortly instead of ending the tour.
        if ((code === "conversation_already_has_active_response" || /already has an active response/i.test(message)) && lastResponseRef.current && createRetriesRef.current < 5) {
          createRetriesRef.current += 1;
          const again = lastResponseRef.current;
          setTimeout(() => { if (channelRef.current?.readyState === "open" && !activeResponseRef.current) send(again); }, 400);
          break;
        }
        fail(message);
        break;
      }
    }
  }, [answerTool, clearGuidedPause, fail, interruptNarration, queueText, send]);

  const connect = useCallback(async () => {
    if (connectingRef.current || channelRef.current?.readyState === "open") return;
    const pauseReasons = new Set(pauseReasonsRef.current);
    disconnect();
    pauseReasonsRef.current = pauseReasons;
    pausedRef.current = pauseReasons.size > 0;
    setIsPaused(pausedRef.current);
    setIsTransportPaused(pauseReasons.has("transport"));
    connectingRef.current = true;
    const generation = sessionGenerationRef.current;
    const controller = new AbortController();
    connectionRef.current = controller;
    const current = () => generation === sessionGenerationRef.current && !controller.signal.aborted;
    setStatus("connecting");
    setError("");
    try {
      const player = new TimedNarrationPlayer({
        load: async (text, signal) => {
          const response = await fetch(api("/api/realtime/narration"), {
            method: "POST", signal, headers: { "Content-Type": "application/json", ...(await authHeaders()) }, body: JSON.stringify({ text }),
          });
          if (!response.ok) throw new Error((await response.json().catch(() => null))?.error || "Could not prepare synchronized speech.");
          return response.json();
        },
        onCaption: (text) => {
          if (!current()) return;
          setCaption(text);
          // The sentence that points at the card is the moment the card should be there.
          if (pendingQuizRef.current && /on screen|answer now/i.test(text) && quizRef.current?.id === pendingQuizRef.current.id) {
            setQuiz(pendingQuizRef.current);
            pendingQuizRef.current = null;
          }
        },
        beforeFirstPlay,
        onState: (state) => {
          if (!current()) return;
          if (state !== "idle") setStatus(state === "playing" ? "speaking" : "thinking");
          else if (pendingQuizRef.current && quizRef.current?.id === pendingQuizRef.current.id) {
            setQuiz(pendingQuizRef.current);
            pendingQuizRef.current = null;
          }
        },
        onReplayAvailable: (available) => { if (current()) setCanReplay(available); },
        onClipStart: (tag) => {
          // The first words of the reply that follows the card's tool call are the cue.
          const pending = pendingQuizRef.current;
          if (!current() || !pending || quizRef.current?.id !== pending.id) return;
          if (tag && tag !== pendingQuizResponseRef.current) {
            setQuiz(pending);
            pendingQuizRef.current = null;
          }
        },
        onComplete: () => {
          if (!current() || activeResponseRef.current || responseRequestedRef.current || toolContinuationRef.current) return;
          setStatus("listening");
          setCanReplay(player.canReplay);
          const activeQuiz = quizRef.current;
          if (activeQuiz && activeQuiz.selectedOption === undefined) return;
          if (activeQuiz) {
            quizRef.current = null;
            setQuiz(null);
            if (activeQuiz.questionNumber < activeQuiz.totalQuestions) {
              setStatus("thinking");
              send({
                type: "response.create",
                response: {
                  output_modalities: ["text"],
                  instructions: `The spoken feedback for question ${activeQuiz.questionNumber} has finished. Lead into the next question with a sentence and call presentQuizQuestion for question ${activeQuiz.questionNumber + 1} of ${activeQuiz.totalQuestions}. Do not read the question or its choices aloud: after the call, say only that it is on screen, then say exactly: "You can answer now." Do not repeat the previous feedback.`,
                },
              });
              return;
            }
            scheduleGuidedContinuation();
            return;
          }
          scheduleGuidedContinuation();
        },
        onError: (reason) => { if (current()) fail(reason.message); },
      });
      playerRef.current = player;
      if (pausedRef.current) player.pause();
      const [tokenResponse, imageResponse] = await Promise.all([
        fetch(api("/api/realtime/session"), { method: "POST", signal: controller.signal, headers: await authHeaders() }),
        fetch(contextRef.current.world.sourceImage, { signal: controller.signal }),
      ]);
      if (!current()) return;
      if (!tokenResponse.ok) throw new Error((await tokenResponse.json().catch(() => null))?.error || "Could not create a voice session");
      const tokenData = await tokenResponse.json() as { value?: string; client_secret?: { value?: string } };
      const ephemeralKey = tokenData.value ?? tokenData.client_secret?.value;
      if (!ephemeralKey) throw new Error("The voice session did not return a client credential");
      // A painted world keeps its source as source.png, and older library entries still
      // point at source.jpg; try the other name before going on without a picture. The
      // guide and metadata carry the tour either way, so a missing image is not fatal.
      let imageBlob: Blob | null = imageResponse.ok ? await imageResponse.blob() : null;
      if (!imageBlob) {
        const other = contextRef.current.world.sourceImage.replace(/source\.(jpe?g|png)(\?.*)?$/i, (_m, ext: string) => (/^jpe?g$/i.test(ext) ? "source.png" : "source.jpg"));
        if (other !== contextRef.current.world.sourceImage) {
          const retry = await fetch(other, { signal: controller.signal }).catch(() => null);
          if (retry?.ok) imageBlob = await retry.blob();
        }
        if (!imageBlob) console.warn("[historian] source image unavailable; continuing with metadata only");
      }
      const imageDataUrl = imageBlob ? await imageToDataUrl(imageBlob) : null;
      if (!current()) return;
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!current()) { stream.getTracks().forEach((track) => track.stop()); return; }
      streamRef.current = stream;
      setCanToggleMic(true);
      stream.getAudioTracks().forEach((track) => {
        track.enabled = false;
        track.onended = () => { if (current()) fail("Microphone access ended. Reconnect the historian to speak again."); };
      });
      const peer = new RTCPeerConnection();
      peerRef.current = peer;
      // WebRTC carries the microphone. Never autoplay independent remote audio.
      stream.getTracks().forEach((track) => peer.addTrack(track, stream));
      // "disconnected" is routinely transient: a network hop, or the tab being
      // throttled while the pause menu is up. Tearing the session down on it
      // loses a conversation that would have come back on its own, so only
      // "failed" is terminal and a drop gets a window to recover first.
      peer.onconnectionstatechange = () => {
        if (!current()) return;
        const state = peer.connectionState;
        if (state !== "disconnected") {
          clearTimeout(recoveryTimerRef.current);
          recoveryTimerRef.current = undefined;
        }
        if (state === "failed") fail("Voice connection lost. Tap to reconnect.");
        else if (state === "disconnected" && recoveryTimerRef.current === undefined) {
          recoveryTimerRef.current = setTimeout(() => {
            recoveryTimerRef.current = undefined;
            if (current() && peer.connectionState === "disconnected") fail("Voice connection lost. Tap to reconnect.");
          }, ICE_RECOVERY_MS);
        }
      };
      const channel = peer.createDataChannel("oai-events");
      channelRef.current = channel;
      channel.onmessage = (message) => {
        if (!current()) return;
        try { handleEvent(JSON.parse(message.data) as ServerEvent); }
        catch (reason) { fail(reason instanceof Error ? reason.message : "Invalid historian event."); }
      };
      channel.onerror = () => { if (current()) fail("Voice event channel failed."); };
      channel.onclose = () => { if (current()) fail("Voice connection closed. Tap to reconnect."); };
      channel.onopen = () => {
        if (!current()) return;
        connectingRef.current = false;
        openingPendingRef.current = true;
        setStatus("thinking");
        send({
          type: "session.update",
          session: { type: "realtime", output_modalities: ["text"], instructions: HISTORIAN_INSTRUCTIONS + "\nYour text will be spoken aloud. Return plain spoken prose without Markdown formatting.", tools: HISTORIAN_TOOLS, tool_choice: "auto" },
        });
        send({
          type: "conversation.item.create",
          item: {
            type: "message", role: "user",
            content: [
              ...(imageDataUrl ? [{ type: "input_image", image_url: imageDataUrl }] : []),
              { type: "input_text", text: (imageDataUrl ? "Here is the source image and metadata for the world I just entered: " : "Here is the metadata for the world I just entered (its picture could not be attached): ") + sceneMetadata(contextRef.current) },
            ],
          },
        });
        send({
          type: "response.create",
          response: {
            output_modalities: ["text"],
            instructions: "Give the historical opening now. Begin with the words \"Welcome to\" followed by the place's own name. Sound like an expert public historian, name the actual place and period from the world metadata you were just given (title, place, date, description and world guide; if those are vague, infer them from the source image and say so), lead with established facts about that place and time, and establish the first meaningful thread of a guided tour. Never talk about a different place than the one in the metadata. Do not mention the image, reconstruction, technology, provenance, or source limitations in this opening. End with: Would you like me to quiz your understanding to fill in any gaps in your knowledge, or would you like me to keep explaining?",
          },
        });
      };
      const offer = await peer.createOffer();
      if (!current()) return;
      await peer.setLocalDescription(offer);
      const answerResponse = await fetch("https://api.openai.com/v1/realtime/calls", {
        method: "POST", body: offer.sdp, signal: controller.signal,
        headers: { Authorization: "Bearer " + ephemeralKey, "Content-Type": "application/sdp" },
      });
      const answerBody = await answerResponse.text();
      if (!current()) return;
      if (!answerResponse.ok) {
        let detail = "";
        try { detail = (JSON.parse(answerBody) as { error?: { message?: string } }).error?.message ?? ""; } catch { /* Use status below. */ }
        throw new Error(detail || "WebRTC setup failed (" + answerResponse.status + ")");
      }
      await peer.setRemoteDescription({ type: "answer", sdp: answerBody });
    } catch (reason) {
      if (current()) fail(reason instanceof Error ? reason.message : "Unable to start voice");
    }
  }, [beforeFirstPlay, disconnect, fail, handleEvent, scheduleGuidedContinuation, send]);

  return { status, caption, userCaption, error, entities, quiz, isMicMuted, canToggleMic, canReplay, isPaused, isTransportPaused, replayLastSentence, submitQuizAnswer, cancelQuiz, setMicrophoneMuted, toggleMic, togglePlayback, connect, disconnect, pause, resume };
}

function quizFromTool(id: string, args: Record<string, unknown>): HistorianQuiz | null {
  const question = typeof args.question === "string" ? args.question.trim() : "";
  const explanation = typeof args.explanation === "string" ? args.explanation.trim() : "";
  const options = Array.isArray(args.options) ? args.options.map((option) => typeof option === "string" ? option.trim() : "") : [];
  const correctOption = args.correctOption;
  const questionNumber = args.questionNumber;
  const totalQuestions = args.totalQuestions;
  if (!question || !explanation || options.length !== 4 || options.some((option) => !option)
    || new Set(options.map((option) => option.toLocaleLowerCase())).size !== 4
    || typeof correctOption !== "number" || !Number.isInteger(correctOption) || correctOption < 0 || correctOption > 3
    || typeof questionNumber !== "number" || !Number.isInteger(questionNumber) || questionNumber < 1
    || typeof totalQuestions !== "number" || !Number.isInteger(totalQuestions) || totalQuestions < questionNumber || totalQuestions > 10) return null;
  return { id, question, options: options as HistorianQuiz["options"], correctOption, explanation, questionNumber, totalQuestions };
}

function historicalEntityFromTool(args: Record<string, unknown>): HistoricalEntity | null {
  const label = typeof args.label === "string" ? args.label.trim() : "";
  const summary = typeof args.summary === "string" ? args.summary.trim() : "";
  const kind = args.kind;
  if (!isPlausibleEntityName(label) || !summary || (kind !== "place" && kind !== "site" && kind !== "person" && kind !== "period")) return null;
  let articleUrl: URL;
  try { articleUrl = new URL(String(args.articleUrl)); } catch { return null; }
  if (articleUrl.protocol !== "https:" || !/(^|\.)wikipedia\.org$/i.test(articleUrl.hostname)) return null;
  const longitude = typeof args.longitude === "number" && args.longitude >= -180 && args.longitude <= 180 ? args.longitude : null;
  const latitude = typeof args.latitude === "number" && args.latitude >= -90 && args.latitude <= 90 ? args.latitude : null;
  return {
    id: `agent-${label.toLocaleLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
    label,
    kind,
    articleUrl: articleUrl.href,
    summary,
    coordinates: longitude !== null && latitude !== null ? [longitude, latitude] : undefined,
  };
}

/** Shrink the source plate before it goes down the data channel.
 *
 * The historian is sent the photograph as a base64 data URL in a single
 * RTCDataChannel message, and SCTP caps a message at `maxMessageSize` — commonly
 * 256KB, which Safari enforces strictly. A full-resolution scan blows straight
 * past that: the Versailles photochrom is 6MB on disk, about 8.3MB once base64
 * encoded, and the send throws "Error sending string through RTCDataChannel",
 * which surfaces as a dead event channel rather than an obviously oversized
 * payload. A long side of 768px is ample for vision and lands well under the cap.
 */
async function imageToDataUrl(blob: Blob, maxSide = 768, quality = 0.72): Promise<string> {
  try {
    const bitmap = await createImageBitmap(blob);
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
    if (scale === 1 && blob.size < 96_000) { bitmap.close?.(); return blobToDataUrl(blob); }
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) { bitmap.close?.(); return blobToDataUrl(blob); }
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close?.();
    return canvas.toDataURL("image/jpeg", quality);
  } catch {
    return blobToDataUrl(blob); // no bitmap decode: better an oversized try than none
  }
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}
