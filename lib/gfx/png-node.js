/**
 * png-node.js -- PNG encoder for the Bun-side tools (verify.js, the asset
 * exporter). NOT part of the browser bundle: it needs node:zlib, and the
 * browser gets its PNGs from canvas instead.
 *
 * Encodes truecolour with alpha (type 6) or, when every pixel is opaque,
 * truecolour (type 2) -- both lossless. Rows use adaptive filtering (the
 * standard minimum-sum-of-absolute-differences heuristic), which matters a
 * lot on 960x640 map renders.
 */

import { deflateSync } from "node:zlib";

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(tag, payload) {
  const body = Buffer.concat([Buffer.from(tag, "latin1"), Buffer.from(payload)]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(payload.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** True when no pixel in the RGBA buffer is even partially transparent. */
export function isOpaque(rgba) {
  for (let i = 3; i < rgba.length; i += 4) if (rgba[i] !== 255) return false;
  return true;
}

const paeth = (a, b, c) => {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

/** Filter one scanline five ways and keep the cheapest. */
function filterRow(cur, prev, bpp, out, outOff) {
  const n = cur.length;
  const cands = [];
  for (let type = 0; type < 5; type++) {
    const buf = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      let v;
      if (type === 0) v = cur[i];
      else if (type === 1) v = cur[i] - a;
      else if (type === 2) v = cur[i] - b;
      else if (type === 3) v = cur[i] - ((a + b) >> 1);
      else v = cur[i] - paeth(a, b, c);
      buf[i] = v & 0xff;
    }
    let sum = 0;
    for (let i = 0; i < n; i++) sum += buf[i] < 128 ? buf[i] : 256 - buf[i];
    cands.push({ type, buf, sum });
  }
  const best = cands.reduce((m, x) => (x.sum < m.sum ? x : m));
  out[outOff] = best.type;
  out.set(best.buf, outOff + 1);
}

/**
 * Encode an RGBA buffer as PNG. Drops the alpha channel when the image is
 * fully opaque (identical pixels, ~25% smaller file).
 */
export function encodePNG(rgba, width, height) {
  const opaque = isOpaque(rgba);
  const bpp = opaque ? 3 : 4;
  const stride = width * bpp;
  const raw = new Uint8Array(height * (stride + 1));
  let prev = new Uint8Array(stride);
  const cur = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    if (opaque) {
      for (let x = 0; x < width; x++) {
        const s = (y * width + x) * 4;
        cur[x * 3] = rgba[s];
        cur[x * 3 + 1] = rgba[s + 1];
        cur[x * 3 + 2] = rgba[s + 2];
      }
    } else {
      cur.set(rgba.subarray(y * stride, (y + 1) * stride));
    }
    filterRow(cur, prev, bpp, raw, y * (stride + 1));
    prev = Uint8Array.from(cur);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = opaque ? 2 : 6; // colour type
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(Buffer.from(raw), { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
