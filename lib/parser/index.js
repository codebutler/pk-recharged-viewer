/**
 * Public entry point for the browser-safe parser.
 *
 *   import { parseRam, parseSavestate } from "./lib/parser/index.js";
 *   const state = parseRam({ iwram, ewram });          // Uint8Arrays
 *   const state2 = await parseSavestate(savestateBytes);
 */

import { createContext } from "./data.js";
import { Dump, DumpError, parseState } from "./parse-ram.js";
import { parseSaveBlocks } from "./parse-blocks.js";
import { parseFlashSave, SAV_SIZE, SECTOR_SIGNATURE } from "./sav-extract.js";
import { extractRam } from "./state-extract.js";

export { Dump, DumpError, parseState } from "./parse-ram.js";
export { Config, GameData } from "./config.js";
export { Codec, parseBoxPokemon, parsePartyPokemon, scanForMons } from "./pokemon.js";
export { deserialize, extractRam, StateError } from "./state-extract.js";
export { parseFlashSave, SavError } from "./sav-extract.js";
export { parseSaveBlocks, FLASH_CAVEAT } from "./parse-blocks.js";
export { createContext } from "./data.js";

let cached = null;

/** The shared default context (config layers + gamedata + codec), built once. */
export function defaultContext() {
  if (cached === null) cached = createContext();
  return cached;
}

/**
 * Parse a pair of RAM regions into the game-state object.
 * @param {{iwram: Uint8Array, ewram: Uint8Array}} ram
 * @param {{doScan?: boolean, context?: object}} [opts]
 */
export function parseRam({ iwram, ewram }, opts = {}) {
  const { cfg, gamedata, codec } = opts.context ?? defaultContext();
  return parseState(new Dump(iwram, ewram), cfg, gamedata, codec, opts);
}

/**
 * Parse a savestate file (PNG / raw / libretro container) into the game state.
 * @param {Uint8Array} blob
 * @param {{doScan?: boolean, context?: object}} [opts]
 */
export async function parseSavestate(blob, opts = {}) {
  let ram;
  try {
    ram = await extractRam(blob);
  } catch (e) {
    throw new DumpError("savestate: " + e.message);
  }
  return parseRam(ram, opts);
}

/**
 * Parse a flash save (.sav) into the game state.
 *
 * The result carries `state.source.live === false` and `state.source.caveat`,
 * because a .sav is the last-saved state rather than the live one.
 *
 * @param {Uint8Array} bytes
 * @param {{doScan?: boolean, context?: object}} [opts]
 */
export function parseFlashSaveFile(bytes, opts = {}) {
  const { cfg, gamedata, codec } = opts.context ?? defaultContext();
  let blocks;
  try {
    blocks = parseFlashSave(bytes);
  } catch (e) {
    throw new DumpError("flash save: " + e.message);
  }
  return parseSaveBlocks(blocks, cfg, gamedata, codec, opts);
}

/** True when the bytes look like a 128KB Gen-3 flash save. */
export function looksLikeFlashSave(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length !== SAV_SIZE) return false;
  // At least one sector must carry the Gen-3 save signature. Checking every
  // sector (rather than just the first) means a save whose first sectors were
  // erased is still recognized as a .sav rather than misreported as unknown.
  for (let sector = 0; sector < 32; sector++) {
    const off = sector * 0x1000 + 0xff8;
    const sig = (bytes[off] | (bytes[off + 1] << 8) | (bytes[off + 2] << 16) | (bytes[off + 3] << 24)) >>> 0;
    if (sig === SECTOR_SIGNATURE) return true;
  }
  return false;
}

/**
 * Parse any supported save file: a flash .sav, or a savestate in any of the
 * three container formats. Detection is by content, not by filename.
 *
 * This is the single entry point a UI should call for a dropped file.
 *
 * @param {Uint8Array} bytes
 * @param {{doScan?: boolean, context?: object}} [opts]
 */
export async function parseSaveFile(bytes, opts = {}) {
  // Route by size, not by signature. No savestate container is 128KB (raw states
  // are 0x61000, libretro larger, PNGs are detected by magic), so a 128KB file is
  // a flash save even when its sectors are unsigned or damaged — and it should
  // get the flash reader's diagnosis ("no usable save slot", "never saved")
  // rather than the savestate reader's misleading "not a savestate" complaint.
  if (bytes instanceof Uint8Array && bytes.length === SAV_SIZE) {
    return parseFlashSaveFile(bytes, opts);
  }
  return parseSavestate(bytes, opts);
}
