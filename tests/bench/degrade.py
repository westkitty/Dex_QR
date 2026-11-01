#!/usr/bin/env python3
"""Synthetic camera-like degradation of clean QR frames (NOT a real camera; a repeatable stress test).

Levels:
  moderate: code side 600 px on a 1280x720 frame, levels 45/215, rotate 4 deg, Gaussian blur 1.2 px,
            noise sigma 8, JPEG q75
  harsh:    code side 360 px on 1280x720, levels 60/200, rotate 7 deg, blur 1.4 px, noise sigma 10, JPEG q60
Usage: degrade.py SRC DST LEVEL   (writes DST/frame_XXXXX.jpg)
"""
import glob, os, sys
from PIL import Image, ImageFilter
import numpy as np
LEVELS = {
    "moderate": dict(side=600, lo=45, hi=215, rot=4, blur=1.2, noise=8, q=75),
    "harsh": dict(side=360, lo=60, hi=200, rot=7, blur=1.4, noise=10, q=60),
}
src, dst, level = sys.argv[1], sys.argv[2], sys.argv[3]
p = LEVELS[level]
os.makedirs(dst, exist_ok=True)
rng = np.random.default_rng(7)
for f in sorted(glob.glob(os.path.join(src, "frame_*.png"))):
    side = p["side"]
    q = Image.open(f).convert("L").resize((side, side), Image.BILINEAR)
    a = np.asarray(q, dtype=np.float32) / 255.0 * (p["hi"] - p["lo"]) + p["lo"]
    canvas = np.full((720, 1280), 30.0, dtype=np.float32)
    y0, x0 = (720 - side) // 2, (1280 - side) // 2
    canvas[y0:y0 + side, x0:x0 + side] = a
    im = Image.fromarray(canvas.clip(0, 255).astype(np.uint8)).rotate(p["rot"], resample=Image.BICUBIC, fillcolor=30)
    im = im.filter(ImageFilter.GaussianBlur(p["blur"]))
    n = np.asarray(im, dtype=np.float32) + rng.normal(0, p["noise"], (720, 1280))
    Image.fromarray(n.clip(0, 255).astype(np.uint8)).save(os.path.join(dst, os.path.basename(f).replace(".png", ".jpg")), quality=p["q"])
