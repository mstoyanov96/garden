#!/usr/bin/env python3
"""Remove solid backgrounds from the bucket photos and export uniform transparent PNGs."""
import os
from collections import deque
from PIL import Image

SRC = os.path.join(os.path.dirname(__file__), "..")
OUT = os.path.join(SRC, "app", "assets")
os.makedirs(OUT, exist_ok=True)

JOBS = [
    ("kofa_ot_sirene.jpg", "bucket_cheese.png", 70),
    ("kofa_cherna.jpeg", "bucket_black.png", 55),
    ("kofa_krugla.jpeg", "bucket_round.png", 18),
]

SIZE = 320  # final square canvas


def flood_remove_bg(img, tol):
    img = img.convert("RGBA")
    w, h = img.size
    px = img.load()
    # seed background colour = average of the four corners
    corners = [px[0, 0], px[w - 1, 0], px[0, h - 1], px[w - 1, h - 1]]
    sr = sum(c[0] for c in corners) // 4
    sg = sum(c[1] for c in corners) // 4
    sb = sum(c[2] for c in corners) // 4

    def is_bg(c):
        return abs(c[0] - sr) <= tol and abs(c[1] - sg) <= tol and abs(c[2] - sb) <= tol

    seen = bytearray(w * h)
    q = deque()
    for x in range(w):
        for y in (0, h - 1):
            if not seen[y * w + x] and is_bg(px[x, y]):
                seen[y * w + x] = 1
                q.append((x, y))
    for y in range(h):
        for x in (0, w - 1):
            if not seen[y * w + x] and is_bg(px[x, y]):
                seen[y * w + x] = 1
                q.append((x, y))

    while q:
        x, y = q.popleft()
        px[x, y] = (0, 0, 0, 0)
        for nx, ny in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
            if 0 <= nx < w and 0 <= ny < h and not seen[ny * w + nx] and is_bg(px[nx, ny]):
                seen[ny * w + nx] = 1
                q.append((nx, ny))
    return img


def crop_to_content(img):
    bbox = img.getbbox()
    return img.crop(bbox) if bbox else img


def to_square(img):
    img = crop_to_content(img)
    w, h = img.size
    side = max(w, h)
    canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    canvas.paste(img, ((side - w) // 2, (side - h) // 2), img)
    return canvas.resize((SIZE, SIZE), Image.LANCZOS)


for src, dst, tol in JOBS:
    img = Image.open(os.path.join(SRC, src))
    out = to_square(flood_remove_bg(img, tol))
    out.save(os.path.join(OUT, dst))
    print("wrote", dst, out.size)
