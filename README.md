# Walk the Past

An evidence layer for AI-reconstructed history. A historical photograph becomes
a walkable 3D world, and the world shows you where the photograph's evidence
ends and the reconstruction begins.

Build plan and phase gates: [WALK_THE_PAST_PHASES.md](WALK_THE_PAST_PHASES.md)

## Getting started

### Prerequisites

**Node.js `^20.19.0` or `>=22.12.0`** — Vite 8 will refuse to start on anything
older. Check yours:

```bash
node -v
```

If it is too old, install a current one ([nvm](https://github.com/nvm-sh/nvm)):

```bash
nvm install 22 && nvm use 22
```

npm ships with Node, so there is nothing else to install globally.

### Install

```bash
git clone https://github.com/LaithAlz/WalkThePast.git
cd WalkThePast
npm install
```

`npm install` pulls everything — React, Three.js, Spark, TypeScript, Vite. It
takes about a minute on a cold cache. Use `npm install`, not `npm i --force` or
`--legacy-peer-deps`: if you hit a peer dependency error, something is actually
wrong and we should fix it rather than paper over it.

Already cloned and just need to catch up after someone adds a dependency? Run
`npm install` again — it is safe to re-run any time.

### Authentication setup

Sign-in and sign-up are Clerk's own components, and they need a publishable key
before the app can start:

```bash
cp .env.example .env.local
```

Set `VITE_CLERK_PUBLISHABLE_KEY` in `.env.local` to the publishable key from
your Clerk dashboard, and keep **Email + Password** enabled there. Which methods
appear on the card is decided by the Clerk dashboard, not by this code: enabling a
social connection adds its button, disabling one removes it. Google is
deliberately off — turn it back on in **Configure → SSO connections** if that
ever changes.

This is a client-only Vite app. Never put `CLERK_SECRET_KEY`, or any other
server secret, in `.env.local` or a `VITE_*` variable. Keep secrets only in a
server-side environment if a backend is added later. `.env.local` is ignored by
Git; `.env.example` is the safe, committed template.

### Run

```bash
npm run dev
```

Open the URL it prints (usually `http://localhost:5173`, but it will pick the
next free port if something else has it — we run more than one dev server on
this project, so check the output rather than assuming).

With no world configured you get a blank scene: grid, axes and the HUD. **That
is correct**, not a broken build — it stays that way until the first Marble
export lands. To confirm the renderer itself works, load the test splat in
[Load a splat](#load-a-splat) below.

### Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Dev server with hot reload |
| `npm run build` | Typecheck (`tsc -b`) then production build into `dist/` |
| `npm run preview` | Serve the production build locally |
| `npm run lint` | Lint with oxlint |
| `npm test` | Synthetic provenance and walking/collision regression tests (Node 22.18+ or 24+) |

Run `npm run build` before you open a PR — `npm run dev` does not typecheck, so
a type error can sit in your branch unnoticed until it breaks someone else.

### Troubleshooting

- **`EJSONPARSE` or odd resolution errors** — delete and reinstall:
  `rm -rf node_modules package-lock.json && npm install`
- **Blank page, no grid, console errors about WebGL** — your browser or GPU is
  not giving us a WebGL2 context. Check `chrome://gpu`.
- **Splat loads but the world is upside down** — see the `flipY` note under
  [Things worth knowing](#things-worth-knowing).

## Load a splat

Two ways, no code change needed for the second:

1. Add an entry to `WORLDS` in [src/worlds.ts](src/worlds.ts) — the first entry
   loads on startup.
2. Pass a URL: `http://localhost:5173/?splat=/worlds/hero-1.spz`

A known-good test asset, if you want to check the renderer independently of
Marble:

```bash
curl -L -o public/worlds/butterfly.spz https://sparkjs.dev/assets/splats/butterfly.spz
# then open http://localhost:5173/?splat=/worlds/butterfly.spz
```

Spark reads `.ply`, `.spz`, `.splat` and `.ksplat`. Prefer `.spz` for the demo
build — it is roughly an order of magnitude smaller than `.ply`, which matters
for the Phase 3 clean-browser-session test.

## Layout

```
src/
  viewer/Viewer.ts       Three.js + Spark render loop, splat loading, FPS sampling
  components/
    WorldCanvas.tsx      Mounts the viewer, owns its lifecycle
    Hud.tsx              Status + frame rate overlay
  worlds.ts              Hero world registry
public/
  worlds/                Marble exports (gitignored — too large)
  sources/               Original historical photographs (committed)
```

### Why plain Three.js and not react-three-fiber

Phase 2 writes custom shader work against Spark's `dyno` graph to classify every
Gaussian. That is easier against Spark's own imperative API, and it keeps React
out of the per-frame path. React owns mount/unmount and the HUD; `Viewer` owns
everything inside the render loop.

## Things worth knowing

- `WebGLRenderer` is constructed with `antialias: false` on purpose. MSAA does
  nothing for Gaussian splats and costs a lot of fill rate. Spark documents this.
- Splat meshes get `quaternion.set(1, 0, 0, 0)` — a 180° roll about X. Marble and
  most PLY exporters use a Y-down convention relative to Three.js. If an export
  arrives upright, set `flipY: false` on that world.
- Camera control is standard pointer-lock mouselook: click the viewport to
  capture the cursor, then raw mouse deltas drive unbounded yaw and ±89° pitch
  with no smoothing, acceleration or auto-turn. WASD walks and strafes along
  the camera's horizontal heading, and M gives the cursor back. Escape is never
  bound, since the browser spends it leaving both pointer lock and fullscreen. M opens the pause menu,
  which is the only in-world chrome: it carries the controls, a persisted look
  sensitivity slider, the evidence toggle and the way out. Not Escape, which the
  browser spends leaving fullscreen.
  WASD/arrows walk, Shift runs and R resets. Collision meshes enable walls, gravity,
  stairs and slopes. Without one, the viewer explicitly shows a level-ground
  preview. See [Walking and collision setup](docs/walking.md) for the manifest
  contract, controls, tests and per-world acceptance checks.
- A world with provenance loads **two** splat meshes. Classification indexes
  splats by file order, and Spark's LoD tree reorders them and varies how many
  are live with the view, so the tinted mesh cannot use LoD. Rather than force
  the whole world down to a low tier, `splat.url` stays full-resolution with LoD
  for walking and `provenance.splatUrl` names a small tier that is hidden until
  evidence mode. Only one is ever visible, so the cost is GPU memory, not fill
  rate — and only evidence mode looks coarse.
- The production bundle is ~3.2 MB (Three.js plus Spark's wasm). Fine for a
  localhost demo; worth code-splitting only if we deploy.

## Voice narration

The voice historian uses WebRTC for microphone input and the configured Realtime
model for text and tool calls. Each sentence is prepared through
`POST /api/realtime/narration`: `gpt-4o-mini-tts` produces the audio with the `marin`
voice, and `whisper-1` supplies word timestamps for that same audio. Captions read
the finite audio element's `currentTime`; no words-per-minute timer is used.
Pause holds both the audio position and captions, and replay uses the cached clip.

This intentionally adds buffering before speech and a speech/transcription API
request per sentence. Keep `OPENAI_API_KEY` server-side in `.env.local`; the key
must have access to those models as well as the configured Realtime model. Both
API routes run in Vite dev and preview; in production the Worker serves them
(see [Deployment](#deployment)). Word boundaries are transcription estimates, so this removes
network-induced drift without promising phoneme-perfect alignment. If spoken
words cannot be matched to the original text, playback stops with a retry message
instead of falling back to invented timestamps. See the official
[speech generation](https://developers.openai.com/api/docs/guides/text-to-speech)
and [word timestamp](https://developers.openai.com/api/docs/guides/speech-to-text#timestamps)
documentation. Run `npm test` for playback, network, interruption, and timing checks.

## Stack

Vite · React 19 · TypeScript · Three.js `0.186` · Spark `2.2` (`@sparkjsdev/spark`)

## Deployment

**Vercel serves the frontend; a Cloudflare Worker serves everything else.** The
Worker (`worker/`, configured in `wrangler.toml`) supplies the `/api` routes that
otherwise exist only inside Vite's dev and preview servers, and every generated
world out of R2. It can also serve the built site itself, so the same deployment
works standalone if Vercel is ever dropped.

`VITE_API_BASE` tells the frontend where that Worker is. Leave it **empty** for
local dev — every path stays relative and hits Vite's own middleware and
`public/worlds/`, so nothing about `npm run dev` changes. Set it on Vercel to the
Worker's origin. Because the two then sit on different origins, the Worker
allowlists callers through `ALLOWED_ORIGINS` (see `wrangler.toml`); entries may
start with `*.` to admit Vercel's per-commit preview hostnames.

A Marble generation runs for minutes and polls throughout, which outlives any
single request, so it runs as a [Workflow](https://developers.cloudflare.com/workflows/)
(`worker/marbleWorkflow.ts`) rather than a background promise. Each stage is a
step, so a failure retries from that stage instead of repeating a paid
generation. Two platform limits shape the design: a step's return value and a
workflow's event payload are both capped at 1 MiB, so splats stream straight
into R2 inside their step, and uploaded photographs are staged in R2 and passed
to the workflow by key.

Worlds are stored under `<worldId>/` exactly as the Vite bridge laid them out on
disk — `splat_*.spz` (and `splat_full.ply` when a generation asks for it),
`pano.png`, `collider.glb`, `source.*`, `world.json` — so `world.json` keeps its
relative asset paths and `resolveAsset()` in `src/viewer/world.ts` resolves them
against R2 in production and `public/worlds/` in dev without a code change.

Every `/api` route reaches a paid upstream — Marble, OpenAI — and the Worker's URL
ships inside the public frontend bundle, so each one requires a Clerk session. The
browser sends its session token as a bearer token and the Worker verifies the
signature against Clerk's JWKS (`worker/auth.ts`); `CLERK_ISSUER` in `wrangler.toml`
names the Frontend API origin. World assets under `/worlds/` stay open, because the
viewer reads them to walk a world.

This means **`VITE_CLERK_PUBLISHABLE_KEY` must be set wherever the frontend is
built**. Without it `vite.config.ts` aliases `@clerk/react` to a stub whose
`getToken()` returns null, so no request carries a token and every `/api` route
answers 401.

First deploy:

```sh
# R2 must be enabled for the account first, in the Cloudflare dashboard
npx wrangler r2 bucket create walk-the-past-worlds
npx wrangler secret put WORLDLAB_API_KEY
npx wrangler secret put OPENAI_API_KEY
npx wrangler secret put GEMINI_API_KEY   # optional
npm run deploy
```

`npm run deploy` builds the site and deploys the Worker. `npm run worker:dev`
runs the Worker locally against the same bindings.
