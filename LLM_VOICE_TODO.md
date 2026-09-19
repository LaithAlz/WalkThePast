# OpenAI Voice Historian — implementation checklist

Goal: let a visitor speak naturally while walking a world and hear a concise,
source-aware historian answer about the thing currently under the crosshair.

## Development preview contract

- [x] Reserve `/llm-voice` as the isolated voice-historian preview prefix.
- [x] Auto-select Giza and load/enter its splat without navigating the main UI.
- [x] Send the Giza source illustration and reconstruction metadata to the same
      multimodal Realtime model before requesting its opening narration.
- [x] Keep microphone input muted until the opening narration finishes, then listen.
- [x] Keep the existing landing, sample picker, and photograph-entry workflow unchanged.
- [ ] Build and test the voice system at this prefix first.
- [ ] Configure the production host to rewrite `/llm-voice/*` to `index.html` when deployed.
- [ ] Integrate the finished voice controls into the existing `Explore` workflow only
      after the MVP completion criteria below pass.

## Caption tuning

- `CAPTION_WORDS_PER_CARD` in `src/voice/useRealtimeHistorian.ts` controls how many
  words appear before the caption clears. It is currently `14`.
- `CAPTION_WORD_INTERVAL_MS` in the same file controls reveal speed. Convert WPM with
  `interval = 60000 / WPM`; the current `256ms` is about `234 WPM`.
- `.voice-historian blockquote` in `src/index.css` controls the visible caption width,
  currently `1040px`. `.explore-caption.has-voice` is the containing overlay width,
  currently `1100px`, and must remain at least as wide as the caption.
- `white-space: nowrap` keeps each caption card on one line.

## Architecture decision

- [ ] Use the OpenAI Realtime API over WebRTC for browser audio and control events.
- [ ] Add a small trusted server endpoint that creates short-lived Realtime client
      credentials. The permanent `OPENAI_API_KEY` must never enter Vite, browser
      JavaScript, local storage, or a `VITE_*` variable.
- [ ] Start with OpenAI's current GA Realtime flow rather than the legacy beta API.
- [ ] Keep world geometry and full splat state in the browser. Expose narrow tools
      that return only the context needed for the current question.
- [ ] Keep historical facts and citations in local, reviewed world/POI data. The
      model should explain that data, not invent missing history.

Official references:

- Realtime overview: https://developers.openai.com/api/docs/guides/realtime
- WebRTC connection: https://developers.openai.com/api/docs/guides/realtime-webrtc
- Realtime conversations: https://developers.openai.com/api/docs/guides/realtime-conversations
- Realtime prompting: https://developers.openai.com/api/docs/guides/voice-prompting
- Client secrets API: https://developers.openai.com/api/reference/resources/realtime/subresources/client_secrets

## 1. Credentials and server boundary

- [ ] Create an OpenAI Platform project dedicated to Walk the Past.
- [ ] Create one restricted project API key for the server: `OPENAI_API_KEY`.
- [ ] Add a server-only environment file and deployment secret; confirm it is
      ignored by Git.
- [x] Implement `POST /api/realtime/session` on the trusted server.
- [x] Have that endpoint create a short-lived Realtime client secret/session for
      the browser and return only the ephemeral credential/session response.
- [ ] Require an authenticated or rate-limited app session before minting a token.
- [ ] Attach a stable, privacy-preserving user safety identifier when available.
- [ ] Add per-user rate limits, request logging without audio content, spend alerts,
      and a session duration cap.
- [ ] Verify that the production bundle contains no permanent secret.

## 2. Browser voice transport

- [x] Add a `src/voice/` module with a small connection state machine:
      `idle -> requesting-mic -> connecting -> listening -> speaking -> reconnecting -> error`.
- [x] Request mic permission with `navigator.mediaDevices.getUserMedia({ audio: true })`.
- [x] Create an `RTCPeerConnection`, attach the microphone track, and play the
      remote audio track through one managed `<audio autoplay>` element.
- [x] Open a WebRTC data channel for Realtime client/server events.
- [x] Fetch an ephemeral session credential from `/api/realtime/session` and use it
      only for the current connection.
- [x] Close peer connection, tracks, data channel, audio element, and timers when
      leaving the world or unmounting.
- [ ] Handle denied permission, no input device, network loss, expired sessions,
      tab backgrounding, and reconnect with bounded exponential backoff.
- [ ] Add structured client diagnostics that never record raw microphone audio.

## 3. Historian prompt

- [x] Store the prompt in a versioned `src/voice/historianPrompt.ts` or server-side
      prompt configuration.
- [x] Define the role: a concise, conversational historical guide for the current
      reconstructed world.
- [ ] Default to one or two spoken sentences; expand only when the user asks.
- [ ] Require a tool call before answering any question about the current view,
      nearby place, evidence class, or historical facts.
- [ ] Explicitly distinguish:
  - `SOURCE_VISIBLE`: visible in the original source.
  - `OCCLUDED_INFERRED`: hidden in the source and inferred from surrounding evidence.
  - `UNSUPPORTED`: not supported by the original source.
- [ ] Never turn inference, absence of evidence, or a reconstruction choice into a
      historical fact.
- [ ] If evidence is missing or conflicting, say so plainly and briefly.
- [ ] Ask one short clarification question when speech or spatial intent is unclear.
- [ ] Ignore background speech that is not directed at the historian.
- [ ] Include a short verbal disclosure that the voice is AI-generated when the
      first session begins.

## 4. Typed historian tools

- [x] Define JSON schemas and TypeScript types for all tool arguments/results.
- [x] Implement `getCurrentWorld()` returning world id, name, place, period,
      coordinate convention, source summary, and available context version.
- [x] Implement `getNearbyPOI({ radiusM, limit })` with an explicit unavailable result
      until stable POI coordinates are mapped.
- [x] Implement `getCurrentEvidenceState()` returning the crosshair hit, provenance
      class, confidence/limitations, source-image relation, and a plain-language reason.
- [x] Implement an initial `getHistoricalContext({ question })` returning bounded
      context and explicit source limitations; replace it with claim-level citations.
- [ ] Add `waitForUser()` so silence, ambient noise, or side conversation can end a
      turn without a spoken response.
- [ ] Validate every tool request, clamp radius/limits, reject unknown world/POI ids,
      and return explicit `not_available` results instead of guessed values.
- [ ] Execute safe scene-read tools in the browser; route historical retrieval
      through the trusted server if it later uses a database or external provider.
- [ ] Add timeouts and one retry for idempotent tool calls.
- [ ] Log tool name, duration, result status, and world id—never raw audio.

## 5. Spatial awareness

- [ ] Add a read-only viewer snapshot method that returns player position, camera
      forward vector, crosshair raycast hit, current world id, and timestamp.
- [ ] Normalize all positions to the world manifest's post-transform coordinate frame.
- [ ] Define POIs per world with position, optional radius/bounds, aliases, and
      evidence references.
- [ ] Rank “what am I looking at?” candidates by crosshair hit first, then angular
      distance, physical distance, and occlusion.
- [ ] Return `nothing_identified` outside a conservative angular/distance threshold.
- [ ] Throttle snapshot generation and send spatial state only when a tool asks for it.
- [ ] Test camera direction after the OpenCV-to-Three.js transform used by `Viewer`.

## 6. Provenance integration

- [ ] Expose the existing crosshair verdict from `Viewer.inspect()` through a stable
      read-only API rather than duplicating provenance logic.
- [ ] Map numeric classes to named values in exactly one module.
- [ ] Include the reason and known limitations with every evidence response.
- [ ] For “Did the original photo show this?”, require `getCurrentEvidenceState()`.
- [ ] Answer source-visible only when the crosshair has a classified hit; otherwise
      say that the viewer cannot determine it.
- [ ] Add fixtures and tests for all three classes plus no-hit and unavailable-source cases.

## 7. Historical context data

- [ ] Extend each `world.json` or add `context.json` with a versioned POI schema.
- [ ] Store per POI: `id`, `name`, `position`, `radius`, `description`,
      `historicalNotes`, `evidenceClass`, `sourceIds`, and optional aliases.
- [ ] Store sources separately with title, author/organization, date, URL/archive id,
      licence, accessed date, and relevant page/section.
- [ ] Seed Giza with three to five reviewed POIs before generalizing the system.
- [ ] Keep interpretive notes separate from direct source claims.
- [ ] Validate context files at build/test time and reject dangling source ids.
- [ ] Decide whether spoken answers name sources by default or only on request; always
      expose source details in an accessible text transcript/panel.

## 8. Voice UX

- [x] Replace the decorative historian orb with an accessible mic button on `/llm-voice`.
- [x] Add visible states: ready, connecting, listening, thinking,
      speaking, interrupted, reconnecting, and unavailable.
- [x] Add accessible live captions for user and historian turns.
- [ ] Support click-to-mute and a keyboard shortcut that does not conflict with
      WASD/QE/Evidence controls.
- [x] Start with server voice activity detection for natural turn-taking.
- [x] Support Realtime WebRTC barge-in: speaking while the historian talks interrupts
      and the active response cleanly.
- [ ] Add explicit stop/disconnect and “voice off” controls.
- [ ] Never request mic permission until the user deliberately activates voice.
- [ ] Preserve core exploration when voice is unavailable.
- [ ] Test headphones, speakers with echo, mobile Safari, Chrome, Firefox, denied
      permissions, device changes, and flaky networks.

## 9. Testing and release

- [ ] Unit-test prompt policy, tool validation, evidence mapping, POI ranking, and
      reconnect state transitions.
- [ ] Add mocked Realtime event tests for user transcript, tool call, tool result,
      assistant audio, interruption, error, and session expiry.
- [x] Smoke-test a real browser session that enters Giza, enables the mic, sends the
      source image/metadata, and receives a live spoken introduction with captions.
- [ ] Extend the browser test to ask “What am I looking at?” and verify a
      tool-grounded response with controlled microphone audio.
- [ ] Add a browser test for “Did the original photo show this?” in each provenance class.
- [ ] Run an adversarial factuality set: missing POI, unsupported surface, conflicting
      notes, prompt injection inside historical text, and unclear audio.
- [ ] Track time-to-connect, first-audio latency, reconnect success, tool failures,
      session duration, and token/audio usage.
- [ ] Add privacy copy, microphone disclosure, retention policy, and a way to delete
      stored transcripts if transcripts are persisted.
- [ ] Roll out behind a feature flag to Giza first, then enable other worlds after
      their POIs and sources pass review.

## 10. Optional providers (after the OpenAI path works)

- [ ] Baseten: define exactly what model produces `SUPPORTED / DEBATED / SPECULATIVE`,
      how it is evaluated, and how it differs from geometric provenance.
- [ ] ElevenLabs: add as a swappable output adapter only if its voice materially
      improves the experience enough to justify extra latency, cost, and key handling.
- [ ] Keep both optional integrations server-side and disabled by default.

## Required credentials

Register now:

- `OPENAI_API_KEY` — one restricted OpenAI project API key, stored only on the server.

Already used by this app, unrelated to voice:

- `VITE_CLERK_PUBLISHABLE_KEY` — browser-safe Clerk publishable key.
- `CLERK_SECRET_KEY` — required only if the new server validates Clerk sessions;
  server-only and never prefixed with `VITE_`.

Register only if the optional extensions are approved:

- `BASETEN_API_KEY` — server-only.
- `ELEVENLABS_API_KEY` — server-only.

Do not register or store a permanent “browser OpenAI key.” The browser should receive
only a short-lived Realtime client credential minted by the trusted server.

## MVP completion criteria

- [x] On Giza, a user deliberately enables the mic and reaches `listening`.
- [ ] “What am I looking at?” triggers spatial/evidence tools and produces a concise
      spoken answer grounded in a reviewed POI or an honest “not identified.”
- [ ] “Did the original photo show this?” reports the actual provenance class and reason.
- [ ] The user can interrupt speech, mute, reconnect, and leave without leaked media tracks.
- [ ] No permanent secret is present in browser source, bundles, storage, or network logs.
- [ ] A text transcript and source details are accessible alongside the spoken response.
