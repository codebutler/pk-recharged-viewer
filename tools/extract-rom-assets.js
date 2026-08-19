/**
 * extract-rom-assets.js -- batch-export every ROM-derived asset the web app
 * needs, so the browser never touches the ROM.
 *
 * Usage:  bun tools/extract-rom-assets.js [--out public] [--rom <path>]
 *
 * Writes:
 *   public/maps/{layoutId}.png         every map layout, full size, DAY
 *                                      colours, no sprites composited
 *   public/overworld/player-{facing}.png       and player-bike-{facing}.png
 *   public/overworld/mon/{species}.png         standing south (internal id)
 *   public/overworld/mon/{species}-{facing}.png  the other three facings
 *   public/badges/{1..8}.png
 *   public/trainer/male.png            copied from the vendored art
 *   public/manifest.json               dimensions + which assets exist
 *
 * The app applies the day/night tint and composites sprites client-side (see
 * lib/gfx/client.js), which is why the maps ship untinted and bare.
 */

import { mkdirSync, copyFileSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import { renderMap } from "../lib/gfx/gba-map.js";
import { badgeSprites, monOverworldSprite, playerSprite } from "../lib/gfx/rom-assets.js";
import { encodePNG } from "../lib/gfx/png-node.js";

const REPO = new URL("../", import.meta.url).pathname;
const args = process.argv.slice(2);
const argVal = (flag, dflt) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : dflt;
};
// resolve(), not join(): an absolute --out/--rom must not be pasted onto REPO.
const OUT = resolve(REPO, argVal("--out", "public"));
const ROM_PATH = resolve(REPO, argVal("--rom", "local/Pokemon Recharged Yellow.gba"));
const GAMEDATA = join(REPO, "research", "gamedata.json");
const TRAINER_SRC = join(REPO, "research", "tools", "assets", "trainer-pic-male.png");

const FACINGS = ["down", "up", "left", "right"];
// graphicsId 0 = male walking (16x32), 1 = male on bike (32x32); both from
// hack-offsets.json player_sprite_rendering.
const PLAYER_GFX = { "": 0, "bike-": 1 };

const rom = new Uint8Array(readFileSync(ROM_PATH));
const gamedata = JSON.parse(readFileSync(GAMEDATA, "utf8"));

for (const d of ["maps", "overworld/mon", "badges", "trainer"]) {
  mkdirSync(join(OUT, d), { recursive: true });
}

let bytes = 0;
let lastBytes = 0;
const failures = [];
// Manifest records stay lean (file/width/height) -- it ships to the browser;
// byte counts are tallied separately for the size report.
function write(relPath, { rgba, width, height }) {
  const png = encodePNG(rgba, width, height);
  writeFileSync(join(OUT, relPath), png);
  bytes += png.length;
  lastBytes = png.length;
  return { file: `public/${relPath}`, width, height };
}

// --- maps ------------------------------------------------------------------
// research/gamedata.json maps: {"group,num": {layout_id, map_type, name, ...}}.
// Many maps share a layout, so render each layout once and record every
// (group,num) that uses it -- mapType lives on the header, not the layout, so
// it is stored per map (it gates the day/night tint).
const manifest = {
  rom: ROM_PATH.split("/").pop(),
  generated: new Date().toISOString(),
  note: "Maps are DAY colours with no sprites; apply tint and composite client-side.",
  mapLayouts: {},
  maps: {},
  overworld: { player: {}, mon: {} },
  badges: [],
  trainer: {},
  emptySpecies: [], // Gen 3 unused slots: no overworld graphics exist
  failures,
};

const layoutSource = new Map(); // layoutId -> [group, num]
for (const [key, info] of Object.entries(gamedata.maps)) {
  const [group, num] = key.split(",").map(Number);
  const layoutId = info.layout_id;
  if (!layoutSource.has(layoutId)) layoutSource.set(layoutId, [group, num]);
  manifest.maps[key] = {
    layout: layoutId,
    mapType: info.map_type,
    name: info.name,
    mapsec: info.mapsec,
  };
}

const layoutIds = [...layoutSource.keys()].sort((a, b) => a - b);
let mapBytes = 0;
for (const layoutId of layoutIds) {
  const [group, num] = layoutSource.get(layoutId);
  try {
    const r = renderMap(rom, group, num, { applyTint: false });
    const rec = write(`maps/${layoutId}.png`, r);
    mapBytes += lastBytes;
    manifest.mapLayouts[layoutId] = {
      file: rec.file,
      width: r.width,
      height: r.height,
      widthMetatiles: r.widthMetatiles,
      heightMetatiles: r.heightMetatiles,
      source: [group, num],
    };
  } catch (e) {
    failures.push({ kind: "map", layoutId, source: [group, num], error: String(e.message || e) });
  }
}

// --- overworld sprites -----------------------------------------------------
for (const [prefix, gfxId] of Object.entries(PLAYER_GFX)) {
  const frames = {};
  for (const facing of FACINGS) {
    try {
      frames[facing] = write(
        `overworld/player-${prefix}${facing}.png`,
        playerSprite(rom, gfxId, facing),
      );
    } catch (e) {
      failures.push({ kind: "player", gfxId, facing, error: String(e.message || e) });
    }
  }
  manifest.overworld.player[prefix ? "bike" : "walk"] = frames;
}

// Mon overworld sprites, indexed by INTERNAL species id (the ids the parser
// reports). gamedata.json species is keyed by the same internal id. Internal
// 252-276 are the Gen 3 unused slots (name "?"), which have null graphics
// pointers -- they are recorded as empty, not as failures.
const speciesIds = Object.keys(gamedata.species).map(Number).sort((a, b) => a - b);
for (const species of speciesIds) {
  const frames = {};
  const errors = [];
  for (const facing of FACINGS) {
    const rel =
      facing === "down"
        ? `overworld/mon/${species}.png`
        : `overworld/mon/${species}-${facing}.png`;
    try {
      frames[facing] = write(rel, monOverworldSprite(rom, species, facing));
    } catch (e) {
      errors.push({ kind: "mon", species, facing, error: String(e.message || e) });
    }
  }
  if (Object.keys(frames).length) manifest.overworld.mon[species] = frames;
  else if (gamedata.species[species] === "?") manifest.emptySpecies.push(species);
  else failures.push(...errors);
}

// --- badges ----------------------------------------------------------------
try {
  badgeSprites(rom).forEach((b, i) => {
    manifest.badges.push({ n: i + 1, ...write(`badges/${i + 1}.png`, b) });
  });
} catch (e) {
  failures.push({ kind: "badges", error: String(e.message || e) });
}

// --- trainer art (vendored PNG, not a ROM extraction) ----------------------
copyFileSync(TRAINER_SRC, join(OUT, "trainer", "male.png"));
const trainerBytes = statSync(join(OUT, "trainer", "male.png")).size;
bytes += trainerBytes;
manifest.trainer.male = { file: "public/trainer/male.png" };

writeFileSync(join(OUT, "data", "manifest.json"), `${JSON.stringify(manifest, null, 1)}\n`);

const mb = (n) => `${(n / 1024 / 1024).toFixed(2)} MB`;
console.log(
  [
    `maps:      ${Object.keys(manifest.mapLayouts).length} layouts for ` +
      `${Object.keys(manifest.maps).length} maps, ${mb(mapBytes)}`,
    `mon:       ${Object.keys(manifest.overworld.mon).length} species x ${FACINGS.length} facings`,
    `player:    ${Object.keys(PLAYER_GFX).length} sheets x ${FACINGS.length} facings`,
    `badges:    ${manifest.badges.length}`,
    `total:     ${mb(bytes)} + manifest`,
    `empty:     ${manifest.emptySpecies.length} species with no overworld graphics`,
    `failures:  ${failures.length}`,
  ].join("\n"),
);
if (failures.length) console.log(JSON.stringify(failures.slice(0, 20), null, 1));
