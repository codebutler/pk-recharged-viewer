/** Gen-3 text decoding and BoxPokemon/Pokemon decryption (port of parse_ram.py). */

import { MAX_SPECIES, NATURES } from "./constants.js";
import { u16, u32 } from "./util.js";

/** Charmap + substruct permutation, built from structs.json. */
export class Codec {
  constructor(structs) {
    this.charmap = new Map();
    for (const [k, v] of Object.entries(structs.charmap)) {
      this.charmap.set(Number(k), v);
    }
    this.typeToSlot = {};
    for (const [k, v] of Object.entries(structs.substruct_permutation.type_to_slot)) {
      this.typeToSlot[Number(k)] = v;
    }
  }

  /** Decode Gen-3 encoded text, stopping at 0xFF. */
  decodeText(buf) {
    let out = "";
    for (const b of buf) {
      if (b === 0xff) break;
      out += this.charmap.has(b) ? this.charmap.get(b) : "?";
    }
    return out;
  }

  /** True if the region decodes without unmapped bytes and terminates sanely. */
  textIsClean(buf) {
    let seenChar = false;
    for (const b of buf) {
      if (b === 0xff) return seenChar;
      if (!this.charmap.has(b) || this.charmap.get(b) === "\n") return false;
      seenChar = true;
    }
    // A full-length name with no terminator is legal for nicknames.
    return seenChar;
  }
}

/** XOR-decrypt the 48-byte secure block of an 80-byte BoxPokemon. */
export function decryptSecure(box, personality, otId) {
  const key = (personality ^ otId) >>> 0;
  const sec = new Uint8Array(box.subarray(0x20, 0x50));
  for (let i = 0; i < 48; i += 4) {
    const v = (u32(sec, i) ^ key) >>> 0;
    sec[i] = v & 0xff;
    sec[i + 1] = (v >>> 8) & 0xff;
    sec[i + 2] = (v >>> 16) & 0xff;
    sec[i + 3] = (v >>> 24) & 0xff;
  }
  return sec;
}

export function checksum16(sec) {
  let sum = 0;
  for (let i = 0; i < 48; i += 2) sum += u16(sec, i);
  return sum & 0xffff;
}

/**
 * Parse an 80-byte BoxPokemon. Returns null for an empty slot, else an object;
 * the object contains "error" if the checksum fails (Bad Egg).
 */
export function parseBoxPokemon(buf, off, gamedata, codec) {
  const box = buf.subarray(off, off + 80);
  const personality = u32(box, 0);
  const otId = u32(box, 4);
  const flags = box[19];
  const hasSpecies = (flags >> 1) & 1;
  if (personality === 0 && otId === 0 && !hasSpecies) return null;

  const sec = decryptSecure(box, personality, otId);
  const calc = checksum16(sec);
  const stored = u16(box, 28);
  const mon = {
    personality,
    otId,
    nickname: codec.decodeText(box.subarray(8, 18)),
    language: box[18],
    isBadEgg: Boolean(flags & 1),
    isEgg: Boolean((flags >> 2) & 1),
    otName: codec.decodeText(box.subarray(20, 27)),
    markings: box[27],
    checksumValid: calc === stored,
  };
  if (calc !== stored) {
    mon.error =
      `substruct checksum mismatch (stored 0x${stored.toString(16).toUpperCase().padStart(4, "0")}, ` +
      `computed 0x${calc.toString(16).toUpperCase().padStart(4, "0")}) -- Bad Egg / corrupt`;
    return mon;
  }

  const slots = codec.typeToSlot[personality % 24];
  const growth = sec.subarray(slots[0] * 12, slots[0] * 12 + 12);
  const attacks = sec.subarray(slots[1] * 12, slots[1] * 12 + 12);
  const evs = sec.subarray(slots[2] * 12, slots[2] * 12 + 12);
  const misc = sec.subarray(slots[3] * 12, slots[3] * 12 + 12);

  const species = u16(growth, 0);
  if (species === 0) return null;
  const heldItem = u16(growth, 2);
  mon.species = species;
  const name = gamedata.species(species);
  if (name) mon.speciesName = name;
  mon.heldItem = heldItem;
  const iname = gamedata.item(heldItem);
  if (heldItem && iname) mon.heldItemName = iname;
  mon.experience = u32(growth, 4);
  mon.ppBonuses = growth[8];
  mon.friendship = growth[9];

  const moves = [];
  for (let i = 0; i < 4; i++) {
    const mid = u16(attacks, i * 2);
    if (mid === 0) continue;
    const m = { move: mid, pp: attacks[8 + i] };
    const mname = gamedata.move(mid);
    if (mname) m.name = mname;
    moves.push(m);
  }
  mon.moves = moves;

  mon.evs = {
    hp: evs[0], attack: evs[1], defense: evs[2],
    speed: evs[3], spAttack: evs[4], spDefense: evs[5],
  };
  mon.condition = {
    cool: evs[6], beauty: evs[7], cute: evs[8],
    smart: evs[9], tough: evs[10], sheen: evs[11],
  };

  mon.pokerus = misc[0];
  mon.metLocation = misc[1];
  const origins = u16(misc, 2);
  mon.metLevel = origins & 0x7f;
  mon.metGame = (origins >> 7) & 0xf;
  mon.pokeball = (origins >> 11) & 0xf;
  mon.otGender = (origins >> 15) & 1;
  const ivword = u32(misc, 4);
  mon.ivs = {
    hp: ivword & 31,
    attack: (ivword >>> 5) & 31,
    defense: (ivword >>> 10) & 31,
    speed: (ivword >>> 15) & 31,
    spAttack: (ivword >>> 20) & 31,
    spDefense: (ivword >>> 25) & 31,
  };
  mon.isEggIV = Boolean((ivword >>> 30) & 1);
  mon.abilityNum = (ivword >>> 31) & 1;

  const tid = otId & 0xffff;
  const sid = otId >>> 16;
  mon.shiny = (tid ^ sid ^ (personality >>> 16) ^ (personality & 0xffff)) < 8;
  mon.nature = NATURES[personality % 25];
  return mon;
}

/** Parse a 100-byte party Pokemon (BoxPokemon + unencrypted battle section). */
export function parsePartyPokemon(buf, off, gamedata, codec) {
  const mon = parseBoxPokemon(buf, off, gamedata, codec);
  if (mon === null) return null;
  const status = u32(buf, off + 80);
  mon.status = {
    raw: status,
    sleepTurns: status & 7,
    poison: Boolean(status & 0x08),
    burn: Boolean(status & 0x10),
    freeze: Boolean(status & 0x20),
    paralysis: Boolean(status & 0x40),
    badPoison: Boolean(status & 0x80),
  };
  mon.level = buf[off + 84];
  mon.hp = u16(buf, off + 86);
  mon.stats = {
    maxHP: u16(buf, off + 88),
    attack: u16(buf, off + 90),
    defense: u16(buf, off + 92),
    speed: u16(buf, off + 94),
    spAttack: u16(buf, off + 96),
    spDefense: u16(buf, off + 98),
  };
  return mon;
}

/** Scan SaveBlock1 for checksum-valid encrypted Pokemon at any 4-aligned offset. */
export function scanForMons(ew, sb1, sb1Size, codec, exclude) {
  const found = [];
  const end = Math.min(sb1 + sb1Size, ew.length) - 80;
  for (let off = sb1; off < end; off += 4) {
    const pers = u32(ew, off);
    const otid = u32(ew, off + 4);
    if (pers === 0 && otid === 0) continue;
    const rel = off - sb1;
    if (exclude.has(rel)) continue;
    const sec = decryptSecure(ew.subarray(off, off + 80), pers, otid);
    if (checksum16(sec) !== u16(ew, off + 28)) continue;
    const slots = codec.typeToSlot[pers % 24];
    const species = u16(sec, slots[0] * 12);
    if (species >= 1 && species <= MAX_SPECIES) found.push(rel);
  }
  return found;
}
