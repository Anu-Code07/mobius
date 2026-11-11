"""Mobius Agent app icon: a Möbius loop (a lemniscate whose stroke twists thin at the crossing) on an indigo→violet gradient.

    python3 brand.py OUT_DIR      → OUT_DIR/icon-1024.png and the iOS sizes (AppIcon60x60@2x/@3x, AppIcon76x76@2x, AppIcon83.5x83.5@2x)
"""
import math
import os
import sys

from PIL import Image, ImageDraw, ImageFilter

S = 1024


def gradient():
    img = Image.new("RGB", (S, S))
    top, bottom = (24, 20, 74), (109, 40, 217)  # deep indigo → violet
    px = img.load()
    for y in range(S):
        for x in range(S):
            t = min(1.0, max(0.0, (0.65 * y + 0.35 * x) / S))
            px[x, y] = tuple(int(top[i] + (bottom[i] - top[i]) * t) for i in range(3))
    return img


def loop(draw, cx, cy, a, color, glow=False):
    # Lemniscate of Bernoulli; stroke width varies with |sin| so it pinches at the crossing (the Möbius twist).
    pts = []
    for i in range(1400):
        t = 2 * math.pi * i / 1400
        d = 1 + math.sin(t) ** 2
        x = cx + a * math.cos(t) / d
        y = cy + a * math.sin(t) * math.cos(t) / d
        w = (34 if glow else 22) + (70 if glow else 58) * abs(math.cos(t))
        pts.append((x, y, w))
    for x, y, w in pts:
        r = w / 2
        draw.ellipse((x - r, y - r, x + r, y + r), fill=color)


def icon():
    base = gradient()
    glow = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    loop(ImageDraw.Draw(glow), S / 2, S / 2 + 10, 360, (167, 139, 250, 150), glow=True)
    glow = glow.filter(ImageFilter.GaussianBlur(28))
    base.paste(glow, (0, 0), glow)
    mark = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    loop(ImageDraw.Draw(mark), S / 2, S / 2 + 10, 360, (255, 255, 255, 255))
    base.paste(mark, (0, 0), mark)
    # Small "agent" dot riding the loop.
    d = ImageDraw.Draw(base)
    d.ellipse((S / 2 + 300 - 34, S / 2 + 10 - 34, S / 2 + 300 + 34, S / 2 + 10 + 34), fill=(52, 211, 153))
    return base


if __name__ == "__main__":
    out = sys.argv[1] if len(sys.argv) > 1 else "."
    os.makedirs(out, exist_ok=True)
    big = icon()
    big.save(os.path.join(out, "icon-1024.png"))
    for name, px in [("AppIcon60x60@2x.png", 120), ("AppIcon60x60@3x.png", 180), ("AppIcon76x76@2x~ipad.png", 152), ("AppIcon83.5x83.5@2x~ipad.png", 167)]:
        big.resize((px, px), Image.LANCZOS).save(os.path.join(out, name))
    print(out)
