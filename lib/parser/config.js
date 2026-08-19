/** Layered offset configuration and optional name tables (port of parse_ram.py). */

import { EWRAM_BASE, HACK_OFFSETS_KEYMAP, VANILLA_OFFSETS } from "./constants.js";

/** Python int(x, 0): accepts decimal or an 0x-prefixed hex string. */
function intAuto(v) {
  return typeof v === "string" ? Number(v) : v;
}

export class Config {
  constructor() {
    this.entries = {};
    for (const [k, v] of Object.entries(VANILLA_OFFSETS)) {
      this.entries[k] = { ...v, source: "vanilla" };
    }
    this.layers_loaded = [];
  }

  /**
   * Overlay one config layer.
   * @param {object} data parsed JSON (flat schema or hack-offsets schema)
   * @param {string} source provenance label
   * @param {string} file path recorded in meta.config_layers
   */
  loadData(data, source, file) {
    const n = Object.keys(HACK_OFFSETS_KEYMAP).some((s) => s in data)
      ? this._loadHackOffsets(data, source)
      : this._loadFlat(data, source);
    this.layers_loaded.push({ file, source, entries: n });
    return true;
  }

  /** Flat schema: {"offsets": {"sb1.money": {"offset":.., "status":..}}}. */
  _loadFlat(data, source) {
    const offsets = data.offsets ?? data;
    let n = 0;
    for (const [key, val] of Object.entries(offsets)) {
      if (key.startsWith("_") || val === null || typeof val !== "object" || Array.isArray(val)) {
        continue;
      }
      if (!("offset" in val)) continue;
      this.entries[key] = {
        offset: val.offset,
        status: val.status ?? "override",
        capacity: val.capacity ?? null,
        evidence: val.evidence ?? null,
        source,
      };
      n += 1;
    }
    return n;
  }

  /**
   * hack-offsets.json schema: per-struct sections whose entries carry hack_offset
   * (hex string or null), confidence, and a type like ItemSlot[60].
   */
  _loadHackOffsets(data, source) {
    let n = 0;
    // Live EWRAM symbols (fixed addresses, not ASLR-shifted).
    const symbols = [
      ["gPlayerPartyCount", "ewram.partyCount"],
      ["gPlayerParty", "ewram.party"],
      ["gObjectEvents", "ewram.objectEvents"],
      ["gPlayerAvatar", "ewram.playerAvatar"],
    ];
    for (const [sym, key] of symbols) {
      const entry = data.ewram_symbols?.[sym];
      if (entry && typeof entry === "object" && "addr" in entry) {
        this.entries[key] = {
          offset: intAuto(entry.addr) - EWRAM_BASE,
          status: "rom:" + (entry.confidence ?? "unknown"),
          evidence: entry.note ?? null,
          source,
        };
        n += 1;
      }
    }
    for (const [sect, keymap] of Object.entries(HACK_OFFSETS_KEYMAP)) {
      for (const [name, entry] of Object.entries(data[sect] ?? {})) {
        const key = keymap[name];
        if (key === undefined || !entry || typeof entry !== "object") continue;
        if (!("hack_offset" in entry)) continue;
        let off = entry.hack_offset;
        if (typeof off === "string") off = Number(off);
        if (off === -1) off = null;
        let capacity = null;
        const m = /\[(\d+)\]/.exec(entry.type ?? "");
        if (m) capacity = parseInt(m[1], 10);
        this.entries[key] = {
          offset: off,
          status: "rom:" + (entry.confidence ?? "unknown"),
          capacity,
          evidence: entry.evidence ?? entry.note ?? null,
          source,
        };
        n += 1;
      }
    }
    return n;
  }

  off(key) {
    return this.entries[key].offset;
  }

  status(key) {
    return this.entries[key].status;
  }

  capacity(key, dflt) {
    return this.entries[key].capacity || dflt;
  }

  /**
   * True when the offset comes from real evidence (dump verification or ROM
   * disassembly), not an unexercised vanilla assumption.
   */
  trusted(key) {
    const e = this.entries[key];
    return (
      e.offset !== null &&
      e.offset !== undefined &&
      !["vanilla-unverified", "unverified-reorganized", "rom:unknown"].includes(e.status)
    );
  }

  describe(...keys) {
    const out = {};
    for (const k of keys) {
      if (k in this.entries) {
        out[k] = {
          offset: this.entries[k].offset,
          status: this.entries[k].status,
          source: this.entries[k].source,
        };
      }
    }
    return out;
  }
}

/** Optional name tables from gamedata.json (tolerant of schema). */
export class GameData {
  constructor(raw) {
    this.tables = {};
    if (raw) {
      for (const key of ["species", "items", "item_pockets", "moves", "maps", "abilities", "natures"]) {
        if (key in raw) this.tables[key] = raw[key];
      }
    }
    this.loaded = Object.keys(this.tables).length > 0;
  }

  _lookup(table, key) {
    const tab = this.tables[table];
    if (tab === undefined) return null;
    if (Array.isArray(tab)) {
      return Number.isInteger(key) && key >= 0 && key < tab.length ? tab[key] : null;
    }
    const v = tab[String(key)];
    return v === undefined ? null : v;
  }

  species(sid) {
    return this._lookup("species", sid);
  }

  item(iid) {
    return this._lookup("items", iid);
  }

  move(mid) {
    return this._lookup("moves", mid);
  }

  /** The hack item table's pocket byte for an item id, or null. */
  itemPocket(iid) {
    return this._lookup("item_pockets", iid);
  }

  /** The maps-table entry (object or name string) for (group, num). */
  mapEntry(group, num) {
    const tab = this.tables.maps;
    if (tab === undefined) return null;
    if (tab && typeof tab === "object" && !Array.isArray(tab)) {
      for (const key of [`${group},${num}`, `${group}.${num}`, `(${group},${num})`]) {
        if (key in tab) return tab[key];
      }
      const grp = tab[String(group)];
      if (Array.isArray(grp)) return num < grp.length ? grp[num] : null;
      if (grp && typeof grp === "object") return grp[String(num)] ?? null;
    }
    return null;
  }
}
