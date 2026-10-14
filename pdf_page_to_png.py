"""Decode the scanned page stored in the PDF's indexed image XObject into a PNG."""
import re
import sys
import zlib

from PIL import Image

pdf, out = sys.argv[1], sys.argv[2]
data = open(pdf, "rb").read()
text = data.decode("latin-1")

# Palette from the /Indexed /DeviceRGB lookup string in the image XObject dict.
m = re.search(r"/ColorSpace\s*\[\s*/Indexed\s*/DeviceRGB\s+\d+\s*<([0-9A-Fa-f]+)>", text)
palette_hex = m.group(1)
palette = list(bytes.fromhex(palette_hex))
print(f"palette entries: {len(palette) // 3}", file=sys.stderr)

# Locate the image stream: the one whose dictionary has /Subtype /Image.
img_off = text.rfind("/Subtype /Image")
start = text.index("stream", img_off) + len("stream")
while text[start] in "\r\n":
    start += 1
end = text.index("endstream", start)
raw = data[start:end]
dec = zlib.decompress(raw)
w, h, bits = 1000, 1400, 4
print(f"inflated {len(dec)} bytes, expect {w * h * bits // 8}", file=sys.stderr)

img = Image.frombytes("P", (w, h), dec, "raw", "P;4")
img.putpalette(palette)
img.convert("RGB").save(out)
print(f"wrote {out}")
