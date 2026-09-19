#!/usr/bin/env python3
"""
Prepare a historical scan for world generation.

Why: Marble reproduces whatever is in the frame. A scan with a paper border,
mount or caption strip becomes a *framed picture inside a generated room*
instead of a walkable place. Lyra resizes to 16:9, so borders also waste pixels.

  python pipelines/prep_photo.py in.jpg out.jpg --auto-border          # trim bright/dark borders
  python pipelines/prep_photo.py in.jpg out.jpg --crop L T R B          # explicit pixel box
  python pipelines/prep_photo.py in.jpg out.jpg --auto-border --aspect 16:9   # then center-crop to 16:9 (Lyra)

Writes out.jpg plus out.crop.json with the crop box in ORIGINAL pixel coords,
so a later phase can map the generated world's camera back to the untouched scan.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
from PIL import Image


def auto_border(im: Image.Image, thresh: float = 0.10, margin_frac: float = 0.25) -> tuple[int, int, int, int]:
    """Find the content box by walking inward until a row/col has real variation
    (std of luminance > thresh) — paper borders and mounts are near-uniform."""
    g = np.asarray(im.convert("L"), dtype=np.float32) / 255.0
    h, w = g.shape
    row_std = g.std(axis=1)
    col_std = g.std(axis=0)
    def first(vals, limit):
        for i, v in enumerate(vals[:limit]):
            if v > thresh:
                return i
        return 0
    top = first(row_std, int(h * margin_frac))
    bottom = h - first(row_std[::-1], int(h * margin_frac))
    left = first(col_std, int(w * margin_frac))
    right = w - first(col_std[::-1], int(w * margin_frac))
    return left, top, right, bottom


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("src", type=Path)
    ap.add_argument("dst", type=Path)
    ap.add_argument("--auto-border", action="store_true")
    ap.add_argument("--pad", type=float, default=0.01, help="extra inset after auto-border, fraction of size")
    ap.add_argument("--crop", type=int, nargs=4, metavar=("L", "T", "R", "B"), help="explicit box in source pixels")
    ap.add_argument("--aspect", help="final center-crop aspect, e.g. 16:9 or 4:3")
    ap.add_argument("--max-side", type=int, default=0, help="downscale so the long side is at most this (0 = keep)")
    ap.add_argument("--quality", type=int, default=94)
    a = ap.parse_args()

    im = Image.open(a.src).convert("RGB")
    W, H = im.size
    box = [0, 0, W, H]
    if a.auto_border:
        box = list(auto_border(im))
        px, py = int((box[2] - box[0]) * a.pad), int((box[3] - box[1]) * a.pad)
        box = [box[0] + px, box[1] + py, box[2] - px, box[3] - py]
    if a.crop:
        box = list(a.crop)
    if a.aspect:
        num, den = (float(x) for x in a.aspect.split(":"))
        target = num / den
        bw, bh = box[2] - box[0], box[3] - box[1]
        if bw / bh > target:  # too wide: trim sides
            nw = int(bh * target); dx = (bw - nw) // 2
            box = [box[0] + dx, box[1], box[0] + dx + nw, box[3]]
        else:  # too tall: trim top/bottom
            nh = int(bw / target); dy = (bh - nh) // 2
            box = [box[0], box[1] + dy, box[2], box[1] + dy + nh]
    out = im.crop(tuple(box))
    scale = 1.0
    if a.max_side and max(out.size) > a.max_side:
        scale = a.max_side / max(out.size)
        out = out.resize((round(out.width * scale), round(out.height * scale)), Image.LANCZOS)
    a.dst.parent.mkdir(parents=True, exist_ok=True)
    out.save(a.dst, quality=a.quality)
    meta = {
        "source": str(a.src), "source_size": [W, H],
        "crop_box_source_px": box, "scale_after_crop": scale, "output_size": list(out.size),
        "note": "crop_box is [left, top, right, bottom] in original scan pixels; output = source.crop(box) * scale",
    }
    a.dst.with_suffix(".crop.json").write_text(json.dumps(meta, indent=2))
    print(f"{a.src.name}: {W}x{H} -> box {box} -> {out.size[0]}x{out.size[1]}  ({a.dst})")


if __name__ == "__main__":
    main()
