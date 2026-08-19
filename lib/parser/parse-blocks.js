/**
 * parse-blocks.js -- parse reassembled save blocks (from a flash .sav) into the
 * same game-state shape the RAM parser produces.
 *
 * A .sav holds only what the game wrote at the last save. There is no live RAM,
 * so three things that a savestate provides simply do not exist here:
 *   - the live party (gPlayerParty) -- the saved copy at SB1+0x44 is all there is;
 *   - live gObjectEvents / gPlayerAvatar -- facing and position come from the
 *     SAVED objectEvents copy at SB1+0x910, and bike/surf state is absent entirely;
 *   - the follower -- the 0xFE follower object is not persisted to flash.
 * The output says so rather than quietly presenting saved data as live.
 *
 * Implementation note: the blocks are laid into a synthetic EWRAM image with a
 * synthetic pointer table, then handed to the ordinary parseState. That reuses
 * the field semantics proven byte-identical to the Python parser across 82
 * inputs instead of duplicating them. The live-global addresses stay zeroed --
 * deliberately, since a .sav genuinely has nothing to put there -- and the pass
 * below replaces every section that would otherwise read as "live but empty".
 */

import {
  EWRAM_BASE, EWRAM_SIZE, FACING_NAMES, IWRAM_BASE, IWRAM_SIZE, OBJ_EVENT_STRIDE,
  PTR_SAVEBLOCK1, PTR_SAVEBLOCK2, PTR_STORAGE, SB1_SIZE, SB2_SIZE,
} from "./constants.js";
import { Dump, DumpError, parseState } from "./parse-ram.js";
import { s16 } from "./util.js";

// Where the blocks sit in the synthetic EWRAM. Chosen to clear the live-global
// addresses the parser reads (gObjectEvents 0x5CD4, gPlayerAvatar 0x5F14,
// gPlayerParty 0x3855C) so nothing collides and those stay zero.
const SYNTH_SB2 = 0x10000;
const SYNTH_SB1 = 0x11000;
const SYNTH_STORAGE = 0x16000;

const SAVED_OBJECT_EVENTS = 0x910; // SB1 offset of the saved ObjectEvent[16] copy

export const FLASH_CAVEAT =
  "Loaded from a flash save (.sav): everything shown is as of the last in-game " +
  "save. A .sav has no live state, so the party is the saved copy, and the " +
  "follower, bike/surf state and current clock are not available. A savestate " +
  "(.st0/.ss) shows the live, up-to-the-second state.";

function writePointer(iwram, addr, value) {
  const off = addr - IWRAM_BASE;
  iwram[off] = value & 0xff;
  iwram[off + 1] = (value >>> 8) & 0xff;
  iwram[off + 2] = (value >>> 16) & 0xff;
  iwram[off + 3] = (value >>> 24) & 0xff;
}

/**
 * Parse reassembled save blocks into game state.
 *
 * @param {{saveBlock1: Uint8Array, saveBlock2: Uint8Array, storage: Uint8Array,
 *          info?: object}} blocks
 * @param {import("./config.js").Config} cfg
 * @param {import("./config.js").GameData} gamedata
 * @param {import("./pokemon.js").Codec} codec
 * @param {{doScan?: boolean}} [opts]
 */
export function parseSaveBlocks(blocks, cfg, gamedata, codec, opts = {}) {
  const { saveBlock1, saveBlock2, storage, info } = blocks;
  for (const [name, buf, want] of [
    ["saveBlock1", saveBlock1, SB1_SIZE],
    ["saveBlock2", saveBlock2, SB2_SIZE],
    ["storage", storage, 0x83d0],
  ]) {
    if (!(buf instanceof Uint8Array)) throw new DumpError(`${name} must be a Uint8Array`);
    if (buf.length < want) {
      throw new DumpError(`${name} is ${buf.length} bytes (expected ${want})`);
    }
  }

  const ewram = new Uint8Array(EWRAM_SIZE);
  ewram.set(saveBlock2.subarray(0, SB2_SIZE), SYNTH_SB2);
  ewram.set(saveBlock1.subarray(0, SB1_SIZE), SYNTH_SB1);
  ewram.set(storage.subarray(0, 0x83d0), SYNTH_STORAGE);
  const iwram = new Uint8Array(IWRAM_SIZE);
  writePointer(iwram, PTR_SAVEBLOCK1, EWRAM_BASE + SYNTH_SB1);
  writePointer(iwram, PTR_SAVEBLOCK2, EWRAM_BASE + SYNTH_SB2);
  writePointer(iwram, PTR_STORAGE, EWRAM_BASE + SYNTH_STORAGE);

  const state = parseState(new Dump(iwram, ewram), cfg, gamedata, codec, opts);

  // The synthetic pointers are an implementation detail; reporting them as if
  // they were real addresses would be a lie.
  state.meta.pointers = {
    note: "flash save: no live pointers -- the save blocks were reassembled from sectors",
  };
  state.source = {
    kind: "flash-save",
    live: false,
    caveat: FLASH_CAVEAT,
    ...(info ?? {}),
  };
  if (state.inGame !== true) return state;

  // --- party: the saved copy is the only party a .sav has ----------------
  const saved = state.savedParty;
  delete saved.note; // "differs from live party" is meaningless without a live one
  state.party = {
    ...saved,
    source:
      "SaveBlock1+0x44 (flash save: the party as of the last save; a .sav has no live party)",
  };
  state.savedParty = {
    ...saved,
    note: "same data as `party` -- a flash save contains only the saved copy",
  };
  state.meta.confidence.party = state.meta.confidence.savedParty;

  // The live/saved party comparison anchor compared against a party that cannot
  // exist here; restate it for what was actually checked.
  for (const a of state.meta.anchors) {
    if (a.anchor === "party counts 0..6") {
      a.detail = `saved=${saved.count} (flash save: no live party to compare)`;
    }
  }

  // --- player avatar from the SAVED objectEvents copy --------------------
  const sb1 = SYNTH_SB1;
  const objBase = sb1 + SAVED_OBJECT_EVENTS;
  let playerEnt = null;
  const actives = [];
  for (let i = 0; i < 16; i++) {
    const e = objBase + i * OBJ_EVENT_STRIDE;
    if (!(ewram[e] & 1)) continue;
    const ent = {
      localId: ewram[e + 8],
      graphicsId: ewram[e + 5],
      facing: FACING_NAMES[ewram[e + 0x18] & 0xf] ?? "unknown",
      coords: [s16(ewram, e + 0x10), s16(ewram, e + 0x12)],
    };
    actives.push(ent);
    if (ewram[e + 8] === 0xff && playerEnt === null) playerEnt = { e, ent };
  }
  if (playerEnt !== null) {
    const facingRaw = ewram[playerEnt.e + 0x18];
    state.playerAvatar = {
      facing: FACING_NAMES[facingRaw & 0xf] ?? "unknown",
      // gPlayerAvatar is a live global; a .sav does not record it. Null, not
      // false -- "we don't know" is not the same as "no".
      onBike: null,
      surfing: null,
      graphicsId: ewram[playerEnt.e + 5],
      raw: { facing: facingRaw, avatarFlags: null, currentCoords: playerEnt.ent.coords },
      objectEvents: actives,
      follower: {
        present: false,
        note:
          "a flash save does not persist the follower object -- load a savestate " +
          "to see the follower",
      },
      facingAtLastSave: FACING_NAMES[facingRaw & 0xf] ?? "unknown",
      source: "SaveBlock1+0x910 (saved objectEvents copy; a .sav has no live overworld state)",
    };
    state.meta.confidence.playerAvatar =
      "medium (facing/position as of the last save, from the saved objectEvents " +
      "copy; bike/surf and follower are live-only and absent)";
  } else {
    state.meta.confidence.playerAvatar =
      "unavailable (no player entry in the saved objectEvents copy)";
  }

  // --- clock: SB2 holds it, but it stopped at the save -------------------
  state.gameClock.note =
    "accelerated in-game clock, ~9x real time -- as of the last save (a .sav has " +
    "no running clock)";
  return state;
}
