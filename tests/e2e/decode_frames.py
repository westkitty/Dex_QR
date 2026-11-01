#!/usr/bin/env python3
"""Decode every image in a directory with a real QR decoder and write decoded.json.

Decoders: zbar (via pyzbar + libzbar 0.23.x) or zxing-cpp. Each image is decoded independently.
Usage: decode_frames.py DIR [--decoder zbar|zxing] [--glob 'frame_*.png'] [--out decoded_zbar.json] [--jobs N]
Requires LD_LIBRARY_PATH to contain libzbar.so when --decoder zbar (see Makefile / README).
"""
import argparse, glob, json, os, sys, time
from multiprocessing import Pool

def init(decoder):
    global DEC, Image
    from PIL import Image as _I
    Image = _I
    if decoder == "zbar":
        from pyzbar import pyzbar
        from pyzbar.pyzbar import ZBarSymbol
        def dec(img):
            res = pyzbar.decode(img.convert("L"), symbols=[ZBarSymbol.QRCODE])
            return [r.data.decode("latin-1") for r in res]
    else:
        import zxingcpp
        def dec(img):
            res = zxingcpp.read_barcodes(img.convert("L"), formats=zxingcpp.BarcodeFormat.QRCode)
            return [r.text for r in res if r.valid]
    DEC = dec

def work(path):
    t = time.perf_counter()
    with Image.open(path) as im:
        texts = DEC(im)
    return os.path.basename(path), texts, (time.perf_counter() - t) * 1000

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("dir"); ap.add_argument("--decoder", default="zbar"); ap.add_argument("--glob", default="frame_*.png")
    ap.add_argument("--out"); ap.add_argument("--jobs", type=int, default=os.cpu_count())
    a = ap.parse_args()
    files = sorted(glob.glob(os.path.join(a.dir, a.glob)))
    t0 = time.time()
    with Pool(a.jobs, initializer=init, initargs=(a.decoder,)) as p:
        rows = p.map(work, files, chunksize=8)
    out = a.out or os.path.join(a.dir, f"decoded_{a.decoder}.json")
    ok = sum(1 for r in rows if r[1])
    ms = [r[2] for r in rows]
    summary = {"decoder": a.decoder, "files": len(files), "decoded": ok, "wall_s": round(time.time() - t0, 2),
               "ms_per_frame_mean": round(sum(ms) / max(1, len(ms)), 2), "ms_per_frame_max": round(max(ms or [0]), 2)}
    json.dump({"summary": summary, "frames": [{"file": f, "texts": t, "ms": round(m, 2)} for f, t, m in rows]}, open(out, "w"))
    print(json.dumps(summary))

if __name__ == "__main__":
    main()
