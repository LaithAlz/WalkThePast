import { useCallback, useEffect, useRef, useState } from "react";
import { HISTORIAN_INSTRUCTIONS, HISTORIAN_TOOLS, runHistorianTool, sceneMetadata, type HistorianSceneContext } from "./historian";
import type { HistoricalEntity } from "../historian/entities";

export type VoiceStatus = "idle" | "connecting" | "listening" | "thinking" | "speaking" | "error";

const CAPTION_WORDS_PER_CARD = 14;
const CAPTION_WORD_INTERVAL_MS = 256;

type ServerEvent = {
  type?: string;
  delta?: string;
  transcript?: string;
  error?: { message?: string };
  name?: string;
  call_id?: string;
  arguments?: string;
  item?: { name?: string; call_id?: string; arguments?: string };
};

export function useRealtimeHistorian(context: HistorianSceneContext) {
  const [status, setStatus] = useState<VoiceStatus>("idle");
  const [caption, setCaption] = useState("");
  const [userCaption, setUserCaption] = useState("");
  const [error, setError] = useState("");
  const [isMicMuted, setIsMicMuted] = useState(true);
  const [canToggleMic, setCanToggleMic] = useState(false);
  const [canReplay, setCanReplay] = useState(false);
  const [entities, setEntities] = useState<HistoricalEntity[]>([]);
  const contextRef = useRef(context);
  const peerRef = useRef<RTCPeerConnection | null>(null);
  const channelRef = useRef<RTCDataChannel | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const handledCalls = useRef(new Set<string>());
  const introCompleteRef = useRef(false);
  const userMutedRef = useRef(true);
  const captionQueueRef = useRef<string[]>([]);
  const captionWordsRef = useRef<string[]>([]);
  const captionPartialRef = useRef("");
  const captionTimerRef = useRef<number | null>(null);
  const captionDoneRef = useRef(false);
  const captionReceivedRef = useRef(false);
  const captionHoldTicksRef = useRef(0);
  const pausedRef = useRef(false);

  useEffect(() => { contextRef.current = context; }, [context]);

  const stopCaptionPlayback = useCallback(() => {
    if (captionTimerRef.current !== null) window.clearInterval(captionTimerRef.current);
    captionTimerRef.current = null;
  }, []);

  const resetCaptionPlayback = useCallback(() => {
    stopCaptionPlayback();
    captionQueueRef.current = [];
    captionWordsRef.current = [];
    captionPartialRef.current = "";
    captionDoneRef.current = false;
    captionReceivedRef.current = false;
    captionHoldTicksRef.current = 0;
  }, [stopCaptionPlayback]);

  const startCaptionPlayback = useCallback(() => {
    if (pausedRef.current || captionTimerRef.current !== null) return;

    const revealNextWord = () => {
      if (captionHoldTicksRef.current > 0) {
        captionHoldTicksRef.current -= 1;
        return;
      }

      const word = captionQueueRef.current.shift();
      if (!word) {
        if (captionDoneRef.current && captionTimerRef.current !== null) {
          window.clearInterval(captionTimerRef.current);
          captionTimerRef.current = null;
        }
        return;
      }

      const visibleWords = captionWordsRef.current.length >= CAPTION_WORDS_PER_CARD
        ? [word]
        : [...captionWordsRef.current, word];
      captionWordsRef.current = visibleWords;
      if (visibleWords.length === CAPTION_WORDS_PER_CARD) captionHoldTicksRef.current = 1;
      setCaption(visibleWords.join(" "));
    };

    revealNextWord();
    captionTimerRef.current = window.setInterval(revealNextWord, CAPTION_WORD_INTERVAL_MS);
  }, []);

  const queueCaptionDelta = useCallback((delta: string, flushPartial = false) => {
    const combined = captionPartialRef.current + delta;
    const pieces = combined.split(/\s+/);
    const endsAtWordBoundary = /\s$/.test(combined);
    captionPartialRef.current = endsAtWordBoundary ? "" : pieces.pop() ?? "";
    captionQueueRef.current.push(...pieces.filter(Boolean));

    if (flushPartial && captionPartialRef.current) {
      captionQueueRef.current.push(captionPartialRef.current);
      captionPartialRef.current = "";
    }
    startCaptionPlayback();
  }, [startCaptionPlayback]);

  const disconnect = useCallback(() => {
    channelRef.current?.close();
    peerRef.current?.close();
    streamRef.current?.getTracks().forEach((track) => track.stop());
    if (audioRef.current) audioRef.current.srcObject = null;
    channelRef.current = null;
    peerRef.current = null;
    streamRef.current = null;
    audioRef.current = null;
    handledCalls.current.clear();
    introCompleteRef.current = false;
    userMutedRef.current = true;
    pausedRef.current = false;
    resetCaptionPlayback();
    setStatus("idle");
    setCaption("");
    setUserCaption("");
    setEntities([]);
    setIsMicMuted(true);
    setCanToggleMic(false);
    setCanReplay(false);
  }, [resetCaptionPlayback]);

  useEffect(() => disconnect, [disconnect]);

  const send = useCallback((event: unknown) => {
    const channel = channelRef.current;
    if (channel?.readyState === "open") channel.send(JSON.stringify(event));
  }, []);

  const replayLastSentence = useCallback(() => {
    if (!canReplay || status !== "listening") return;
    setCanReplay(false);
    send({
      type: "response.create",
      response: {
        output_modalities: ["audio"],
        instructions: "Repeat only the final complete sentence from your immediately previous spoken response, verbatim. Do not add an introduction, explanation, or follow-up question.",
      },
    });
  }, [canReplay, send, status]);

  const toggleMic = useCallback(() => {
    if (!introCompleteRef.current || !streamRef.current) return;
    const audioTracks = streamRef.current.getAudioTracks().filter((track) => track.readyState === "live");
    if (!audioTracks.length) {
      setIsMicMuted(true);
      setCanToggleMic(false);
      setError("No live microphone track is available. Reconnect the historian.");
      return;
    }
    const nextMuted = !userMutedRef.current;
    userMutedRef.current = nextMuted;
    audioTracks.forEach((track) => { track.enabled = !nextMuted; });
    const actuallyMuted = audioTracks.every((track) => !track.enabled);
    userMutedRef.current = actuallyMuted;
    setIsMicMuted(actuallyMuted);
    if (nextMuted) setUserCaption("");
  }, []);

  const pause = useCallback(() => {
    if (pausedRef.current) return;
    pausedRef.current = true;
    stopCaptionPlayback();
    audioRef.current?.pause();
    streamRef.current?.getAudioTracks().forEach((track) => { track.enabled = false; });
  }, [stopCaptionPlayback]);

  const resume = useCallback(() => {
    if (!pausedRef.current) return;
    pausedRef.current = false;
    if (audioRef.current) void audioRef.current.play().catch(() => undefined);
    if (introCompleteRef.current) streamRef.current?.getAudioTracks().forEach((track) => { track.enabled = !userMutedRef.current; });
    startCaptionPlayback();
  }, [startCaptionPlayback]);

  const answerTool = useCallback((event: ServerEvent) => {
    const call = event.item ?? event;
    const callId = call.call_id;
    if (!callId || handledCalls.current.has(callId)) return;
    handledCalls.current.add(callId);
    let args: Record<string, unknown> = {};
    try { args = JSON.parse(call.arguments || "{}"); } catch { args = {}; }
    if (call.name === "linkHistoricalEntity") {
      const linked = historicalEntityFromTool(args);
      if (linked) setEntities((current) => [...current.filter((item) => item.label.toLocaleLowerCase() !== linked.label.toLocaleLowerCase()), linked]);
    }
    const output = runHistorianTool(call.name || "", args, contextRef.current);
    send({ type: "conversation.item.create", item: { type: "function_call_output", call_id: callId, output: JSON.stringify(output) } });
    send({ type: "response.create", response: { output_modalities: ["audio"] } });
  }, [send]);

  const handleEvent = useCallback((event: ServerEvent) => {
    switch (event.type) {
      case "input_audio_buffer.speech_started":
        setStatus("listening"); setUserCaption("Listening…"); break;
      case "input_audio_buffer.speech_stopped":
        setStatus("thinking"); break;
      case "conversation.item.input_audio_transcription.delta":
        setUserCaption((current) => (current === "Listening…" ? "" : current) + (event.delta || "")); break;
      case "conversation.item.input_audio_transcription.completed":
        setUserCaption(event.transcript || ""); setStatus("thinking"); break;
      case "response.created":
        resetCaptionPlayback();
        setCaption("");
        setStatus("thinking");
        startCaptionPlayback();
        break;
      case "response.output_audio_transcript.delta":
        captionReceivedRef.current = true;
        queueCaptionDelta(event.delta || "");
        setStatus("speaking");
        break;
      case "response.output_audio_transcript.done":
        queueCaptionDelta(captionReceivedRef.current ? "" : event.transcript || "", true);
        captionDoneRef.current = true;
        setCanReplay(true);
        break;
      case "output_audio_buffer.stopped":
        if (!introCompleteRef.current) {
          introCompleteRef.current = true;
          streamRef.current?.getAudioTracks().forEach((track) => { track.enabled = !userMutedRef.current; });
          setIsMicMuted(userMutedRef.current);
          setCanToggleMic(true);
        }
        setStatus("listening"); break;
      case "response.function_call_arguments.done":
        answerTool(event); break;
      case "error":
        setError(event.error?.message || "Realtime voice error"); setStatus("error"); break;
    }
  }, [answerTool, queueCaptionDelta, resetCaptionPlayback, startCaptionPlayback]);

  const connect = useCallback(async () => {
    if (status !== "idle" && status !== "error") { disconnect(); return; }
    userMutedRef.current = true;
    setIsMicMuted(true);
    setCanToggleMic(false);
    setCanReplay(false);
    setStatus("connecting"); setError(""); setCaption("");
    try {
      const [tokenResponse, imageResponse, stream] = await Promise.all([
        fetch("/api/realtime/session", { method: "POST" }),
        fetch(contextRef.current.world.sourceImage),
        navigator.mediaDevices.getUserMedia({ audio: true }),
      ]);
      if (!tokenResponse.ok) throw new Error((await tokenResponse.json().catch(() => null))?.error || "Could not create a voice session");
      const tokenData = await tokenResponse.json() as { value?: string; client_secret?: { value?: string } };
      const ephemeralKey = tokenData.value ?? tokenData.client_secret?.value;
      if (!ephemeralKey) throw new Error("The voice session did not return a client credential");
      if (!imageResponse.ok) throw new Error("Could not load the Giza source image");
      streamRef.current = stream;
      stream.getAudioTracks().forEach((track) => {
        track.onended = () => {
          setIsMicMuted(true);
          setCanToggleMic(false);
          setError("Microphone access ended. Reconnect the historian to speak again.");
        };
      });
      // The historian speaks first. Keep the negotiated mic track silent until the
      // opening audio has actually finished playing, then enable normal VAD turns.
      stream.getAudioTracks().forEach((track) => { track.enabled = false; });
      const imageDataUrl = await blobToDataUrl(await imageResponse.blob());

      const peer = new RTCPeerConnection();
      peerRef.current = peer;
      const audio = new Audio();
      audio.autoplay = true;
      audioRef.current = audio;
      peer.ontrack = (event) => { audio.srcObject = event.streams[0]; };
      peer.onconnectionstatechange = () => {
        if (peer.connectionState === "failed" || peer.connectionState === "disconnected") {
          setError("Voice connection lost. Tap to reconnect."); setStatus("error");
        }
      };
      stream.getTracks().forEach((track) => peer.addTrack(track, stream));

      const channel = peer.createDataChannel("oai-events");
      channelRef.current = channel;
      channel.onmessage = (message) => handleEvent(JSON.parse(message.data) as ServerEvent);
      channel.onerror = () => { setError("Voice event channel failed."); setStatus("error"); };
      channel.onopen = () => {
        setStatus("thinking");
        send({
          type: "session.update",
          session: { type: "realtime", instructions: HISTORIAN_INSTRUCTIONS, tools: HISTORIAN_TOOLS, tool_choice: "auto" },
        });
        send({
          type: "conversation.item.create",
          item: {
            type: "message",
            role: "user",
            content: [
              { type: "input_image", image_url: imageDataUrl },
              { type: "input_text", text: `Here is the source image and metadata for the world I just entered: ${sceneMetadata(contextRef.current)}` },
            ],
          },
        });
        send({
          type: "response.create",
          response: {
            output_modalities: ["audio"],
            instructions: "Give the historical opening now. Lead with established facts about the Giza Plateau and its Old Kingdom pyramid complexes, then invite the visitor to ask a question. Do not mention the image, reconstruction, technology, provenance, or source limitations in this opening.",
          },
        });
      };

      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      const answerResponse = await fetch("https://api.openai.com/v1/realtime/calls", {
        method: "POST",
        body: offer.sdp,
        headers: { Authorization: `Bearer ${ephemeralKey}`, "Content-Type": "application/sdp" },
      });
      const answerBody = await answerResponse.text();
      if (!answerResponse.ok) {
        let detail = "";
        try { detail = (JSON.parse(answerBody) as { error?: { message?: string } }).error?.message ?? ""; } catch { detail = ""; }
        throw new Error(detail || `WebRTC setup failed (${answerResponse.status})`);
      }
      await peer.setRemoteDescription({ type: "answer", sdp: answerBody });
    } catch (reason) {
      disconnect();
      setError(reason instanceof Error ? reason.message : "Unable to start voice");
      setStatus("error");
    }
  }, [disconnect, handleEvent, send, status]);

  return { status, caption, userCaption, error, entities, isMicMuted, canToggleMic, canReplay, replayLastSentence, toggleMic, connect, disconnect, pause, resume };
}

function historicalEntityFromTool(args: Record<string, unknown>): HistoricalEntity | null {
  const label = typeof args.label === "string" ? args.label.trim() : "";
  const summary = typeof args.summary === "string" ? args.summary.trim() : "";
  const kind = args.kind;
  if (!label || !summary || (kind !== "place" && kind !== "site" && kind !== "person" && kind !== "period")) return null;
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

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}
