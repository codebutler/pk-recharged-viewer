/**
 * rom-offsets.js -- ROM addresses and format constants for Pokemon Recharged
 * Yellow, mirroring research/hack-offsets.json (the parser agent is copying
 * that file to public/data/hack-offsets.json).
 *
 * Most graphics addresses live inside prose "recipe" strings in that JSON
 * rather than clean fields, so the authoritative values are spelled out here
 * with a citation to their JSON path. Call overrideFromHackOffsets() with a
 * parsed hack-offsets.json to pick up the fields that ARE machine-readable.
 */

export const ROM_BASE = 0x08000000;

export const OFFSETS = {
  // map_rendering.header_walk
  gMapGroups: 0x08b3f134,

  // player_sprite_rendering.gObjectEventGraphicsInfoPointers.addr
  gObjectEventGraphicsInfoPointers: 0x0887ee9c,
  // player_sprite_rendering.sprite_palette_table.addr
  spritePaletteTable: 0x08890458,

  // follower_mon_sprite_rendering.recipe: inline array of graphics-info
  // structs (stride 36) indexed by INTERNAL species id
  monGraphicsInfoArray: 0x0888c430,
  // follower_mon_sprite_rendering.recipe: {u32 lzPalPtr, u32 tag} stride 8
  monPaletteTable: 0x08751738,

  // badge_pixel_art.sheet_lz77 / .palette
  badgeSheetLZ: 0x08a60760,
  badgePalette: 0x085e6024,
};

// map_rendering.constants -- FRLG-style splits (Emerald's leave Celadon's
// secondary tiles black).
export const NUM_PALS_IN_PRIMARY = 7;
export const NUM_TILES_IN_PRIMARY = 640;
export const NUM_METATILES_IN_PRIMARY = 0x280;
export const METATILE_STRIDE = 24;
export const METATILE_LAYERS = 3;

/**
 * Standing-frame convention, uniform across the anim tables
 * (player_sprite_rendering.anim_convention): 0=South, 1=North, 2=West;
 * East is the West frame h-flipped.
 */
export const FRAME_BY_FACING = { down: 0, up: 1, left: 2, right: 2 };

/**
 * Override the machine-readable subset of OFFSETS from a parsed
 * hack-offsets.json. Prose-only addresses keep their built-in values.
 */
export function overrideFromHackOffsets(json) {
  const num = (s) => (typeof s === "string" ? Number.parseInt(s, 16) : s);
  const ptrs = json?.player_sprite_rendering?.gObjectEventGraphicsInfoPointers?.addr;
  if (ptrs) OFFSETS.gObjectEventGraphicsInfoPointers = num(ptrs);
  const palTable = json?.player_sprite_rendering?.sprite_palette_table?.addr;
  if (palTable) OFFSETS.spritePaletteTable = num(palTable);
  const badgeSheet = json?.badge_pixel_art?.sheet_lz77;
  if (badgeSheet) OFFSETS.badgeSheetLZ = num(badgeSheet.split(" ")[0]);
  const badgePal = json?.badge_pixel_art?.palette;
  if (badgePal) OFFSETS.badgePalette = num(badgePal.split(" ")[0]);
  return OFFSETS;
}

/** ROM pointer -> file offset, with a bounds check. */
export function romOffset(rom, ptr) {
  const off = ptr - ROM_BASE;
  if (!(off >= 0 && off < rom.length)) {
    throw new Error(`pointer 0x${(ptr >>> 0).toString(16)} outside ROM`);
  }
  return off;
}

/** DataView over a ROM Uint8Array, cached on the array itself. */
const views = new WeakMap();
export function romView(rom) {
  let v = views.get(rom);
  if (!v) {
    v = new DataView(rom.buffer, rom.byteOffset, rom.byteLength);
    views.set(rom, v);
  }
  return v;
}
