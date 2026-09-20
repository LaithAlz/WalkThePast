# Locomotion clips for the guide

**Nothing needs to go here.** The guide made in the selfie step is animated from
[`src/companion/pose.ts`](../../src/companion/pose.ts), which generates idle,
walk, run, waving and talking gestures against whatever humanoid skeleton the
avatar arrives with. That is the default and it works with an empty folder.

This slot exists for when you want a Mixamo walk cycle instead.

## Installing clips

```
public/characters/<slug>/character.glb
```

Set `VITE_GUIDE_CLIPS=<slug>` in `.env.local` (the default slug is `guide`).
Clips named `idle`, `walk` and `run` are picked up; anything else is ignored.

Where to get one: [mixamo.com](https://www.mixamo.com), any character, then
download Idle, Walking and Running. Combine them into a single GLB with those
three clip names — `@gltf-transform/cli` or Blender will both do it.

## What happens to them

- **Bones are rebound by meaning, not by name.** `mixamorig:Hips`,
  `mixamorig9:Hips`, `Hips` and `pelvis` all resolve to the same bone, so a
  clip from any exporter binds to an avatar from any other. See
  `retarget()` in [`src/companion/loader.ts`](../../src/companion/loader.ts).
- **Rotation only.** Translation tracks carry the donor's proportions, and the
  guide is scaled to 1.74 m whatever the avatar's own height, so keeping them
  would drift the hips and skate the feet.
- **The gestures still come from `pose.ts`.** No Mixamo locomotion pack ships a
  wave or a talking gesture, and those are the ones this app actually needs, so
  they are layered over the clips rather than replacing them.

A clip that binds to nothing is dropped rather than half-played: the mixer
would skip the tracks in silence, and a silent skip is how a character ends up
walking with one leg.
