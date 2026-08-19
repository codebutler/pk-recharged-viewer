/**
 * verify.js -- Bun-only harness that renders the same things the Python
 * rasterizer does and dumps them as raw RGBA (for byte comparison) plus PNGs
 * (for eyeballing).
 *
 * Usage:  bun lib/gfx/verify.js [outDir]
 *
 * The RGBA dumps are the actual test: PNG bytes never match across encoders,
 * but the pixel buffers must be identical. See verify_python.py alongside for
 * the reference dumps and the diff.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { composite } from "./gba-gfx.js";
import { cropViewport, dnsPhase, renderMap } from "./gba-map.js";
import { encodePNG } from "./png-node.js";
import { badgeSprites, monOverworldSprite, playerSprite } from "./rom-assets.js";

const REPO = new URL("../../", import.meta.url).pathname;
const ROM_PATH = join(REPO, "local", "Pokemon Recharged Yellow.gba");
const outDir = process.argv[2] || join(REPO, ".gfx-verify");

// --- cases -----------------------------------------------------------------
mkdirSync(outDir, { recursive: true });
const rom = new Uint8Array(readFileSync(ROM_PATH));

const cases = [];
function emit(name, { rgba, width, height }) {
  writeFileSync(join(outDir, `js_${name}.rgba`), Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength));
  writeFileSync(join(outDir, `js_${name}.png`), encodePNG(rgba, width, height));
  cases.push({ name, width, height });
}

// Celadon City (group 3, map 6): the worked example in hack-offsets.json.
const CELADON = [3, 6];
const PLAYER_TILE = [24, 20];

const day = renderMap(rom, ...CELADON);
emit("celadon_day", day);
emit("celadon_day_crop", cropViewport(day.rgba, day.width, day.height, ...PLAYER_TILE));

// Same map at in-game 21:16 -- the live-measured evening-ramp sample.
const CLOCK = { hour: 21, minute: 16 };
const night = renderMap(rom, ...CELADON, { clock: CLOCK });
emit("celadon_2116", night);

// Player (graphicsId 0) standing frames; "right" exercises the h-flip.
for (const facing of ["down", "up", "left", "right"]) {
  emit(`player_${facing}`, playerSprite(rom, 0, facing));
}

// Pikachu (internal species 25) overworld sprite -- verified in the offsets doc.
for (const facing of ["down", "right"]) {
  emit(`pikachu_${facing}`, monOverworldSprite(rom, 25, facing));
}

// All eight badges.
badgeSprites(rom).forEach((b, i) => emit(`badge_${i + 1}`, b));

// A composited scene: player + follower on the tinted Celadon crop, exactly as
// generate_page.py's map_context builds it.
{
  const scene = renderMap(rom, ...CELADON, { clock: CLOCK });
  const [tx, ty] = PLAYER_TILE;
  const p = playerSprite(rom, 0, "down");
  composite(scene.rgba, scene.width, scene.height, p.rgba, p.width, p.height,
    tx * 16 + (16 - p.width) / 2, (ty + 1) * 16 - p.height);
  const f = monOverworldSprite(rom, 25, "down");
  composite(scene.rgba, scene.width, scene.height, f.rgba, f.width, f.height,
    (tx - 1) * 16 + (16 - f.width) / 2, (ty + 1) * 16 - f.height);
  emit("celadon_scene_crop", cropViewport(scene.rgba, scene.width, scene.height, tx, ty));
}

console.log(JSON.stringify({
  outDir,
  mapType: day.mapType,
  mapSize: [day.widthMetatiles, day.heightMetatiles],
  dns2116: dnsPhase(CLOCK),
  cases,
}, null, 1));
