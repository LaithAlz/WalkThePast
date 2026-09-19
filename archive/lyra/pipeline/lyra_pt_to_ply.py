#!/usr/bin/env python3
"""
Convert Lyra 1.0's `gaussians_*.ply` (which is actually a torch.save archive of a
[1, N, 14] tensor: xyz, opacity, scale(3), quat(4), rgb(3), all *activated*) into a
standard 3D Gaussian Splatting PLY that Spark / SuperSplat / gsplat can load.

Pure numpy: reads the raw storage out of the zip, so it runs on the laptop without torch.

  python pipelines/lyra/lyra_pt_to_ply.py in.ply out.ply [--prune 0.005]
"""
from __future__ import annotations

import argparse
import pickletools
import zipfile
from pathlib import Path

import numpy as np


def storage_dtype(pkl: bytes) -> np.dtype:
    """Find the torch storage class named in the pickle (HalfStorage, BFloat16Storage, FloatStorage)."""
    names = [arg for op, arg, _ in pickletools.genops(pkl) if isinstance(arg, str)]
    for n in names:
        if "BFloat16" in n:
            return np.dtype("bfloat16") if hasattr(np, "bfloat16") else np.dtype("uint16")  # handled below
        if "Half" in n:
            return np.dtype("<f2")
        if "Float" in n and "Storage" in n:
            return np.dtype("<f4")
    raise SystemExit(f"could not infer dtype from pickle; names seen: {names[:20]}")


def load_tensor(path: Path) -> np.ndarray:
    with zipfile.ZipFile(path) as z:
        names = z.namelist()
        pkl = z.read(next(n for n in names if n.endswith("data.pkl")))
        raw = z.read(next(n for n in names if "/data/" in n))
    dt = storage_dtype(pkl)
    if dt == np.dtype("uint16"):  # bfloat16 without numpy support: widen to float32 by shifting
        u = np.frombuffer(raw, dtype="<u2").astype(np.uint32) << 16
        arr = u.view(np.float32)
    else:
        arr = np.frombuffer(raw, dtype=dt).astype(np.float32)
    if arr.size % 14:
        raise SystemExit(f"element count {arr.size} not divisible by 14; wrong dtype?")
    return arr.reshape(-1, 14)


def write_ply(out: Path, g: np.ndarray, prune: float) -> int:
    xyz = g[:, 0:3]
    opa = g[:, 3:4]
    scl = g[:, 4:7]
    rot = g[:, 7:11]
    rgb = g[:, 11:14]
    if prune > 0:
        m = opa[:, 0] >= prune
        xyz, opa, scl, rot, rgb = xyz[m], opa[m], scl[m], rot[m], rgb[m]
    eps = 1e-6
    opa = np.clip(opa, eps, 1 - eps)
    opacity = np.log(opa / (1 - opa))               # inverse sigmoid
    scales = np.log(np.maximum(scl, 1e-8))          # log scale
    f_dc = (rgb - 0.5) / 0.28209479177387814        # SH degree-0 coefficient
    n = xyz.shape[0]
    cols = ["x", "y", "z", "f_dc_0", "f_dc_1", "f_dc_2", "opacity", "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3"]
    data = np.concatenate([xyz, f_dc, opacity, scales, rot], axis=1).astype("<f4")
    header = "ply\nformat binary_little_endian 1.0\nelement vertex %d\n%s\nend_header\n" % (
        n, "\n".join(f"property float {c}" for c in cols))
    with open(out, "wb") as f:
        f.write(header.encode("ascii"))
        f.write(np.ascontiguousarray(data).tobytes())
    return n


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("src", type=Path)
    ap.add_argument("dst", type=Path)
    ap.add_argument("--prune", type=float, default=0.005, help="drop gaussians with opacity below this (0 = keep all)")
    a = ap.parse_args()
    g = load_tensor(a.src)
    print(f"loaded {g.shape[0]:,} gaussians; opacity range {g[:,3].min():.3f}..{g[:,3].max():.3f}; xyz extent {np.abs(g[:,0:3]).max():.2f}")
    n = write_ply(a.dst, g, a.prune)
    print(f"wrote {n:,} gaussians -> {a.dst} ({a.dst.stat().st_size/1e6:.1f} MB)")


if __name__ == "__main__":
    main()
