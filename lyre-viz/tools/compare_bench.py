"""Compare deux dossiers de banc d'essai (LyreViz --bench) : temps et images.

    python tools/compare_bench.py bench/v0 bench/v1 [--diff dossier]

Pour chaque cas : temps GPU avant / apres, et ecart entre les deux images
(PSNR en dB, part des pixels qui changent de plus de 4/255 et de plus de 16/255).
Avec --diff, ecrit une image d'ecart amplifiee (x8) par cas.
"""
import os
import re
import sys

import numpy as np
from PIL import Image


def read_results(folder):
    cases = {}
    cur = None
    with open(os.path.join(folder, "resultats.txt"), encoding="utf-8", errors="replace") as f:
        for line in f:
            m = re.match(r"\[(\d+)\] (.*)", line)
            if m:
                cur = int(m.group(1))
                cases[cur] = {"name": m.group(2).strip(), "passes": {}}
                continue
            m = re.search(r"image : ([\d.]+) ms .*GPU : ([\d.]+) ms", line)
            if m and cur:
                cases[cur]["frame"] = float(m.group(1))
                cases[cur]["gpu"] = float(m.group(2))
                continue
            m = re.match(r"\s{4}(.+?)\s+([\d.]+) ms", line)
            if m and cur:
                cases[cur]["passes"][m.group(1).strip()] = float(m.group(2))
    return cases


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    diff_dir = None
    if "--diff" in sys.argv:
        diff_dir = sys.argv[sys.argv.index("--diff") + 1]
        args.remove(diff_dir)
        os.makedirs(diff_dir, exist_ok=True)
    a, b = args[0], args[1]
    ra, rb = read_results(a), read_results(b)
    print(f"{'cas':<44} {'GPU avant':>10} {'GPU apres':>10} {'gain':>7}   {'PSNR':>7} {'>4/255':>8} {'>16/255':>8}")
    for k in sorted(ra):
        if k not in rb:
            continue
        ca, cb = ra[k], rb[k]
        line = f"[{k:02d}] {ca['name'][:39]:<39} {ca.get('gpu', 0):>8.2f}ms {cb.get('gpu', 0):>8.2f}ms {ca.get('gpu', 0) / max(cb.get('gpu', 1e-9), 1e-9):>6.2f}x"
        pa, pb = os.path.join(a, f"{k:02d}.bmp"), os.path.join(b, f"{k:02d}.bmp")
        if os.path.exists(pa) and os.path.exists(pb):
            ia = np.asarray(Image.open(pa).convert("RGB")).astype(np.float32)
            ib = np.asarray(Image.open(pb).convert("RGB")).astype(np.float32)
            if ia.shape == ib.shape:
                d = np.abs(ia - ib)
                mse = float(np.mean(d * d))
                psnr = 99.0 if mse == 0 else 10 * np.log10(255.0 ** 2 / mse)
                dm = d.max(axis=2)
                line += f"   {psnr:>6.1f}  {100 * np.mean(dm > 4):>6.2f}%  {100 * np.mean(dm > 16):>6.3f}%"
                if diff_dir:
                    Image.fromarray(np.clip(d * 8, 0, 255).astype(np.uint8)).save(os.path.join(diff_dir, f"{k:02d}_diff.png"))
        print(line)
    # detail par passe pour les cas communs
    print()
    for k in sorted(ra):
        if k not in rb:
            continue
        parts = []
        for name, va in ra[k]["passes"].items():
            vb = rb[k]["passes"].get(name)
            if vb is not None and (va > 0.3 or vb > 0.3):
                parts.append(f"{name} {va:.2f}->{vb:.2f}")
        print(f"[{k:02d}] " + " | ".join(parts))


if __name__ == "__main__":
    main()
