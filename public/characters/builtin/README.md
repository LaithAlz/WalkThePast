# Built-in guides

Guides listed here ship with the site and appear for every visitor, ahead of any
guide a browser made for itself. Drop a rigged humanoid `.glb` (an Avaturn,
Ready Player Me or Mixamo export) in this folder and list it in `index.json`:

```json
[
  { "id": "laith", "name": "Laith", "file": "laith.glb", "portrait": "laith.jpg" }
]
```

`portrait` is optional. Keep files under 25 MB each so the Cloudflare deploy accepts them.
