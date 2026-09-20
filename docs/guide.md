# The guide

A selfie becomes a rigged character, and that character walks the world beside
you as the historian. You stay first person with no body at all — the face you
make in the selfie step belongs to your guide, not to you.

Built after [panterathehacker/marble-runner](https://github.com/panterathehacker/marble-runner),
which does the same trick for a third-person player. Two things are different
here: the avatar is the companion rather than the player, and it walks on this
app's existing collision mesh rather than on a second physics world.

## The flow

```
/create   the guide shelf sits in the panel head, beside the prompt:
          who is coming with you, everyone you have made, and a
          "Walk with a guide" tick. New guides are made here, in an
          overlay, with no world involved.
              |
              v  Generate
/worlds   the world builds in the background (1-5 min)
              |
              v
/walk/<id> Spark streams the splat, the collider becomes an octree, you
           spawn at the photographer's position, and the selected guide
           spawns a step in front of you
```

Guides used to be made in a step wedged between Generate and the world being
ready, which meant you could only ever have one and only while a world was
building. They live on the create screen instead, so a demo can have a shelf of
them ready. Walking alone is a tick box, and the default is a guide.

## Where it lives

| File | What it does |
|---|---|
| `src/companion/avaturn.ts` | Loads Avaturn's SDK from their CDN, hosts it, fetches the exported GLB, renders the portrait |
| `src/companion/store.ts` | The shelf: IndexedDB, metadata and models in separate stores, and the v1 migration |
| `src/companion/GuidePicker.tsx` | The shelf on the create screen — choose, delete, walk alone |
| `src/companion/loader.ts` | GLB in, posable model out: material repair, height fit, armature discovery, optional donor clips |
| `src/companion/rig.ts` | Bone naming across exporters, and aiming a bone along a direction |
| `src/companion/pose.ts` | The animation itself — idle, walk, the gesture repertoire, the speech envelope |
| `src/companion/mouth.ts` | Blend shapes or a jaw bone, whichever the avatar has |
| `src/companion/env.ts` | `import.meta.env`, guarded so the Node tests can load these modules |
| `src/companion/follow.ts` | Where the guide should be standing, and whether it is stuck |
| `src/companion/Companion.ts` | The three tied together, on a `WalkingMotor` |
| `src/companion/GuideStudio.tsx` | Making one guide, as an overlay |

## Storage

Metadata and model data are separate IndexedDB stores, so the shelf can list
every guide without pulling several megabytes of GLB per row into memory to do
it. Which guide is current, and whether you want one at all, are per-browser
preferences rather than data, so they live in localStorage and degrade to "the
newest one" and "yes" when it is unavailable — a stale or deleted selection
falls back to the newest guide rather than to nobody.

Version 1 of the database held exactly one guide, model and all, under a single
key. The version 2 upgrade carries it across and selects it, because anyone who
made a guide before the shelf existed should still have it afterwards. That
migration is tested against a real IndexedDB (`fake-indexeddb`) in
`test/guide-store.test.mjs`, including that it does not run twice.

## Three decisions worth knowing about

### It walks on the octree, not on Rapier

marble-runner runs Rapier with a trimesh built from `collider.glb` and a
kinematic character controller. This app already has a capsule controller over
a three.js `Octree` — [`src/viewer/walking.ts`](../src/viewer/walking.ts) —
with gravity, wall sliding, slope limits and stair stepping, and it is the one
the player walks with.

The guide gets a second `WalkingMotor` on **the same octree**. That is not a
shortcut, it is the point: the guide can never reach anywhere you could not
have walked to yourself, the two controllers can never disagree about where a
wall is, and a world with no `collider.glb` still gets a guide on the
level-ground fallback rather than none at all. No new dependency, no second
collision mesh in memory, no Y/Z flip to keep in sync with the splat.

See [walking.md](walking.md) for the collision manifest itself.

### The animation is written, not exported

An Avaturn avatar arrives rigged and with zero clips, and no Mixamo locomotion
pack contains a wave or a talking gesture — which are exactly the two this app
needs. So `pose.ts` generates them.

A pose is a set of **directions** for each limb to point in, given in the
character's own frame (+x right, +y up, +z forward). `rig.ts` turns a direction
into a bone rotation: it reads the bone's own axis out of where its child sits
in the rest pose, then applies the shortest rotation carrying that axis onto
the direction asked for. Nothing assumes an axis convention, which is why the
same pose works on an Avaturn avatar, a Mixamo download and a Ready Player Me
export — three rigs whose arms rest along three different axes.

Twist about a limb's own length is the one thing a direction cannot express, so
it is passed separately. That is what turns a head to look at you.

Locomotion clips are optional and drop in at
`public/characters/<slug>/character.glb`; the gestures layer over them either
way. See [public/characters/README.md](../public/characters/README.md).

### It stands in front of you, not behind you

A companion that trails a first-person player is a companion you never see. The
guide holds a mark about 1.85 m ahead and 1.05 m to one side — roughly 30
degrees off the centre of the view, which is inside the horizontal field down
to a 4:3 window and clear of the crosshair that evidence mode reads through.

The heading that mark is built from lags yours by about half a second, so
turning your head does not send the guide running; turning your body does. Two
distance thresholds rather than one stop it shuffling on the spot. When you
speak to it, it closes in and squares up.

Steering cannot solve a maze, and it does not pretend to. A guide making no
progress towards its mark tries the other shoulder, and if that fails too it
asks to be put back beside you — which is also what happens past an 11 m leash,
and what `R` does along with resetting your own position.

## What the guide does with its hands

`VoiceHistorian` lifts the realtime session's state up through `Explore` and
into the viewer, so what you hear becomes what you see:

| Historian | Guide |
|---|---|
| speaking | Talking hands — presenting, counting off, pointing, the occasional wave |
| thinking | Considers, head tilted |
| listening (you are holding `Space`) | Turns square on, nods |
| idle | Follows, watches you, and waves unprompted every half minute or so |

The first time you ever speak to it, it waves hello. Only the first time.

Gestures run at `DEFAULT_TEMPO` (1.6), which scales each one's length, the
oscillation inside it and the pause afterwards together — one number for how
brisk the hands are, tunable per guide with `CompanionOptions.gestureTempo`.
At the default, something is moving in roughly 87% of frames while it speaks.

## The mouth

Which lever exists depends entirely on where the avatar came from, so
`mouth.ts` finds whatever is there:

1. **Blend shapes**, the usual case. ARKit (`jawOpen`, `mouthPucker`,
   `mouthSmile*`) and Oculus visemes (`viseme_aa`, `viseme_I`, `viseme_O`, …)
   are both matched, by name with separators and case stripped.
2. **A jaw bone**, for the rare rig that has one instead. Hinged about the
   character's own lateral axis, since a jaw has no direction worth aiming and
   its local axes could point anywhere.
3. **Neither**, in which case the mouth stays shut. That is the right answer,
   not a failure — a Mixamo character has no face to move.

Where the vowel shapes exist it drifts between a wide one and a rounded one as
it goes. Speech is not a mouth opening and closing, it is the shape changing,
and a jaw hinging on its own reads as chewing. Nothing is driven to full
strength either; `jawOpen` at 1.0 is a scream.

**Is your avatar's mouth wired up?** The guide logs it once, in dev:

```
[guide] mouth: 3 open, 5 wide, 2 round blend shapes
[guide] mouth: a jaw bone
[guide] mouth: nothing — this avatar has no mouth to move
```

If it says nothing, that is an Avaturn export setting rather than a code
problem — the project has to be exporting ARKit blendshapes or visemes.

### It is not lip sync

The level driving it comes from `speechEnvelope()` in `pose.ts`: syllables at
about four a second riding a slower phrase contour, on two deliberately
incommensurate rates so it never settles into a visible loop. It is not reading
the audio, and it does not know what word is being said.

Making it real is one call. `Companion.setSpeechLevel(0..1)` takes over for as
long as levels keep arriving (a quarter second of silence and the written
envelope resumes), so an `AnalyserNode` on the historian's narration audio would
be enough. That audio is a fresh `Audio` element per sentence in
`TimedNarrationPlayer`, and routing it through a Web Audio graph would mean
touching the pause, replay and caption timing that hang off it — which is why
it has not been done here.

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `VITE_AVATURN_URL` | Avaturn's shared demo | Make your own free project at [avaturn.me](https://avaturn.me) before demoing |
| `VITE_GUIDE_CLIPS` | `guide` | Folder under `public/characters` holding donor clips |

## Testing without Avaturn

Avaturn's shared demo project is slow, because it is shared. When you are
testing the world rather than the selfie step, the step carries a developer
block — **`import.meta.env.DEV` only, stripped from a production build** — that
takes any rigged humanoid GLB straight into the guide slot through the same
code path Avaturn's export uses.

It takes a file picker: any Avaturn, Ready Player Me or Mixamo export. Bone
names are read by meaning, so the naming convention does not matter.

A **photograph** is not one of the things it takes, and cannot be — turning a
face into a rigged mesh is what Avaturn does, and there is no local equivalent.
Photographs go through **Use a photo**, into Avaturn's own step.

Tuning lives in `CompanionOptions` (`height`, `walkSpeed`, `runSpeed`,
`stride`) and `FollowOptions` (`ahead`, `beside`, `arrive`, `depart`, `leash`).
If an avatar's elbows bow the wrong way, the `TWIST` table at the top of
`rig.ts` is the one place to change.

## Tests

`npm test` (Node 22.18+ or 24+) covers the parts that are arithmetic rather
than rendering, in `test/companion.test.mjs`:

- storage, in `test/guide-store.test.mjs` — the v1 guide survives the upgrade
  with its model, name, portrait and date, the upgrade does not duplicate it,
  guides list newest first, deleting one takes its model and steps the
  selection aside, and walking alone loads nobody
- steering — the mark stays in frame, hysteresis settles, a stuck guide swaps
  sides then gives up, a distant one asks to be moved
- poses — every limb points somewhere real, the walk cycle closes, no foot ever
  points at the sky, partial blends leave other channels alone
- gestures — fade in and out, never repeat back to back, an idle guide is
  occasional rather than constant, and a brisker tempo really is busier
- the mouth — blend shapes driven by name across both conventions, wide and
  round trading places, a jaw bone hinged and returned exactly, an avatar with
  no mouth left alone, and a speech envelope that opens, shuts and does not
  loop on the second
- the rig — bone names across four conventions, aiming from three different
  rest axes, overlay blending, restoring the T-pose, clip rebinding
- the guide on its feet — spawns on the floor, keeps up with a walking player,
  actually moves its legs, recovers from the wrong side of a wall, and reports
  rather than floats when there is no floor

What that does not cover is anything on a GPU: the materials, the lighting, and
whether a real Avaturn export looks right. Those need a browser and a selfie.
