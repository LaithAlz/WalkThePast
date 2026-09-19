# Walk the Past

HTN 2026 build plan, ordered by priority.

> **Core rule:** The project is not photo-to-3D. The project is the evidence layer that shows where the historical source ends and AI reconstruction begins.

---

# Priority Summary

## P0 — Required

These phases must work for the project to be worth submitting.

1. Phase 0 — World Generation Viability
2. Phase 1 — Walkable Historical World
3. Phase 2 — Geometric Provenance
4. Phase 3 — Freeze + Demo Hardening

If only P0 is complete, we still have a full Hack the North submission.

## P1 — Strong Additions

These are the highest-value features after the core works.

5. Phase 4 — Spatial OpenAI Historian
6. Phase 5 — Baseten Historical Evidence Verifier
7. Phase 6 — Expo Mobile Companion
8. Phase 7 — ElevenLabs Voice Layer

## P2 — Technical Stretch

9. Phase 8 — Second-Photo Evidence Expansion

## P3 — Product Stretch

10. Phase 9 — Text-to-Historical-World

## P4 — Optional Sponsor / Infrastructure

11. Phase 10 — Sentry
12. Phase 11 — MongoDB Atlas
13. Phase 12 — Custom Domain / GoDaddy

---

# Phase 0 — World Generation Viability

**Priority:** P0  
**Required:** Yes

## Goal

Prove the world-generation and rendering pipeline before building product features.

## Build

- Historical image -> World Labs Marble
- Export Gaussian splat
- Load splat with Spark
- Render inside Three.js
- Confirm acceptable FPS on the demo laptop
- Test whether the original photograph camera can be aligned with the generated scene

## Exit Gate

One custom historical world renders locally and the original source viewpoint can be approximately recreated.

## Kill Switch

If Marble export blocks the provenance system, replace the generator and keep the rest of the architecture.

---

# Phase 1 — Walkable Historical World

**Priority:** P0  
**Required:** Yes

## Goal

Turn the historical image into a controllable first-person world.

## Build

- WASD movement
- Mouse look
- Optional gamepad
- Reset-to-photographer control
- Original photo <-> reconstructed world wipe
- Local caching for the hero world

## Exit Gate

A judge can see the original photograph, fade into the matching 3D view and immediately start walking.

---

# Phase 2 — Geometric Provenance

**Priority:** P0  
**Required:** Yes  
**This is the core project.**

## Goal

Show exactly where source evidence ends and generated reconstruction begins.

## For Each Gaussian

1. Transform it into the historical source camera
2. Project it into the original image
3. Compare its depth with the visible source depth
4. Classify it as:

```text
SOURCE_VISIBLE
OCCLUDED_INFERRED
UNSUPPORTED
```

## Rendering

### Exploration Mode

- Source-supported regions remain natural
- Unsupported regions shift subtly as the user leaves observed space

### Evidence Mode

- Green = source-visible
- Amber = occluded / inferred
- Purple = unsupported
- Show the historical camera frustum

## Exit Gate

The judge can walk around an object, cross the evidence boundary and inspect why the classification changed.

## Kill Switch

If full occlusion classification is unstable, ship a correct camera-observation boundary instead of fake labels.

---

# Phase 3 — Freeze + Demo Hardening

**Priority:** P0  
**Required:** Yes

## Goal

Protect the working core before adding optional features.

## Build

- Tag a safe release
- Duplicate the working build
- Cache all critical assets
- Record a backup demo
- Test from a clean browser session
- Test on the actual judging laptop
- Keep a second local copy
- Do not modify the fallback build after freezing it

## Exit Gate

The complete:

```text
photo -> world -> walk -> evidence boundary -> Evidence Mode
```

loop works reliably from a clean start.

---

# Phase 4 — Spatial OpenAI Historian

**Priority:** P1  
**Required:** No  
**Optional:** Yes, but high priority

## Goal

Let the user talk naturally to the historical world.

## Agent Context

Give the OpenAI agent access to:

- Current world
- Historical era
- Player position
- Camera/look direction
- Nearby POIs
- Current provenance state
- Historical source context

## Example Questions

- "What is that?"
- "How was this used?"
- "Did the original photograph actually show this?"
- "Do historians know this happened this way?"

## Implementation Note

Do not semantically label every Gaussian.

Tag a small set of important POIs in each hero world.

## Exit Gate

A user can walk, look toward a known POI and ask a natural question that gets a context-aware answer.

---

# Phase 5 — Baseten Historical Evidence Verifier

**Priority:** P1  
**Required:** No  
**Optional:** Yes

## Goal

Use a Baseten-hosted open-source model to evaluate what historical sources actually support.

## Example Flow

```text
User asks a historical question
    ->
OpenAI historian decides verification is needed
    ->
verifyHistoricalClaim()
    ->
Baseten-hosted model
    ->
historical sources
    ->
SUPPORTED / DEBATED / SPECULATIVE
    ->
OpenAI explains the result naturally
```

## Example Output

```json
{
  "status": "DEBATED",
  "supportedBy": ["source_1", "source_4"],
  "conflictsWith": ["source_7"],
  "explanation": "The use of ramps is supported, but the exact configuration remains uncertain."
}
```

## Why It Fits

This gives Walk the Past two evidence systems:

```text
Geometric provenance
= what did the photograph observe?

Historical provenance
= what do the sources support?
```

## Exit Gate

At least one historical question triggers a real Baseten verification step and returns a source-grounded result.

## Cut Rule

Do not build this before geometric provenance is frozen.

---

# Phase 6 — Expo Mobile Companion

**Priority:** P1  
**Required:** No  
**Optional:** Yes

## Goal

Let the user carry the same historical world onto their phone.

## Flow

```text
Laptop world
    ->
QR / deep link
    ->
Expo app
    ->
same historical world
```

## Mobile Features

- Gyroscope / device orientation
- Touch controls
- Haptic feedback at evidence boundaries
- Source photo viewer
- Evidence status
- Voice historian
- Native source / POI cards
- Deep linking into a specific world

## Exit Gate

The user scans from the laptop, opens the same world on mobile and uses at least one native mobile interaction such as gyro or haptics.

## Kill Switch

If full mobile 3D rendering becomes expensive, ship a focused Expo companion instead of duplicating the desktop experience.

---

# Phase 7 — ElevenLabs Voice Layer

**Priority:** P1  
**Required:** No  
**Optional:** Yes

## Goal

Make the historian sound more immersive.

## Flow

```text
User speech
    ->
OpenAI agent + tools
    ->
historical answer
    ->
ElevenLabs
    ->
spoken historian response
```

## Exit Gate

The narrator sounds noticeably better without adding unacceptable latency.

## Cut Rule

Do not replace a working OpenAI voice flow just to qualify for the sponsor track.

---

# Phase 8 — Second-Photo Evidence Expansion

**Priority:** P2  
**Required:** No  
**Optional:** Yes

## Goal

Add more primary evidence without regenerating the world.

## Build

- Register a second historical photograph as another evidence camera
- Recompute support across both cameras
- Allow previously unsupported regions to become source-supported
- Keep the underlying generated world unchanged

## Concept

```text
support(x) = max(
  support_from_camera_1(x),
  support_from_camera_2(x)
)
```

## Exit Gate

Adding source #2 visibly expands evidence coverage in the same world.

## Kill Switch

Abort if camera registration remains unstable after the timebox.

---

# Phase 9 — Text-to-Historical-World

**Priority:** P3  
**Required:** No  
**Optional:** Yes

## Goal

Turn a natural-language historical request into an explorable world.

Example:

> "I want to see how the pyramids were built."

## Flow

```text
User request
    ->
OpenAI interprets historical intent
    ->
Scene prompt
    ->
Marble
    ->
Generated world
    ->
Walk the Past viewer
    ->
Voice historian
```

## Judging Strategy

- Pre-generate hero worlds
- Cache them locally
- Route known demo requests to cached worlds
- Do not wait for live generation during judging

## Important

Text-generated worlds do not automatically get photo-based provenance unless real source evidence is attached.

## Exit Gate

A typed historical request opens the correct cached hero world and starts the correct historical context.

---

# Phase 10 — Sentry

**Priority:** P4  
**Required:** No  
**Optional:** Yes

## Use

- Session Replay
- Tracing
- Logs
- Profiling

## Rule

Use Sentry to discover and fix a real issue so the integration is meaningful.

Do not make Sentry a critical dependency for the live demo.

---

# Phase 11 — MongoDB Atlas

**Priority:** P4  
**Required:** No  
**Optional:** Yes

## Store

- World metadata
- Source images
- Camera calibration data
- POIs
- Provenance summaries
- Generated-world status

## Rule

Use only if persistence is actually needed.

The core demo should still work from local cached assets.

---

# Phase 12 — Custom Domain / GoDaddy

**Priority:** P4  
**Required:** No  
**Optional:** Yes

## Goal

Give the project a memorable public URL.

## Rule

Do not spend meaningful engineering time on this before the core and submission are safe.

---

# Tech Stack

| Layer | Choice |
|---|---|
| World generation | World Labs Marble |
| 3D representation | Gaussian Splatting (`.ply`) |
| Splat renderer | Spark |
| 3D engine | Three.js |
| Frontend | React + Vite + TypeScript |
| Provenance compute | GPU shader / Spark processing where possible |
| Spatial historian | OpenAI API / realtime voice |
| Historical verifier | Baseten-hosted open-source model |
| Optional voice output | ElevenLabs |
| Mobile | Expo + React Native |
| Backend | Minimal Node.js or FastAPI |
| Storage | Local cache first, optional MongoDB/S3/Supabase |
| Observability | Sentry |
| Input | Pointer Lock + keyboard/mouse |
| Optional input | Browser Gamepad API |
| Demo runtime | Local browser / localhost |

---

# Core Architecture

```text
Historical photo
    ->
Marble
    ->
Gaussian splat
    ->
Spark + Three.js
    ->
Geometric provenance engine
    ->
Walkable evidence-aware world
```

With the historian:

```text
Player position
+ look direction
+ nearby POI
+ provenance state
    ->
OpenAI historian
    ->
context-aware narration / Q&A
```

With historical verification:

```text
Historical claim
    ->
Baseten verifier
    ->
historical sources
    ->
SUPPORTED / DEBATED / SPECULATIVE
    ->
OpenAI explains result
```

With mobile:

```text
Laptop world
    ->
QR / deep link
    ->
Expo app
    ->
gyro + haptics + voice + evidence state
```

---

# 36-Hour Build Order

| Hours | Target |
|---|---|
| 0-3 | Phase 0: Marble -> splat -> Spark + camera alignment |
| 3-8 | Phase 1: movement, reset and photo/world wipe |
| 5-16 | Phase 2: geometric provenance |
| ~16 | **Freeze the core** |
| 16-18 | Phase 3: backup and hardening |
| 18-23 | Phase 4: OpenAI historian |
| 23-27 | Phase 5: Baseten verifier |
| 20-27 | Phase 6 in parallel: Expo companion |
| 24-27 | Phase 7 only if useful: ElevenLabs |
| 27-31 | Phase 8: second-photo evidence |
| 27-31 | Phase 9 in parallel: text-to-world |
| 31-33 | P4 sponsor integrations only if nearly free |
| 33-36 | No new features. Submission, video, rehearsal and bug fixes |

---

# Final Cut Order

If time runs out, cut from the bottom upward.

```text
KEEP:
1. Marble works
2. World is walkable
3. Geometric provenance works
4. Frozen reliable demo

THEN:
5. OpenAI historian
6. Baseten verifier
7. Expo companion
8. ElevenLabs

OPTIONAL:
9. Second photo
10. Text-to-world
11. Sentry
12. MongoDB
13. Custom domain
```
