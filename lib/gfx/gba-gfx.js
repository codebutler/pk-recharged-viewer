/**
 * gba-gfx.js -- GBA graphics decoding primitives, browser-safe (no Node APIs).
 *
 * Port of research/tools/gba_gfx.py. Where the Python builds lists of
 * (r,g,b,a) tuples and writes PNGs, this produces flat RGBA
 * Uint8ClampedArrays ready for ImageData/canvas; PNG encoding is the
 * browser's job (see rgbaToDataURL).
 *
 * Building blocks:
 * - lz77Decompress(): GBA BIOS LZ77 (type 0x10 header).
 * - decodePalette(): 16 x BGR555 halfwords -> RGBA bytes (color 0 transparent).
 * - tilesToRGBA(): 4bpp linear 8x8 tiles + palette -> RGBA frame.
 * - composite(): alpha-skipping blit of one RGBA buffer onto another.
 */

/** Normalize an ArrayBuffer / TypedArray / Uint8Array to a Uint8Array view. */
export function asBytes(data) {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  throw new TypeError("expected ArrayBuffer or typed array");
}

/**
 * Decompress GBA BIOS LZ77 data starting at `offset`.
 * Header byte must be 0x10; bytes 1-3 hold the decompressed length.
 * Throws on a bad header or truncated stream.
 */
export function lz77Decompress(data, offset = 0) {
  const src = asBytes(data);
  if (src[offset] !== 0x10) {
    throw new Error(
      `not LZ77 data (header byte 0x${src[offset].toString(16)}, expected 0x10)`,
    );
  }
  const outLen = src[offset + 1] | (src[offset + 2] << 8) | (src[offset + 3] << 16);
  const out = new Uint8Array(outLen);
  let len = 0;
  let pos = offset + 4;
  while (len < outLen) {
    if (pos >= src.length) throw new Error("LZ77 stream truncated");
    const flags = src[pos++];
    for (let bit = 0; bit < 8 && len < outLen; bit++) {
      if (flags & (0x80 >> bit)) {
        const b1 = src[pos];
        const b2 = src[pos + 1];
        pos += 2;
        const runLen = (b1 >> 4) + 3;
        const disp = (((b1 & 0xf) << 8) | b2) + 1;
        // Byte-by-byte: runs may overlap themselves (disp < runLen).
        for (let i = 0; i < runLen && len < outLen; i++) {
          out[len] = out[len - disp];
          len++;
        }
      } else {
        out[len++] = src[pos++];
      }
    }
  }
  return out;
}

/**
 * 16 BGR555 halfwords -> Uint8ClampedArray of 16 RGBA quads (64 bytes).
 * Index i of the palette is bytes [i*4, i*4+4).
 */
export function decodePalette(palBytes, offset = 0, transparent0 = true) {
  const src = asBytes(palBytes);
  const view = new DataView(src.buffer, src.byteOffset, src.byteLength);
  const pal = new Uint8ClampedArray(16 * 4);
  for (let i = 0; i < 16; i++) {
    const v = view.getUint16(offset + i * 2, true);
    const r = (v & 0x1f) << 3;
    const g = ((v >> 5) & 0x1f) << 3;
    const b = ((v >> 10) & 0x1f) << 3;
    // replicate high bits into low bits for full-range 8-bit values
    pal[i * 4] = r | (r >> 5);
    pal[i * 4 + 1] = g | (g >> 5);
    pal[i * 4 + 2] = b | (b >> 5);
    pal[i * 4 + 3] = i === 0 && transparent0 ? 0 : 255;
  }
  return pal;
}

/** One 4bpp linear 8x8 tile (32 bytes) -> 64 palette indices, row-major. */
export function decodeTile(tileData, offset = 0, out = new Uint8Array(64)) {
  for (let i = 0; i < 32; i++) {
    const b = tileData[offset + i];
    out[i * 2] = b & 0xf;
    out[i * 2 + 1] = b >> 4;
  }
  return out;
}

/**
 * Assemble 4bpp tiles into an RGBA frame.
 *
 * tileData: widthTiles*heightTiles consecutive 32-byte tiles, laid out
 * row-major (the standard sprite-sheet frame order). palette: from
 * decodePalette(). hflip/vflip mirror the finished frame.
 * Returns {rgba, width, height}.
 */
export function tilesToRGBA(tileData, palette, widthTiles, heightTiles, opts = {}) {
  const { hflip = false, vflip = false } = opts;
  const src = asBytes(tileData);
  const w = widthTiles * 8;
  const h = heightTiles * 8;
  const need = widthTiles * heightTiles * 32;
  if (src.length < need) {
    throw new Error(`frame needs ${need} bytes of tiles, got ${src.length}`);
  }
  const rgba = new Uint8ClampedArray(w * h * 4);
  const tile = new Uint8Array(64);
  for (let t = 0; t < widthTiles * heightTiles; t++) {
    const tx = (t % widthTiles) * 8;
    const ty = Math.floor(t / widthTiles) * 8;
    decodeTile(src, t * 32, tile);
    for (let i = 0; i < 64; i++) {
      const idx = tile[i];
      const d = ((ty + (i >> 3)) * w + tx + (i & 7)) * 4;
      rgba[d] = palette[idx * 4];
      rgba[d + 1] = palette[idx * 4 + 1];
      rgba[d + 2] = palette[idx * 4 + 2];
      rgba[d + 3] = palette[idx * 4 + 3];
    }
  }
  if (!hflip && !vflip) return { rgba, width: w, height: h };
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const sy = vflip ? h - 1 - y : y;
    for (let x = 0; x < w; x++) {
      const sx = hflip ? w - 1 - x : x;
      const s = (sy * w + sx) * 4;
      const d = (y * w + x) * 4;
      out[d] = rgba[s];
      out[d + 1] = rgba[s + 1];
      out[d + 2] = rgba[s + 2];
      out[d + 3] = rgba[s + 3];
    }
  }
  return { rgba: out, width: w, height: h };
}

/**
 * Paste src RGBA onto dest in place, skipping fully transparent src pixels
 * and anything outside the destination bounds.
 */
export function composite(dest, dw, dh, src, sw, sh, x0, y0) {
  for (let y = 0; y < sh; y++) {
    const dy = y0 + y;
    if (dy < 0 || dy >= dh) continue;
    for (let x = 0; x < sw; x++) {
      const dx = x0 + x;
      if (dx < 0 || dx >= dw) continue;
      const s = (y * sw + x) * 4;
      if (!src[s + 3]) continue;
      const d = (dy * dw + dx) * 4;
      dest[d] = src[s];
      dest[d + 1] = src[s + 1];
      dest[d + 2] = src[s + 2];
      dest[d + 3] = src[s + 3];
    }
  }
}

/**
 * Crop an RGBA buffer; clamps to the image bounds exactly as the Python
 * gba_map.crop() does. Returns {rgba, width, height, x, y}.
 */
export function cropRGBA(rgba, W, H, x0Px, y0Px, wPx, hPx) {
  const w = Math.min(wPx, W);
  const h = Math.min(hPx, H);
  const x0 = Math.max(0, Math.min(x0Px, W - wPx));
  const y0 = Math.max(0, Math.min(y0Px, H - hPx));
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const s = ((y0 + y) * W + x0) * 4;
    out.set(rgba.subarray(s, s + w * 4), y * w * 4);
  }
  return { rgba: out, width: w, height: h, x: x0, y: y0 };
}

/** Wrap an RGBA buffer as ImageData (browser/worker only). */
export function toImageData(rgba, width, height) {
  return new ImageData(
    rgba instanceof Uint8ClampedArray ? rgba : new Uint8ClampedArray(rgba),
    width,
    height,
  );
}

/** Draw an RGBA buffer into a fresh canvas (OffscreenCanvas when available). */
export function toCanvas(rgba, width, height) {
  const canvas =
    typeof OffscreenCanvas !== "undefined"
      ? new OffscreenCanvas(width, height)
      : Object.assign(document.createElement("canvas"), { width, height });
  const ctx = canvas.getContext("2d");
  ctx.putImageData(toImageData(rgba, width, height), 0, 0);
  return canvas;
}

/**
 * PNG data URL for an RGBA buffer. Async because OffscreenCanvas only
 * offers convertToBlob(); a DOM canvas takes the synchronous toDataURL path.
 */
export async function rgbaToDataURL(rgba, width, height, type = "image/png") {
  const canvas = toCanvas(rgba, width, height);
  if (typeof canvas.toDataURL === "function") return canvas.toDataURL(type);
  const blob = await canvas.convertToBlob({ type });
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
  return `data:${type};base64,${btoa(bin)}`;
}
