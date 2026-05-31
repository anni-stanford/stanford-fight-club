"""
chroma_key.py — turn the green-screen boxer renders into clean transparent PNGs.

For each green-*.png in the project assets folder, we remove the flat chroma
green background, feather the edges, and de-spill residual green so the cutout
sits cleanly over the webcam feed. Output overwrites boxer-*.png (the names the
game already references), so no code changes are needed.

Run:  python3 tools/chroma_key.py
"""
import os
import numpy as np
from PIL import Image

ASSETS = os.path.join(os.path.dirname(__file__), "..", "assets")

PAIRS = [
    ("green-idle.png", "boxer-idle.png"),
    ("green-attack.png", "boxer-attack.png"),
    ("green-block.png", "boxer-block.png"),
    ("green-hit-jab.png", "boxer-hit-jab.png"),
    ("green-hit-hook.png", "boxer-hit-hook.png"),
    ("green-hit-cross.png", "boxer-hit-cross.png"),
    ("green-ko.png", "boxer-ko.png"),
]


def key(infile, outfile):
    im = Image.open(infile).convert("RGBA")
    a = np.array(im).astype(np.int16)
    r, g, b, al = a[..., 0], a[..., 1], a[..., 2], a[..., 3]

    greenness = g - np.maximum(r, b)          # how much green dominates

    out_al = al.copy().astype(np.float32)
    out_al[greenness > 45] = 0                # solid background -> transparent

    edge = (greenness > 12) & (greenness <= 45)   # feather the rim
    out_al[edge] = out_al[edge] * ((45 - greenness[edge]) / 33.0)

    # de-spill: pull green back down to the r/b average where it's spilling
    g2 = g.copy()
    spill = g > (r + b) // 2
    g2[spill] = ((r[spill] + b[spill]) // 2)

    out = np.dstack([r, g2, b, out_al]).astype(np.uint8)
    Image.fromarray(out, "RGBA").save(outfile)
    print("keyed", os.path.basename(outfile))


if __name__ == "__main__":
    for src, dst in PAIRS:
        key(os.path.join(ASSETS, src), os.path.join(ASSETS, dst))
    print("done")
