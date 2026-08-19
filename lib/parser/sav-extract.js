/**
 * sav-extract.js -- rebuild SaveBlock1 / SaveBlock2 / PokemonStorage from a
 * 128KB Gen-3 flash save (.sav).
 *
 * Layout (pokeemerald/src/save.c, confirmed against this hack's own save file):
 *   32 sectors x 4096 bytes. Each sector: 3968 usable bytes, then a footer at
 *   +0xFF4 of {u16 sectorId, u16 checksum, u32 signature (0x08012025), u32 counter}.
 *   Sectors 0-13 are save slot A, 14-27 slot B, 28-31 Hall of Fame / Trainer Hill
 *   / recorded battle (not parsed). Within a slot the sector ids are ROTATED, not
 *   positional -- the game shifts the starting sector each save to spread flash
 *   wear -- so blocks must be reassembled by id, never by position.
 *   Sector id 0 = SaveBlock2, ids 1-4 = SaveBlock1, ids 5-13 = PokemonStorage.
 *
 * The per-sector checksum covers only that chunk's REAL size, not the full 3968,
 * so the hack's struct sizes matter. That is also how this file independently
 * confirms them: with the hack's sizes (SB1 0x3D94, SB2 0xF64, storage 0x83D0)
 * all 28 sectors of the real save verify; with vanilla Emerald's sizes 4 fail.
 *
 * Pure ES module -- input is a Uint8Array, no platform APIs.
 */

import { SB1_SIZE, SB2_SIZE } from "./constants.js";

export const SAV_SIZE = 0x20000;
export const SECTOR_SIZE = 0x1000;
export const SECTOR_DATA_SIZE = 3968;
export const SECTOR_FOOTER_OFFSET = 0xff4;
export const SECTOR_SIGNATURE = 0x08012025;
export const NUM_SECTORS_PER_SLOT = 14;
export const STORAGE_SIZE = 0x83d0;

const SECTOR_ID_SAVEBLOCK2 = 0;
const SECTOR_ID_SAVEBLOCK1_START = 1;
const SECTOR_ID_PKMN_STORAGE_START = 5;

/** A .sav that cannot be read (wrong size, or no usable save slot). */
export class SavError extends Error {
  constructor(message) {
    super(message);
    this.name = "SavError";
  }
}

/**
 * sSaveSlotLayout: how many bytes of each block live in each sector id.
 * Mirrors the SAVEBLOCK_CHUNK macro — the last chunk of a block is the
 * remainder, and that is what the checksum covers.
 */
function slotLayout() {
  const sizes = {};
  const spread = (startId, total) => {
    for (let n = 0; total - n * SECTOR_DATA_SIZE > 0; n++) {
      sizes[startId + n] = Math.min(total - n * SECTOR_DATA_SIZE, SECTOR_DATA_SIZE);
    }
  };
  spread(SECTOR_ID_SAVEBLOCK2, SB2_SIZE);
  spread(SECTOR_ID_SAVEBLOCK1_START, SB1_SIZE);
  spread(SECTOR_ID_PKMN_STORAGE_START, STORAGE_SIZE);
  return sizes;
}

export const SECTOR_SIZES = slotLayout();

/**
 * The Gen-3 sector checksum: sum the data area as u32s (wrapping), then fold the
 * high half into the low half. The C accumulator wraps at 32 bits, so every add
 * is masked back with >>> 0.
 */
export function sectorChecksum(bytes, offset, size) {
  let sum = 0;
  for (let i = 0; i + 4 <= size; i += 4) {
    const w =
      (bytes[offset + i] |
        (bytes[offset + i + 1] << 8) |
        (bytes[offset + i + 2] << 16) |
        (bytes[offset + i + 3] << 24)) >>>
      0;
    sum = (sum + w) >>> 0;
  }
  return ((sum >>> 16) + sum) & 0xffff;
}

function readFooter(bytes, sector) {
  const off = sector * SECTOR_SIZE + SECTOR_FOOTER_OFFSET;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    id: dv.getUint16(off, true),
    checksum: dv.getUint16(off + 2, true),
    signature: dv.getUint32(off + 4, true),
    counter: dv.getUint32(off + 8, true),
  };
}

/**
 * Inspect one slot the way GetSaveValidStatus does: a sector counts only when its
 * signature matches AND its checksum verifies, and the slot is OK only when all
 * 14 ids are present.
 */
function inspectSlot(bytes, slot) {
  const first = slot * NUM_SECTORS_PER_SLOT;
  const seen = new Map();
  let signatureValid = false;
  let counter = 0;
  const bad = [];
  for (let i = 0; i < NUM_SECTORS_PER_SLOT; i++) {
    const sector = first + i;
    const f = readFooter(bytes, sector);
    if (f.signature !== SECTOR_SIGNATURE) continue;
    signatureValid = true;
    const size = SECTOR_SIZES[f.id];
    if (size === undefined) {
      bad.push(`sector ${sector}: unknown sector id ${f.id}`);
      continue;
    }
    const calc = sectorChecksum(bytes, sector * SECTOR_SIZE, size);
    if (calc !== f.checksum) {
      bad.push(
        `sector ${sector} (id ${f.id}): checksum 0x${calc.toString(16).toUpperCase().padStart(4, "0")} ` +
          `!= stored 0x${f.checksum.toString(16).toUpperCase().padStart(4, "0")}`,
      );
      continue;
    }
    counter = f.counter;
    seen.set(f.id, sector);
  }
  const status = !signatureValid ? "empty" : seen.size === NUM_SECTORS_PER_SLOT ? "ok" : "error";
  return { slot, status, counter, sectors: seen, verified: seen.size, problems: bad };
}

/** Pick the live slot exactly as GetSaveValidStatus does, wraparound included. */
function chooseSlot(a, b) {
  if (a.status === "ok" && b.status === "ok") {
    // The game's own wraparound special case: counter -1 (0xFFFFFFFF) next to 0
    // means the counter just wrapped, so the 0 is the NEWER save.
    const wrap =
      (a.counter === 0xffffffff && b.counter === 0) || (a.counter === 0 && b.counter === 0xffffffff);
    if (wrap) {
      return ((a.counter + 1) >>> 0) < ((b.counter + 1) >>> 0) ? b : a;
    }
    return a.counter < b.counter ? b : a;
  }
  if (a.status === "ok") return a;
  if (b.status === "ok") return b;
  return null;
}

/**
 * Parse a 128KB flash save into its three save blocks.
 *
 * @param {Uint8Array} bytes contents of a .sav file
 * @returns {{saveBlock1: Uint8Array, saveBlock2: Uint8Array, storage: Uint8Array,
 *            info: object}}
 */
export function parseFlashSave(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new SavError("flash save must be a Uint8Array");
  if (bytes.length !== SAV_SIZE) {
    throw new SavError(
      `not a 128KB flash save: got ${bytes.length} bytes (expected ${SAV_SIZE}). ` +
        "Gen-3 saves are exactly 128KB; a larger file is probably a savestate.",
    );
  }

  const slots = [inspectSlot(bytes, 0), inspectSlot(bytes, 1)];
  const chosen = chooseSlot(slots[0], slots[1]);
  if (chosen === null) {
    const detail = slots
      .map((s) => `slot ${"AB"[s.slot]} ${s.status} (${s.verified}/14 sectors verified)`)
      .join(", ");
    const problems = slots.flatMap((s) => s.problems).slice(0, 4);
    throw new SavError(
      `no usable save slot in this .sav: ${detail}` +
        (problems.length ? ` -- ${problems.join("; ")}` : "") +
        (slots.every((s) => s.status === "empty")
          ? ". Both slots are empty: the game has never saved to this file."
          : ""),
    );
  }

  const block = (startId, count, total) => {
    const out = new Uint8Array(total);
    let at = 0;
    for (let n = 0; n < count; n++) {
      const id = startId + n;
      const sector = chosen.sectors.get(id);
      const size = SECTOR_SIZES[id];
      out.set(bytes.subarray(sector * SECTOR_SIZE, sector * SECTOR_SIZE + size), at);
      at += size;
    }
    return out;
  };

  return {
    saveBlock2: block(SECTOR_ID_SAVEBLOCK2, 1, SB2_SIZE),
    saveBlock1: block(SECTOR_ID_SAVEBLOCK1_START, 4, SB1_SIZE),
    storage: block(SECTOR_ID_PKMN_STORAGE_START, 9, STORAGE_SIZE),
    info: {
      slot: "AB"[chosen.slot],
      saveCounter: chosen.counter,
      sectorsVerified: chosen.verified,
      otherSlot: {
        slot: "AB"[1 - chosen.slot],
        status: slots[1 - chosen.slot].status,
        saveCounter: slots[1 - chosen.slot].counter,
      },
    },
  };
}
