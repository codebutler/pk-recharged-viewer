/**
 * state-extract.js -- extract IWRAM/EWRAM from an mGBA GBA savestate.
 *
 * JS port of research/tools/state_extract.py. Supported containers:
 *
 * - PNG savestate (mGBA default, incl. GUI .ss0-.ss9 slot files): a PNG whose
 *   `gbAs` chunk is the zlib-compressed 0x61000-byte serialized state.
 * - Raw serialized state (0x61000 bytes).
 * - libretro mGBA-core .st* (MinUI handhelds): the 0x61000-byte serialized state
 *   followed by appended savedata of core-dependent length.
 *
 * Within the 0x61000-byte state: IWRAM (0x8000) at +0x19000, EWRAM (0x40000) at
 * +0x21000.
 *
 * Pure ES module: no Node/Bun APIs. Inflate uses DecompressionStream, so the API
 * is async.
 */

export const STATE_SIZE = 0x61000;
export const IWRAM_OFF = 0x19000;
export const IWRAM_SIZE = 0x8000;
export const EWRAM_OFF = 0x21000;
export const EWRAM_SIZE = 0x40000;

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Error for an unrecognized/unusable savestate container. */
export class StateError extends Error {
  constructor(message) {
    super(message);
    this.name = "StateError";
  }
}

/** Python's "%#x": lowercase hex with an 0x prefix (0 renders as "0x0"). */
function hashHex(n) {
  return (n < 0 ? "-0x" : "0x") + Math.abs(n).toString(16);
}

function startsWithPng(blob) {
  if (blob.length < 8) return false;
  return PNG_MAGIC.every((b, i) => blob[i] === b);
}

async function inflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate"));
  const chunks = [];
  let total = 0;
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/**
 * Return the raw 0x61000-byte serialized state from a savestate file blob.
 * @param {Uint8Array} blob
 * @returns {Promise<Uint8Array>}
 */
export async function deserialize(blob) {
  if (startsWithPng(blob)) {
    const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
    let off = 8;
    while (off + 12 <= blob.length) {
      const length = view.getUint32(off, false); // PNG chunk lengths are big-endian
      const ctype = String.fromCharCode(blob[off + 4], blob[off + 5], blob[off + 6], blob[off + 7]);
      if (ctype === "gbAs") {
        const state = await inflate(blob.subarray(off + 8, off + 8 + length));
        if (state.length !== STATE_SIZE) {
          throw new StateError(
            `gbAs chunk decompressed to ${hashHex(state.length)} bytes (expected ` +
              `${hashHex(STATE_SIZE)}) -- not a GBA savestate?`,
          );
        }
        return state;
      }
      off += 12 + length;
    }
    throw new StateError("PNG file has no gbAs chunk -- not an mGBA savestate");
  }
  if (blob.length === STATE_SIZE) return blob;
  if (blob.length > STATE_SIZE) {
    // libretro-style container: serialized state first, appended extras after.
    // Verify it actually starts with a GBA state (version magic 0x010000xx, or the
    // 12-byte ROM title at +0x10) rather than blindly slicing.
    const magic = new DataView(blob.buffer, blob.byteOffset, blob.byteLength).getUint32(0, true);
    const title = String.fromCharCode(...blob.subarray(0x10, 0x1c));
    if ((magic & 0xffff0000) >>> 0 === 0x01000000 || title === "POKEMON FIRE") {
      return blob.subarray(0, STATE_SIZE);
    }
    throw new StateError(
      `file is larger than a GBA state (${hashHex(blob.length)} > ${hashHex(STATE_SIZE)}) ` +
        "but does not start with an mGBA state header",
    );
  }
  throw new StateError(
    `unrecognized savestate: not a PNG and smaller than ${hashHex(STATE_SIZE)} bytes ` +
      `(got ${hashHex(blob.length)}). Note: flash .sav files are not savestates.`,
  );
}

/**
 * Extract the two RAM regions from a savestate file blob.
 * @param {Uint8Array} blob raw bytes of a savestate file
 * @returns {Promise<{iwram: Uint8Array, ewram: Uint8Array}>}
 */
export async function extractRam(blob) {
  const state = await deserialize(blob);
  return {
    iwram: state.subarray(IWRAM_OFF, IWRAM_OFF + IWRAM_SIZE),
    ewram: state.subarray(EWRAM_OFF, EWRAM_OFF + EWRAM_SIZE),
  };
}
