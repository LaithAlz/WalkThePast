#!/usr/bin/env python3
"""
Historical photo -> World Labs Marble -> Gaussian splat -> viewer world.

Usage
-----
  export WORLDLABS_API_KEY=...          # https://platform.worldlabs.ai/api-keys
  python pipelines/marble/generate_world.py \
      --image assets/sources/pyramids_1900.jpg \
      --id marble-pyramids \
      --model marble-1.0-draft            # cheap smoke test (230 credits ≈ $0.18)
  python pipelines/marble/generate_world.py --image ... --id ... --model marble-1.1   # hero quality (1580 credits ≈ $1.26)

  # already generated? skip generation and just (re)download:
  python pipelines/marble/generate_world.py --world-id <world_id> --id marble-pyramids --image assets/sources/x.jpg

Output
------
  viewer/public/worlds/<id>/
    world.json          manifest the viewer reads
    source.<ext>        copy of the historical photo
    splat_500k.spz      (and 100k / full_res if available)
    splat_full.ply      free PLY export (needed later for the provenance engine)
    marble_world.json   raw API response, kept for provenance

Coordinate notes (docs.worldlabs.ai/api/rendering-spz):
  - splats are in "marble_raw_opencv": +x right, +y down, +z forward
  - metric_scale_factor converts units -> meters; ground_plane_offset puts the ground at y=0
  - the viewer applies scale/offset then rotates 180° about X to land in three.js
"""
from __future__ import annotations

import argparse
import json
import mimetypes
import os
import shutil
import sys
import time
from pathlib import Path

import requests

API = "https://api.worldlabs.ai/marble/v1"
REPO = Path(__file__).resolve().parents[2]


def die(msg: str) -> None:
    print(f"error: {msg}", file=sys.stderr)
    sys.exit(1)


KEY_NAMES = ("WORLDLABS_API_KEY", "WORLDLAB_API_KEY", "WLT_API_KEY")


def api_key() -> str:
    key = next((os.environ[k] for k in KEY_NAMES if os.environ.get(k)), None)
    if not key:
        env = REPO / ".env"
        if env.exists():
            for line in env.read_text().splitlines():
                name, _, val = line.strip().partition("=")
                if name.strip() in KEY_NAMES and val:
                    key = val.strip().strip('"').strip("'")
    if not key:
        die("set WORLDLABS_API_KEY (env or .env). Keys: https://platform.worldlabs.ai/api-keys")
    return key


class Marble:
    def __init__(self, key: str):
        self.s = requests.Session()
        self.s.headers.update({"WLT-Api-Key": key, "Content-Type": "application/json"})

    def _check(self, r: requests.Response) -> dict:
        if r.status_code >= 400:
            die(f"{r.request.method} {r.url} -> {r.status_code}\n{r.text}")
        return r.json()

    def upload_image(self, path: Path) -> str:
        ext = path.suffix.lstrip(".").lower()
        if ext == "jpeg":
            ext = "jpg"
        if ext not in {"jpg", "png", "webp"}:
            die(f"unsupported image type .{ext} (jpg/png/webp)")
        prep = self._check(
            self.s.post(
                f"{API}/media-assets:prepare_upload",
                json={"file_name": path.name, "kind": "image", "extension": ext},
            )
        )
        info = prep["upload_info"]
        method = (info.get("upload_method") or "PUT").upper()
        put = requests.request(method, info["upload_url"], headers=info.get("required_headers") or {}, data=path.read_bytes())
        if put.status_code >= 400:
            die(f"upload PUT failed {put.status_code}: {put.text[:300]}")
        ma = prep["media_asset"]
        return ma.get("media_asset_id") or ma["id"]

    def generate(self, media_asset_id: str, *, model: str, name: str, text: str | None, seed: int | None) -> dict:
        prompt: dict = {
            "type": "image",
            "image_prompt": {"source": "media_asset", "media_asset_id": media_asset_id},
            "is_pano": "auto",
        }
        if text:
            prompt["text_prompt"] = text
        body: dict = {
            "display_name": name[:64],
            "model": model,
            "world_prompt": prompt,
            "tags": ["walk-the-past", "phase0"],
            "permission": {"public": False},
        }
        if seed is not None:
            body["seed"] = seed
        return self._check(self.s.post(f"{API}/worlds:generate", json=body))

    def operation(self, op_id: str) -> dict:
        # transient resets happen on long polls; retry a few times before giving up
        for attempt in range(6):
            try:
                return self._check(self.s.get(f"{API}/operations/{op_id}", timeout=60))
            except (requests.ConnectionError, requests.Timeout) as e:
                print(f"  (poll error, retry {attempt + 1}/6: {type(e).__name__})", flush=True)
                time.sleep(5 * (attempt + 1))
        die(f"operation {op_id} unreachable after retries")

    def wait(self, op: dict, label: str, every: float = 8.0) -> dict:
        op_id = op["operation_id"]
        print(f"  [{label}] operation_id = {op_id}", flush=True)
        t0 = time.time()
        while not op.get("done"):
            prog = (op.get("metadata") or {}).get("progress") or {}
            status = prog.get("status") or prog.get("percent") or ""
            print(f"  [{label}] {int(time.time() - t0):4d}s  {status}", flush=True)
            time.sleep(every)
            op = self.operation(op_id)
        if op.get("error"):
            die(f"{label} failed: {json.dumps(op['error'])}")
        cost = (op.get("cost") or {}).get("total_credits")
        print(f"  [{label}] done in {int(time.time() - t0)}s" + (f", {cost} credits" if cost is not None else ""))
        return op

    def world(self, world_id: str) -> dict:
        return self._check(self.s.get(f"{API}/worlds/{world_id}"))

    def export(self, world_id: str, asset_type: str, fmt: str, resolution: str | None = None) -> dict:
        body: dict = {"asset_type": asset_type, "format": fmt}
        if resolution:
            body["resolution"] = resolution
        return self._check(self.s.post(f"{API}/worlds/{world_id}:export", json=body))


def download(url: str, dest: Path) -> None:
    with requests.get(url, stream=True, timeout=600) as r:
        r.raise_for_status()
        total = int(r.headers.get("content-length") or 0)
        got = 0
        with open(dest, "wb") as f:
            for chunk in r.iter_content(1 << 20):
                f.write(chunk)
                got += len(chunk)
                if total:
                    print(f"\r  {dest.name}: {got / 1e6:6.1f}/{total / 1e6:6.1f} MB", end="", flush=True)
        print(f"\r  {dest.name}: {got / 1e6:.1f} MB            ")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--image", required=True, type=Path, help="historical source photo (jpg/png/webp)")
    ap.add_argument("--id", required=True, help="world id -> viewer/public/worlds/<id>")
    ap.add_argument("--name", help="display name (defaults to --id)")
    ap.add_argument("--model", default="marble-1.1", choices=["marble-1.0-draft", "marble-1.0", "marble-1.1", "marble-1.1-plus"])
    ap.add_argument("--text", help="optional text guidance for the generator")
    ap.add_argument("--seed", type=int)
    ap.add_argument("--world-id", help="skip generation; download an existing Marble world")
    ap.add_argument("--fov", type=float, default=None, help="guess for the source camera vertical FOV (deg) to seed the align tool")
    ap.add_argument("--no-ply", action="store_true", help="skip the free full-res PLY export")
    ap.add_argument("--out-root", type=Path, default=REPO / "viewer" / "public" / "worlds")
    args = ap.parse_args()

    if not args.image.exists():
        die(f"image not found: {args.image}")
    out = args.out_root / args.id
    out.mkdir(parents=True, exist_ok=True)
    m = Marble(api_key())

    if args.world_id:
        world_id = args.world_id
        print(f"fetching existing world {world_id}")
        world = m.world(world_id)
        gen_op = None
    else:
        print(f"uploading {args.image.name}")
        asset_id = m.upload_image(args.image)
        print(f"generating with {args.model} (this takes ~5 min)…")
        gen_op = m.generate(asset_id, model=args.model, name=args.name or args.id, text=args.text, seed=args.seed)
        gen_op = m.wait(gen_op, "generate")
        world = gen_op["response"]
        world_id = world.get("world_id") or world.get("id")
        print(f"world_id = {world_id}\nmarble url = {world.get('world_marble_url')}")

    (out / "marble_world.json").write_text(json.dumps({"world": world, "operation": gen_op}, indent=2))

    splats = (world.get("assets") or {}).get("splats") or {}
    spz_urls: dict = splats.get("spz_urls") or {}
    meta = splats.get("semantics_metadata") or {}
    if not spz_urls:
        die("world has no spz_urls yet; re-run with --world-id later")

    print("downloading splats")
    files: dict[str, str] = {}
    for tier, url in spz_urls.items():
        dest = out / f"splat_{tier}.spz"
        download(url, dest)
        files[tier] = dest.name

    if not args.no_ply:
        print("requesting free full-res PLY export")
        ex = m.export(world_id, "splats", "ply", "full_res")
        if not ex.get("done"):
            ex = m.wait(ex, "export-ply")
        url = (ex.get("response") or {}).get("url")
        if url:
            download(url, out / "splat_full.ply")
            files["ply_full"] = "splat_full.ply"
        else:
            print("  (no url in export response; see marble_world.json)")

    # copy the source photo next to the world
    ext = args.image.suffix.lower() or ".jpg"
    src_name = f"source{ext}"
    shutil.copy2(args.image, out / src_name)
    width = height = None
    try:
        from PIL import Image  # optional

        with Image.open(args.image) as im:
            width, height = im.size
    except Exception:
        pass

    # full_res (~2M splats) is far sharper up close; Spark's LoD keeps it at 60 fps on the M1.
    # Other tiers stay on disk and can be viewed with ?splat=splat_500k.spz
    preferred = files.get("full_res") or files.get("500k") or files.get("default") or next(iter(files.values()))
    manifest = {
        "id": args.id,
        "name": args.name or args.id,
        "generator": "marble",
        "splat": {"url": f"./{preferred}", "convention": "opencv", "lod": True},
        "metric": {
            "scaleFactor": float(meta.get("metric_scale_factor", 1.0)),
            "groundPlaneOffset": float(meta.get("ground_plane_offset", 0.0)),
        },
        "source": {"image": f"./{src_name}", "width": width, "height": height, "fovY": args.fov},
        "sourceCamera": None,
        "marble": {
            "world_id": world_id,
            "model": world.get("model") or args.model,
            "world_marble_url": world.get("world_marble_url"),
            "files": files,
            "mime": mimetypes.guess_type(src_name)[0],
        },
        "notes": "Generated by pipelines/marble/generate_world.py. Align the photographer in the viewer (R, then WASD/drag, then C) and paste the JSON into sourceCamera.",
    }
    (out / "world.json").write_text(json.dumps(manifest, indent=2))

    # register in the viewer's world index
    index_path = args.out_root / "index.json"
    index = json.loads(index_path.read_text()) if index_path.exists() else []
    index = [w for w in index if w.get("id") != args.id]
    index.insert(0, {"id": args.id, "name": f"Marble · {args.name or args.id}"})
    index_path.write_text(json.dumps(index, indent=2))

    print(f"\nwrote {out / 'world.json'}\nopen http://localhost:5173/?world={args.id}")


if __name__ == "__main__":
    main()
