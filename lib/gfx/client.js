/**
 * client.js -- the ROM-free half of the graphics layer, for the browser app
 * that consumes the pre-extracted assets (see tools/extract-rom-assets.js).
 *
 * The exported map PNGs are DAY colours with no sprites on them, so the app
 * does two things at draw time: tint for the in-game clock, then composite the
 * player and follower sprites on top (in that order -- the game tints terrain
 * but not the sprite layer).
 *
 * Everything here is synchronous and works on canvas/ImageData. No ROM, no
 * Node APIs, no decoding.
 */

import { dnsPhase, DNS_CLEAR, DNS_NIGHT, DNS_TWILIGHT } from "./gba-map.js";

export { dnsPhase, DNS_CLEAR, DNS_NIGHT, DNS_TWILIGHT };

/** The GBA viewport: 15x10 metatiles = 240x160 px, player at col 7 row 4. */
export const VIEW_W = 240;
export const VIEW_H = 160;
export const VIEW_PLAYER_COL = 7;
export const VIEW_PLAYER_ROW = 4;

/** Map types the day/night system tints: towns, cities, routes, water routes. */
const OUTDOOR_MAP_TYPES = new Set([1, 2, 3, 5, 6]);

/** Whether a map's header mapType (from the manifest) gets day/night tinting. */
export function isOutdoor(mapType) {
  return OUTDOOR_MAP_TYPES.has(mapType);
}

/**
 * Multiply an ImageData's RGB channels by [r, g, b] in place; alpha untouched.
 * Math.floor matches the reference renderer's truncation.
 */
export function applyTint(imageData, tint) {
  if (!tint) return imageData;
  const [rs, gs, bs] = tint;
  const d = imageData.data;
  for (let i = 0; i < d.length; i += 4) {
    d[i] = Math.floor(d[i] * rs);
    d[i + 1] = Math.floor(d[i + 1] * gs);
    d[i + 2] = Math.floor(d[i + 2] * bs);
  }
  return imageData;
}

function sizeOf(source) {
  return [
    source.naturalWidth ?? source.width,
    source.naturalHeight ?? source.height,
  ];
}

function makeCanvas(width, height) {
  if (typeof document !== "undefined") {
    return Object.assign(document.createElement("canvas"), { width, height });
  }
  return new OffscreenCanvas(width, height);
}

/**
 * Top-left corner of the viewport for a player standing on (tileX, tileY),
 * clamped to the map. Separate from cropViewport so callers can position
 * sprite overlays in the same coordinate space.
 */
export function viewportOrigin(mapWidth, mapHeight, tileX, tileY) {
  return {
    x: Math.max(0, Math.min((tileX - VIEW_PLAYER_COL) * 16, mapWidth - VIEW_W)),
    y: Math.max(0, Math.min((tileY - VIEW_PLAYER_ROW) * 16, mapHeight - VIEW_H)),
    width: Math.min(VIEW_W, mapWidth),
    height: Math.min(VIEW_H, mapHeight),
  };
}

/**
 * Crop the GBA viewport out of a loaded map image, centred on the player's
 * tile and clamped to the map bounds. `source` is anything drawImage accepts
 * (HTMLImageElement, ImageBitmap, canvas). Returns a canvas; maps smaller than
 * the viewport come back at their own size, exactly as the game frames them.
 */
export function cropViewport(source, tileX, tileY) {
  const [W, H] = sizeOf(source);
  const { x, y, width, height } = viewportOrigin(W, H, tileX, tileY);
  const canvas = makeCanvas(width, height);
  canvas.getContext("2d").drawImage(source, x, y, width, height, 0, 0, width, height);
  return canvas;
}

/**
 * Where a sprite's top-left goes for a character standing on (tileX, tileY):
 * horizontally centred on the 16px tile, feet resting on its bottom edge.
 * Pass the viewport origin to get viewport-local coordinates.
 */
export function spriteAnchor(tileX, tileY, spriteW, spriteH, origin = { x: 0, y: 0 }) {
  return {
    x: tileX * 16 + (16 - spriteW) / 2 - origin.x,
    y: (tileY + 1) * 16 - spriteH - origin.y,
  };
}

/**
 * One-call scene builder: map image -> tinted, sprite-composited viewport
 * canvas.
 *
 * opts: {
 *   map,          // loaded map image (required)
 *   tileX, tileY, // player position in metatiles (required)
 *   clock,        // {hour, minute}; omit for untinted day colours
 *   mapType,      // from the manifest; tinting is skipped indoors
 *   sprites,      // [{image, tileX, tileY}]
 *   sortSprites,  // default true: y-sort as the game does; false = array order
 * }
 * Returns {canvas, phase, tint}.
 */
export function renderScene({
  map, tileX, tileY, clock, mapType, sprites = [], sortSprites = true,
}) {
  const [W, H] = sizeOf(map);
  const origin = viewportOrigin(W, H, tileX, tileY);
  const canvas = makeCanvas(origin.width, origin.height);
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(map, origin.x, origin.y, origin.width, origin.height,
    0, 0, origin.width, origin.height);

  const { phase, tint } = dnsPhase(clock);
  const effective = tint && (mapType === undefined || isOutdoor(mapType)) ? tint : null;
  if (effective) {
    const img = ctx.getImageData(0, 0, origin.width, origin.height);
    ctx.putImageData(applyTint(img, effective), 0, 0);
  }

  // The game draws overworld sprites back-to-front by row, so a character on a
  // souther tile occludes one to the north. Array order only decides ties
  // (e.g. a follower still standing on the player's tile mid-step).
  const ordered = sortSprites
    ? sprites.map((s, i) => [s, i])
        .sort((a, b) => a[0].tileY - b[0].tileY || a[1] - b[1])
        .map(([s]) => s)
    : sprites;
  for (const s of ordered) {
    const [sw, sh] = sizeOf(s.image);
    const { x, y } = spriteAnchor(s.tileX, s.tileY, sw, sh, origin);
    ctx.drawImage(s.image, x, y);
  }
  return { canvas, phase, tint: effective };
}
