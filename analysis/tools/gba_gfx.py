"""gba_gfx.py -- minimal GBA graphics decoding (stdlib only).

Building blocks for extracting overworld sprites from the ROM:

- lz77_decompress(): GBA BIOS LZ77 (type 0x10 header) -- used by compressed
  graphics; uncompressed data can be used as-is.
- decode_palette(): 16 x BGR555 halfwords -> RGBA tuples (color 0 transparent).
- tiles_to_png(): 4bpp linear 8x8 tiles + palette -> PNG bytes, assembled as a
  frame of width_tiles x height_tiles (e.g. 2x4 for a 16x32 walking frame,
  4x4 for a 32x32 bike frame), with optional horizontal mirroring (the GBA
  h-flips one side sprite to get the other).

The PNG writer is self-contained (zlib + struct); no PIL dependency.
"""

import struct
import zlib


def lz77_decompress(data, offset=0):
    """Decompress GBA BIOS LZ77 data starting at `offset`.

    The header byte must be 0x10; bytes 1-3 hold the decompressed length.
    Returns the decompressed bytes. Raises ValueError on a bad header or
    truncated stream.
    """
    if data[offset] != 0x10:
        raise ValueError("not LZ77 data (header byte 0x%02X, expected 0x10)"
                         % data[offset])
    out_len = data[offset + 1] | (data[offset + 2] << 8) | (data[offset + 3] << 16)
    out = bytearray()
    pos = offset + 4
    while len(out) < out_len:
        if pos >= len(data):
            raise ValueError("LZ77 stream truncated")
        flags = data[pos]
        pos += 1
        for bit in range(8):
            if len(out) >= out_len:
                break
            if flags & (0x80 >> bit):
                b1, b2 = data[pos], data[pos + 1]
                pos += 2
                length = (b1 >> 4) + 3
                disp = ((b1 & 0xF) << 8 | b2) + 1
                for _ in range(length):
                    out.append(out[-disp])
            else:
                out.append(data[pos])
                pos += 1
    return bytes(out[:out_len])


def decode_palette(pal_bytes, transparent0=True):
    """16 BGR555 halfwords -> list of 16 (r, g, b, a) tuples."""
    colors = []
    for i in range(16):
        v = struct.unpack_from("<H", pal_bytes, i * 2)[0]
        r = (v & 0x1F) << 3
        g = ((v >> 5) & 0x1F) << 3
        b = ((v >> 10) & 0x1F) << 3
        # replicate high bits into low bits for full-range 8-bit values
        colors.append((r | r >> 5, g | g >> 5, b | b >> 5,
                       0 if (i == 0 and transparent0) else 255))
    return colors


def _decode_tile(tile_bytes):
    """One 4bpp linear 8x8 tile (32 bytes) -> 64 palette indices row-major."""
    px = []
    for b in tile_bytes:
        px.append(b & 0xF)
        px.append(b >> 4)
    return px


def _png_chunk(tag, payload):
    chunk = tag + payload
    return struct.pack(">I", len(payload)) + chunk + struct.pack(
        ">I", zlib.crc32(chunk) & 0xFFFFFFFF)


def rgba_to_png(pixels, width, height):
    """Row-major (r,g,b,a) pixel list -> PNG bytes."""
    raw = bytearray()
    for y in range(height):
        raw.append(0)  # filter: none
        for x in range(width):
            raw.extend(pixels[y * width + x])
    return (b"\x89PNG\r\n\x1a\n"
            + _png_chunk(b"IHDR", struct.pack(">IIBBBBB", width, height,
                                              8, 6, 0, 0, 0))
            + _png_chunk(b"IDAT", zlib.compress(bytes(raw), 9))
            + _png_chunk(b"IEND", b""))


def tiles_to_pixels(tile_data, palette, width_tiles, height_tiles, hflip=False):
    """Assemble 4bpp tiles into a row-major RGBA pixel list.

    tile_data: width_tiles*height_tiles consecutive 32-byte tiles, laid out
    row-major (the standard sprite-sheet frame order). palette: from
    decode_palette(). hflip mirrors the finished frame horizontally.
    Returns (pixels, width_px, height_px)."""
    w, h = width_tiles * 8, height_tiles * 8
    need = width_tiles * height_tiles * 32
    if len(tile_data) < need:
        raise ValueError("frame needs %d bytes of tiles, got %d"
                         % (need, len(tile_data)))
    pixels = [(0, 0, 0, 0)] * (w * h)
    for t in range(width_tiles * height_tiles):
        tx, ty = (t % width_tiles) * 8, (t // width_tiles) * 8
        tile = _decode_tile(tile_data[t * 32:(t + 1) * 32])
        for i, idx in enumerate(tile):
            pixels[(ty + i // 8) * w + tx + i % 8] = palette[idx]
    if hflip:
        pixels = [pixels[y * w + (w - 1 - x)]
                  for y in range(h) for x in range(w)]
    return pixels, w, h


def tiles_to_png(tile_data, palette, width_tiles, height_tiles, hflip=False):
    """tiles_to_pixels, PNG-encoded."""
    pixels, w, h = tiles_to_pixels(tile_data, palette, width_tiles,
                                   height_tiles, hflip)
    return rgba_to_png(pixels, w, h)


def composite(dest, dw, dh, src, sw, sh, x0, y0):
    """Paste src pixels onto dest in place, skipping transparent src pixels
    and anything outside the destination bounds."""
    for y in range(sh):
        dy = y0 + y
        if not (0 <= dy < dh):
            continue
        for x in range(sw):
            dx = x0 + x
            p = src[y * sw + x]
            if p[3] and 0 <= dx < dw:
                dest[dy * dw + dx] = p
