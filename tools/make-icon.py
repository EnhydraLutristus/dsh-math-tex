#!/usr/bin/env python
"""Draw the plugin icon: a sigma mark on a rounded panel.

Kept as a script so the icon is reproducible rather than a binary with no provenance. The
glyph is drawn with strokes instead of a font so the result does not depend on which fonts
the machine happens to have.

RUN: python tools/make-icon.py      # from the repository root
"""

from pathlib import Path

from PIL import Image, ImageDraw

SIZE = 256
BG_TOP = (18, 34, 66)
BG_BOTTOM = (12, 22, 44)
INK = (245, 247, 250)
ACCENT = (255, 122, 89)  # the same family as the error colour this plugin exists to remove

out = Path(__file__).resolve().parent.parent / "icon.png"
image = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
draw = ImageDraw.Draw(image)

# Vertical gradient panel with rounded corners.
for y in range(SIZE):
    t = y / (SIZE - 1)
    colour = tuple(round(BG_TOP[i] + (BG_BOTTOM[i] - BG_TOP[i]) * t) for i in range(3))
    draw.line([(0, y), (SIZE, y)], fill=colour + (255,))
mask = Image.new("L", (SIZE, SIZE), 0)
ImageDraw.Draw(mask).rounded_rectangle([0, 0, SIZE - 1, SIZE - 1], radius=56, fill=255)
image.putalpha(mask)

# Sigma, drawn as three strokes so no font is required.
w = 18
left, right = 74, 182
top, bottom = 66, 190
mid = (top + bottom) // 2
draw.line([(left, top), (right, top)], fill=INK, width=w)
draw.line([(left, top), (right, bottom)], fill=INK, width=w)
draw.line([(left, bottom), (right, bottom)], fill=INK, width=w)
# A small mark under the sigma, in the accent colour, standing for the repaired region.
draw.line([(mid - 26, bottom + 24), (mid + 26, bottom + 24)], fill=ACCENT, width=w)

image.save(out)
print(f"wrote {out} ({out.stat().st_size} bytes)")
