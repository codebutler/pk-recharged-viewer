"""extract-card-trainer.py -- cut the trainer figure out of the trainer-card capture.

The card's own trainer art is not the same drawing as the vendored full-body
trainer pic (that one is a slimmer figure); the card draws a chunkier 58x60
sprite. It is BG art, not an object -- every OAM entry in the capture is
disabled -- so there is no sprite sheet to decode. The capture's framebuffer IS
the art as the game draws it, so the figure is cut out of
research/dumps/trainer-card/card-front/screen.png.

Separating figure from card cannot be done by colour alone: the figure contains
85 pixels (84 white, 1 pale blue) in colours the card also uses, so keying those
out punches holes in it. Instead the card background is found by flood-filling
inwards from the border of a window around the figure; anything the fill cannot
reach is figure, enclosed highlights included.

Usage:  python3 tools/extract-card-trainer.py [--out research/tools/assets/trainer-card-male.png]

The result is committed as a source asset alongside trainer-pic-male.png;
tools/extract-rom-assets.js copies it into public/ and records it in the
manifest, exactly as it does the vendored pic.
"""

import os
import struct
import sys
import zlib

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(REPO, "research", "tools"))

import gba_gfx  # noqa: E402

CAPTURE = os.path.join(REPO, "research", "dumps", "trainer-card",
                       "card-front", "screen.png")
DEFAULT_OUT = os.path.join(REPO, "research", "tools", "assets",
                           "trainer-card-male.png")

# The card's own palette, measured off the same capture. Anything else in the
# window is figure.
CARD_COLORS = {
    (0xFF, 0xFF, 0xFF), (0xE7, 0xF7, 0xF7), (0xD6, 0xE7, 0xF7),
    (0xC6, 0xD6, 0xE7), (0x84, 0xBD, 0xE7), (0x6B, 0xA5, 0xDE),
    (0x63, 0x63, 0x63), (0xD6, 0xD6, 0xCE), (0x63, 0x63, 0x73),
    (0xA5, 0xA5, 0xA5),
}
# A window around the figure, padded so the flood fill starts on card pixels.
WINDOW = (146, 46, 215, 117)


def decode_png(path):
    """8-bit truecolour PNG (with or without alpha) -> (pixels, w, h)."""
    with open(path, "rb") as f:
        data = f.read()
    assert data[:8] == b"\x89PNG\r\n\x1a\n", "not a PNG: %s" % path
    pos, idat = 8, bytearray()
    while pos < len(data):
        (length,) = struct.unpack_from(">I", data, pos)
        tag = data[pos + 4:pos + 8]
        body = data[pos + 8:pos + 8 + length]
        if tag == b"IHDR":
            w, h, depth, ctype = struct.unpack_from(">IIBB", body, 0)
            assert depth == 8 and ctype in (2, 6), "unsupported PNG"
        elif tag == b"IDAT":
            idat += body
        pos += 12 + length
    bpp = 3 if ctype == 2 else 4
    raw = zlib.decompress(bytes(idat))
    stride = w * bpp
    out, prev = [], bytearray(stride)
    for y in range(h):
        ft = raw[y * (stride + 1)]
        line = bytearray(raw[y * (stride + 1) + 1:(y + 1) * (stride + 1)])
        for i in range(stride):
            a = line[i - bpp] if i >= bpp else 0
            b = prev[i]
            c = prev[i - bpp] if i >= bpp else 0
            if ft == 1:
                line[i] = (line[i] + a) & 0xFF
            elif ft == 2:
                line[i] = (line[i] + b) & 0xFF
            elif ft == 3:
                line[i] = (line[i] + ((a + b) >> 1)) & 0xFF
            elif ft == 4:
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[i] = (line[i] + pr) & 0xFF
        for x in range(w):
            q = line[x * bpp:x * bpp + bpp]
            out.append((q[0], q[1], q[2], 255 if bpp == 3 else q[3]))
        prev = line
    return out, w, h


def main():
    out_path = DEFAULT_OUT
    if "--out" in sys.argv:
        out_path = os.path.abspath(sys.argv[sys.argv.index("--out") + 1])

    px, w, _ = decode_png(CAPTURE)
    x0, y0, x1, y1 = WINDOW
    win_w, win_h = x1 - x0 + 1, y1 - y0 + 1
    at = lambda x, y: px[(y0 + y) * w + (x0 + x)][:3]

    # Flood-fill the card background inwards from the window border.
    is_bg = [[False] * win_w for _ in range(win_h)]
    stack = [(x, y) for x in range(win_w) for y in (0, win_h - 1)]
    stack += [(x, y) for y in range(win_h) for x in (0, win_w - 1)]
    while stack:
        x, y = stack.pop()
        if not (0 <= x < win_w and 0 <= y < win_h):
            continue
        if is_bg[y][x] or at(x, y) not in CARD_COLORS:
            continue
        is_bg[y][x] = True
        stack += [(x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)]

    # Keep only the largest connected blob of unfilled pixels. The card uses a
    # few near-white shades that are not in CARD_COLORS (e.g. #deefff), and a
    # single such pixel in a corner would otherwise stretch the bounding box --
    # that is exactly what makes this figure look like a 58x60 sprite when it
    # is really 26x55.
    seen = [[False] * win_w for _ in range(win_h)]
    best = []
    for sy in range(win_h):
        for sx in range(win_w):
            if is_bg[sy][sx] or seen[sy][sx]:
                continue
            blob, stack = [], [(sx, sy)]
            while stack:
                x, y = stack.pop()
                if not (0 <= x < win_w and 0 <= y < win_h):
                    continue
                if seen[y][x] or is_bg[y][x]:
                    continue
                seen[y][x] = True
                blob.append((x, y))
                stack += [(x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1),
                          (x + 1, y + 1), (x - 1, y - 1), (x + 1, y - 1), (x - 1, y + 1)]
            if len(blob) > len(best):
                best = blob
    dropped = sum(1 for y in range(win_h) for x in range(win_w)
                  if not is_bg[y][x]) - len(best)
    if dropped:
        print("dropped %d stray pixel(s) not connected to the figure" % dropped)
    figure = set(best)
    for y in range(win_h):
        for x in range(win_w):
            if (x, y) not in figure:
                is_bg[y][x] = True

    fx0 = min(x for x, _ in best)
    fx1 = max(x for x, _ in best)
    fy0 = min(y for _, y in best)
    fy1 = max(y for _, y in best)
    fw, fh = fx1 - fx0 + 1, fy1 - fy0 + 1

    pixels = []
    opaque = 0
    for y in range(fy0, fy1 + 1):
        for x in range(fx0, fx1 + 1):
            if is_bg[y][x]:
                pixels.append((0, 0, 0, 0))
            else:
                pixels.append(at(x, y) + (255,))
                opaque += 1

    with open(out_path, "wb") as f:
        f.write(gba_gfx.rgba_to_png(pixels, fw, fh))
    print("figure at capture x %d..%d y %d..%d -> %dx%d, %d opaque px -> %s"
          % (x0 + fx0, x0 + fx1, y0 + fy0, y0 + fy1, fw, fh, opaque,
             os.path.relpath(out_path, REPO)))
    return fw, fh


if __name__ == "__main__":
    main()
