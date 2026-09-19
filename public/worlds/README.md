# Worlds

Marble exports go here and are served at `/worlds/<file>`.

They are gitignored — a splat export is hundreds of MB and will blow up the
repo. Share them out of band (Drive / S3) and keep filenames matching the
`splatUrl` entries in `src/worlds.ts`.

Supported by Spark: `.ply`, `.spz`, `.splat`, `.ksplat`.
`.spz` is much smaller than `.ply`; prefer it for the demo build so a clean
browser session loads fast.
