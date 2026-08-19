/**
 * gba-map.js -- render pokeemerald-engine map terrain from the ROM.
 *
 * Port of research/tools/gba_map.py plus the day/night tint schedule that
 * lived in research/tools/generate_page.py. Browser-safe (no Node APIs).
 *
 * Format facts (research/hack-offsets.json map_rendering, code-proven and
 * pixel-validated against live captures):
 * - gMapGroups: array of pointers to per-group arrays of MapHeader pointers.
 * - MapHeader: mapLayout* at +0, layoutId u16 at +0x12, mapType u8 at +0x17.
 * - MapLayout: s32 width, s32 height, border*, blockdata*, primaryTileset*,
 *   secondaryTileset*.
 * - Blockdata: width*height u16, bits 0-9 metatileId, 10-11 collision,
 *   12-15 elevation.
 * - Tileset (FRLG field order): isCompressed u8 @0 (nonzero = LZ77),
 *   isSecondary u8 @1, tiles* @4, palettes* @8, metatiles* @0xC,
 *   callback @0x10, metatileAttributes @0x14.
 * - Metatiles: 3 LAYERS x 4 quads (TL/TR/BL/BR) of u16, 24-byte stride.
 * - Splits: 640 primary tiles; metatile primary/secondary boundary and
 *   secondary index base both 0x280. Palettes: slots 0-6 primary, 7-12
 *   secondary.
 * - Rendering: color 0 transparent on ALL layers over a black backdrop
 *   (porymap-style); 16x16 px per metatile. ROM palettes are DAY colors.
 */

import { asBytes, cropRGBA, decodePalette, lz77Decompress } from "./gba-gfx.js";
import {
  METATILE_LAYERS,
  METATILE_STRIDE,
  NUM_METATILES_IN_PRIMARY,
  NUM_PALS_IN_PRIMARY,
  NUM_TILES_IN_PRIMARY,
  OFFSETS,
  romOffset,
  romView,
} from "./rom-offsets.js";

/** The GBA viewport in metatiles: 15x10 = 240x160 px, player at col 7 row 4. */
export const VIEW_METATILES_W = 15;
export const VIEW_METATILES_H = 10;
export const VIEW_PLAYER_COL = 7;
export const VIEW_PLAYER_ROW = 4;

/** mapTypes that the day/night system tints (towns, cities, routes, water). */
const OUTDOOR_MAP_TYPES = new Set([1, 2, 3, 5, 6]);

function headerOffset(rom, group, num) {
  const view = romView(rom);
  const groupPtr = view.getUint32(romOffset(rom, OFFSETS.gMapGroups) + group * 4, true);
  const hdrPtr = view.getUint32(romOffset(rom, groupPtr) + num * 4, true);
  return romOffset(rom, hdrPtr);
}

/**
 * MapHeader.mapType (u8 at +0x17): 1=town 2=city 3=route 5/6=water routes,
 * 8=indoor, 4=underground, 9=secret base.
 */
export function mapType(romData, group, num) {
  const rom = asBytes(romData);
  return rom[headerOffset(rom, group, num) + 0x17];
}

/** MapLayout id (u16 at header +0x12). */
export function mapLayoutId(romData, group, num) {
  const rom = asBytes(romData);
  return romView(rom).getUint16(headerOffset(rom, group, num) + 0x12, true);
}

function loadTileset(rom, tsPtr) {
  const view = romView(rom);
  const ts = romOffset(rom, tsPtr);
  const compressed = rom[ts];
  const gfxPtr = view.getUint32(ts + 4, true);
  const palPtr = view.getUint32(ts + 8, true);
  const metaPtr = view.getUint32(ts + 12, true);
  const gfx = compressed
    ? lz77Decompress(rom, romOffset(rom, gfxPtr))
    : rom.subarray(
        romOffset(rom, gfxPtr),
        romOffset(rom, gfxPtr) + NUM_TILES_IN_PRIMARY * 32,
      );
  const palOff = romOffset(rom, palPtr);
  return {
    gfx,
    pals: rom.subarray(palOff, palOff + 16 * 32),
    meta: romOffset(rom, metaPtr),
  };
}

/**
 * Render the terrain of map (group, num).
 *
 * opts:
 *   clock  {hour, minute} -- applies the day/night tint on outdoor maps
 *   tint   [r, g, b] multipliers -- explicit override, skips the schedule
 *   applyTint (default true) -- set false to always get raw DAY colors
 *
 * Returns {rgba, width, height, widthMetatiles, heightMetatiles, mapType,
 * phase, tint}.
 */
export function renderMap(romData, mapGroup, mapNum, opts = {}) {
  const rom = asBytes(romData);
  const view = romView(rom);
  const hdr = headerOffset(rom, mapGroup, mapNum);
  const lay = romOffset(rom, view.getUint32(hdr, true));
  const width = view.getInt32(lay, true);
  const height = view.getInt32(lay + 4, true);
  if (!(width >= 1 && width <= 300 && height >= 1 && height <= 300)) {
    throw new Error(`implausible map size ${width}x${height}`);
  }
  const blocks = romOffset(rom, view.getUint32(lay + 12, true));
  const primary = loadTileset(rom, view.getUint32(lay + 16, true));
  const secondary = loadTileset(rom, view.getUint32(lay + 20, true));

  // palette slots: 0-6 primary, 7-12 secondary (the secondary's 0-6 are dummies)
  const palettes = [];
  for (let i = 0; i < 16; i++) {
    const src = i < NUM_PALS_IN_PRIMARY ? primary.pals : secondary.pals;
    palettes.push(decodePalette(src, i * 32));
  }

  const tileCache = new Map();
  function tilePixels(tid) {
    let px = tileCache.get(tid);
    if (px) return px;
    const isPrimary = tid < NUM_TILES_IN_PRIMARY;
    const gfx = isPrimary ? primary.gfx : secondary.gfx;
    const base = (isPrimary ? tid : tid - NUM_TILES_IN_PRIMARY) * 32;
    px = new Uint8Array(64);
    for (let i = 0; i < 32; i++) {
      const b = base + i < gfx.length ? gfx[base + i] : 0;
      px[i * 2] = b & 0xf;
      px[i * 2 + 1] = b >> 4;
    }
    tileCache.set(tid, px);
    return px;
  }

  const W = width * 16;
  const H = height * 16;
  const rgba = new Uint8ClampedArray(W * H * 4);
  for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255; // opaque black backdrop

  for (let my = 0; my < height; my++) {
    for (let mx = 0; mx < width; mx++) {
      const block = view.getUint16(blocks + (my * width + mx) * 2, true);
      const mid = block & 0x3ff;
      const isPrimary = mid < NUM_METATILES_IN_PRIMARY;
      const mbase =
        (isPrimary ? primary.meta : secondary.meta) +
        (isPrimary ? mid : mid - NUM_METATILES_IN_PRIMARY) * METATILE_STRIDE;
      for (let layer = 0; layer < METATILE_LAYERS; layer++) {
        for (let quad = 0; quad < 4; quad++) {
          const ent = view.getUint16(mbase + (layer * 4 + quad) * 2, true);
          const tid = ent & 0x3ff;
          const hf = ent & 0x400;
          const vf = ent & 0x800;
          const palette = palettes[ent >> 12];
          const tp = tilePixels(tid);
          const ox = mx * 16 + (quad % 2) * 8;
          const oy = my * 16 + Math.floor(quad / 2) * 8;
          for (let i = 0; i < 64; i++) {
            // Color 0 is transparent on ALL layers (porymap-style compositing
            // over the black backdrop): FRLG-style metatiles freely put their
            // art in any layer.
            const c = tp[i];
            if (c === 0) continue;
            const x = hf ? 7 - (i & 7) : i & 7;
            const y = vf ? 7 - (i >> 3) : i >> 3;
            const d = ((oy + y) * W + ox + x) * 4;
            rgba[d] = palette[c * 4];
            rgba[d + 1] = palette[c * 4 + 1];
            rgba[d + 2] = palette[c * 4 + 2];
            rgba[d + 3] = palette[c * 4 + 3];
          }
        }
      }
    }
  }

  const type = rom[hdr + 0x17];
  let phase = null;
  let tint = null;
  if (opts.applyTint !== false) {
    if (opts.tint) {
      tint = opts.tint;
    } else if (opts.clock) {
      const p = dnsPhase(opts.clock);
      phase = p.phase;
      tint = p.tint;
    }
    // Interiors are exempt from the day/night system (mapType gate at
    // ROM 0x08140E60; the live 21:18 bedroom capture is untinted).
    if (tint && OUTDOOR_MAP_TYPES.has(type)) applyTint(rgba, tint);
    else if (tint) tint = null;
  }

  return {
    rgba,
    width: W,
    height: H,
    widthMetatiles: width,
    heightMetatiles: height,
    mapType: type,
    phase,
    tint,
  };
}

/** Multiply RGB channels in place by [r, g, b]; alpha untouched. */
export function applyTint(rgba, [rs, gs, bs]) {
  for (let i = 0; i < rgba.length; i += 4) {
    // Math.floor to match the Python's int() truncation exactly --
    // Uint8ClampedArray would otherwise round half-to-even.
    rgba[i] = Math.floor(rgba[i] * rs);
    rgba[i + 1] = Math.floor(rgba[i + 1] * gs);
    rgba[i + 2] = Math.floor(rgba[i + 2] * bs);
  }
  return rgba;
}

/**
 * Day/night schedule (hack-offsets.json day_night_tint: disassembled handler
 * table + live-measured magnitudes). Full night 22:00-3:59; dawn ramp
 * night->twilight 4:00-6:59; morning ramp twilight->clear 7:00-9:59; full day
 * 10:00-17:59; dusk ramp clear->twilight 18:00-19:59; evening ramp
 * twilight->night 20:00-21:59 -- all minute-interpolated. Night coefficients
 * measured ~(0.55, 0.48, 0.55); twilight solved from the live 21:16 sample.
 */
export const DNS_NIGHT = [0.55, 0.48, 0.55];
export const DNS_TWILIGHT = [0.71, 0.62, 0.71];
export const DNS_CLEAR = [1.0, 1.0, 1.0];

const lerp = (a, b, t) => [0, 1, 2].map((i) => a[i] + (b[i] - a[i]) * t);

/**
 * {phase, tint} for an in-game clock. phase is the 4-state chip label
 * DAY/DUSK/NIGHT/DAWN; tint null means no tint (raw day colors).
 */
export function dnsPhase(clock) {
  if (!clock) return { phase: null, tint: null };
  const m = (clock.hour ?? 12) * 60 + (clock.minute ?? 0);
  let phase;
  let tint;
  if (m >= 22 * 60 || m < 4 * 60) {
    [phase, tint] = ["NIGHT", DNS_NIGHT];
  } else if (m < 7 * 60) {
    [phase, tint] = ["DAWN", lerp(DNS_NIGHT, DNS_TWILIGHT, (m - 4 * 60) / 180)];
  } else if (m < 10 * 60) {
    [phase, tint] = ["DAWN", lerp(DNS_TWILIGHT, DNS_CLEAR, (m - 7 * 60) / 180)];
  } else if (m < 18 * 60) {
    [phase, tint] = ["DAY", null];
  } else if (m < 20 * 60) {
    [phase, tint] = ["DUSK", lerp(DNS_CLEAR, DNS_TWILIGHT, (m - 18 * 60) / 120)];
  } else {
    [phase, tint] = ["DUSK", lerp(DNS_TWILIGHT, DNS_NIGHT, (m - 20 * 60) / 120)];
  }
  if (tint && Math.min(...tint) > 0.985) tint = null; // end of morning ramp = clear
  return { phase, tint };
}

/**
 * The GBA viewport crop: 15x10 metatiles centred on the player's tile
 * (column 7, row 4), clamped to the map bounds.
 */
export function cropViewport(rgba, W, H, tileX, tileY) {
  return cropRGBA(
    rgba,
    W,
    H,
    (tileX - VIEW_PLAYER_COL) * 16,
    (tileY - VIEW_PLAYER_ROW) * 16,
    VIEW_METATILES_W * 16,
    VIEW_METATILES_H * 16,
  );
}

export { cropRGBA };
