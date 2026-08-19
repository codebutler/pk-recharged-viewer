/**
 * rom-assets.js -- named asset helpers over the ROM bytes: overworld object
 * sprites, mon overworld sprites, and the badge pixel art.
 *
 * Port of the extraction paths in research/tools/generate_page.py. Every
 * function takes the ROM as an ArrayBuffer/Uint8Array and returns
 * {rgba, width, height}; nothing here touches the filesystem or network.
 */

import { asBytes, decodePalette, lz77Decompress, tilesToRGBA } from "./gba-gfx.js";
import { FRAME_BY_FACING, OFFSETS, romOffset, romView } from "./rom-offsets.js";

/**
 * Any object event's standing frame by graphicsId, straight from the ROM's
 * ObjectEventGraphicsInfo structs (hack-offsets.json player_sprite_rendering):
 * u16 paletteTag @2, s16 width @8, s16 height @0xA, images* @0x1C. Image data
 * is UNCOMPRESSED 4bpp, row-major tiles. Throws on implausible data.
 */
export function playerSprite(romData, graphicsId, facing = "down") {
  const rom = asBytes(romData);
  const view = romView(rom);
  const info = romOffset(
    rom,
    view.getUint32(
      romOffset(rom, OFFSETS.gObjectEventGraphicsInfoPointers) + graphicsId * 4,
      true,
    ),
  );
  const palTag = view.getUint16(info + 2, true);
  const wt = view.getUint16(info + 8, true) / 8;
  const ht = view.getUint16(info + 0xa, true) / 8;
  if (!(wt >= 1 && wt <= 16 && ht >= 1 && ht <= 16)) {
    throw new Error(`implausible sprite dims ${wt * 8}x${ht * 8}`);
  }
  const images = romOffset(rom, view.getUint32(info + 0x1c, true));
  const frame = FRAME_BY_FACING[facing] ?? 0;
  // SpriteFrameImage stride 8: {u32 dataPtr, u16 byteSize}
  const data = romOffset(rom, view.getUint32(images + frame * 8, true));
  const tiles = rom.subarray(data, data + wt * ht * 32);

  // Palette by tag: sprite-palette table, stride 8 {u32 palettePtr, u16 tag},
  // list ends at tag 0x11FF.
  let p = romOffset(rom, OFFSETS.spritePaletteTable);
  let palBytes = null;
  for (let i = 0; i < 256; i++, p += 8) {
    const tag = view.getUint16(p + 4, true);
    if (tag === palTag) {
      const off = romOffset(rom, view.getUint32(p, true));
      palBytes = rom.subarray(off, off + 32);
      break;
    }
    if (tag === 0x11ff) break;
  }
  if (!palBytes) {
    throw new Error(`palette tag 0x${palTag.toString(16)} not found`);
  }
  return tilesToRGBA(tiles, decodePalette(palBytes), wt, ht, {
    hflip: facing === "right",
  });
}

/** Alias: playerSprite() renders any object event, not just the player. */
export const objectSprite = playerSprite;

/**
 * A mon's overworld standing frame by INTERNAL species id
 * (hack-offsets.json follower_mon_sprite_rendering): graphics-info structs are
 * an inline ARRAY of stride 36; the first images-table entry points at an LZ77
 * sheet of 6 32x32 frames (0/1/2 = stand S/N/W, 3-5 walk). The remaining
 * image-table entries hold bogus in-stream pointers -- slice the sheet instead.
 * Palettes are species-indexed LZ77 blobs.
 */
export function monOverworldSprite(romData, species, facing = "down") {
  const rom = asBytes(romData);
  const view = romView(rom);
  const info = romOffset(rom, OFFSETS.monGraphicsInfoArray) + species * 36;
  const images = romOffset(rom, view.getUint32(info + 0x1c, true));
  const sheet = lz77Decompress(rom, romOffset(rom, view.getUint32(images, true)));
  if (sheet.length < 6 * 0x200) {
    throw new Error(`mon sheet too small (${sheet.length} bytes)`);
  }
  const frame = FRAME_BY_FACING[facing] ?? 0;
  const tiles = sheet.subarray(frame * 0x200, (frame + 1) * 0x200);
  const palLZ = romOffset(
    rom,
    view.getUint32(romOffset(rom, OFFSETS.monPaletteTable) + species * 8, true),
  );
  const palette = decodePalette(lz77Decompress(rom, palLZ).subarray(0, 32));
  return tilesToRGBA(tiles, palette, 4, 4, { hflip: facing === "right" });
}

/**
 * The eight Kanto badges (index 0 = Boulder .. 7 = Earth) as 16x16 RGBA
 * frames, from the ROM's own pixel art (hack-offsets.json badge_pixel_art):
 * an LZ77 sheet of 0x400 bytes = 32 tiles = 128x16 px, so badge i is tiles
 * {2i, 2i+1} on the top row and {16+2i, 16+2i+1} on the bottom. Palette is an
 * uncompressed u16[16] BGR555 block.
 */
export function badgeSprites(romData) {
  const rom = asBytes(romData);
  const sheet = lz77Decompress(rom, romOffset(rom, OFFSETS.badgeSheetLZ));
  if (sheet.length !== 0x400) {
    throw new Error(`badge sheet is ${sheet.length} bytes, expected 1024`);
  }
  const palOff = romOffset(rom, OFFSETS.badgePalette);
  const palette = decodePalette(rom.subarray(palOff, palOff + 32));
  const out = [];
  for (let i = 0; i < 8; i++) {
    const tiles = new Uint8Array(4 * 32);
    [2 * i, 2 * i + 1, 16 + 2 * i, 17 + 2 * i].forEach((t, n) => {
      tiles.set(sheet.subarray(t * 32, (t + 1) * 32), n * 32);
    });
    out.push(tilesToRGBA(tiles, palette, 2, 2));
  }
  return out;
}

/** One badge by 1-based number (1 = Boulder .. 8 = Earth). */
export function badgeSprite(romData, n) {
  return badgeSprites(romData)[n - 1];
}

/**
 * The full-body trainer art is a vendored PNG, not a ROM extraction --
 * research/tools/assets/trainer-pic-{gender}.png, which the app copies into
 * its own assets dir. Returns the URL to load rather than pixel data.
 */
export function trainerPicURL(gender = "male", base = "assets") {
  return `${base}/trainer-pic-${gender === "female" ? "female" : "male"}.png`;
}
