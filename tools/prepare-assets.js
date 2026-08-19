#!/usr/bin/env bun
// prepare-assets.js -- copy the small subset of the vendored PokeAPI submodules
// that the browser app needs, and bake one view-data JSON out of them.
//
//   bun run tools/prepare-assets.js
//
// vendor/pokeapi-sprites (3.2 GB) and vendor/pokeapi-data (2.2 GB) must never be
// deployed, so this pulls out only what the report renders -- 412 Gen-3 front
// sprites, ~409 item sprites, 8 badge renders -- into public/, which IS
// committed and deployed. Every lookup is a direct path read; the script never
// walks the submodule trees and never touches the network.
//
// It also emits public/data/gamedata-view.json: the per-species types + growth rate
// and per-move type that generate_page.py used to pull from PokeAPI at generate
// time, plus the name -> sprite-file map for items. Species ids in that file are
// NATIONAL dex numbers (the save holds Gen-3 internal ids; the app maps them
// through research/species-mapping.json, which is copied in as well).

import { mkdirSync, copyFileSync, existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const DATA = join(ROOT, "vendor/pokeapi-data/data/api/v2");
const SPRITES = join(ROOT, "vendor/pokeapi-sprites/sprites");
const OUT = join(ROOT, "public");

// Gen-3 item names whose PokeAPI slug is not the plain slugification.
// (Ported verbatim from generate_page.py ITEM_ALIASES.)
const ITEM_ALIASES = {
  "parlyz heal": "paralyze-heal",
  "thunderstone": "thunder-stone",
  "x defend": "x-defense",
  "x special": "x-sp-atk",
  "s.s. ticket": "ss-ticket",
  "guard spec.": "guard-spec",
  "exp. share": "exp-share",
  "itemfinder": "dowsing-machine",
  "pokeblock case": "pokeblock-case",
  "gold b. cap": "gold-bottle-cap",
  "stardust": "stardust",
  // Gen-3 runs these names together; PokeAPI spells them as separate words.
  // (The Python generator lacked these, so they rendered as placeholders.)
  "energypowder": "energy-powder",
  "tinymushroom": "tiny-mushroom",
  "brightpowder": "bright-powder",
  "silverpowder": "silver-powder",
  "deepseatooth": "deep-sea-tooth",
  "deepseascale": "deep-sea-scale",
  "blackglasses": "black-glasses",
  "nevermeltice": "never-melt-ice",
  "twistedspoon": "twisted-spoon",
};

// PokeAPI serves current-gen move types; these were Normal in Gen 3.
const GEN3_MOVE_TYPE_OVERRIDES = { 186: "normal", 204: "normal", 236: "normal" };

const readJson = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null);

function copy(from, to) {
  if (!existsSync(from)) return false;
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
  return true;
}

function slugify(name) {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\x00-\x7f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

const miss = { species: [], speciesData: [], item: [], move: [] };

// --- species: Gen-3 front sprite + types + growth rate ----------------------
const speciesMap = readJson(join(ROOT, "research/species-mapping.json"));
const nationals = [
  ...new Set(Object.values(speciesMap.species).map((s) => s.national).filter(Boolean)),
].sort((a, b) => a - b);

const viewSpecies = {};
for (const nat of nationals) {
  const mon = readJson(join(DATA, `pokemon/${nat}/index.json`));
  const spec = readJson(join(DATA, `pokemon-species/${nat}/index.json`));
  if (!mon) {
    miss.speciesData.push(nat);
    continue;
  }
  // Same sprite preference chain as generate_page.py: emerald, then
  // firered-leafgreen, then the modern default.
  const src = ["versions/generation-iii/emerald", "versions/generation-iii/firered-leafgreen", ""]
    .map((sub) => join(SPRITES, "pokemon", sub, `${nat}.png`))
    .find(existsSync);
  const file = src ? `sprites/pokemon/${nat}.png` : null;
  if (src) copy(src, join(OUT, "sprites/pokemon", `${nat}.png`));
  else miss.species.push(nat);
  viewSpecies[nat] = {
    name: (mon.name || "").replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
    types: (mon.types || []).sort((a, b) => a.slot - b.slot).map((t) => t.type.name),
    growth: (spec?.growth_rate || {}).name || null,
    sprite: file,
  };
}

// --- moves: type only -------------------------------------------------------
const gamedata = readJson(join(ROOT, "research/gamedata.json"));
const viewMoves = {};
for (const id of Object.keys(gamedata.moves).map(Number).filter((n) => n > 0)) {
  const override = GEN3_MOVE_TYPE_OVERRIDES[id];
  if (override) {
    viewMoves[id] = override;
    continue;
  }
  const mv = readJson(join(DATA, `move/${id}/index.json`));
  if (mv?.type?.name) viewMoves[id] = mv.type.name;
  else miss.move.push(id);
}

// --- items: sprite by display name -----------------------------------------
// The local item index maps slug -> numeric id; the item record then names its
// sprite file (which is itself slug-named, but not always the same slug).
const itemIndex = readJson(join(DATA, "item/index.json"));
const itemIds = {};
for (const r of itemIndex?.results || []) {
  const m = /\/item\/(\d+)\//.exec(r.url || "");
  if (m) itemIds[r.name] = Number(m[1]);
}

const viewItems = {};
for (const name of Object.values(gamedata.items)) {
  const key = name.toLowerCase();
  if (key in viewItems || key.startsWith("?")) continue;
  const slug = ITEM_ALIASES[key] || slugify(name);
  const id = itemIds[slug];
  const item = id ? readJson(join(DATA, `item/${id}/index.json`)) : null;
  const url = item?.sprites?.default;
  const base = url ? url.split("/").pop() : null;
  if (base && copy(join(SPRITES, "items", base), join(OUT, "sprites/items", base))) {
    viewItems[key] = `sprites/items/${base}`;
  } else {
    miss.item.push(name);
  }
}

// --- badges (the no-ROM fallback for the trainer card) ----------------------
for (let n = 1; n <= 8; n++) copy(join(SPRITES, "badges", `${n}.png`), join(OUT, "sprites/badges", `${n}.png`));

// --- fonts, cursors, trainer art (from the Python generator's asset dir) ----
const TOOLS = join(ROOT, "research/tools/assets");
for (const f of ["pokemon-emerald.otf", "pokemon-emerald-narrow.otf", "f77-pokemon-battle.otf",
                 "PROVENANCE.md", "license.txt", "readme.txt"]) {
  copy(join(TOOLS, "fonts", f), join(OUT, "fonts", f));
}
for (const f of ["default", "default-dark", "pointer", "pointer-dark", "zoom-in", "zoom-in-dark",
                 "zoom-out", "zoom-out-dark", "text"]) {
  copy(join(TOOLS, "cursors", `${f}.png`), join(OUT, "cursors", `${f}.png`));
}
copy(join(TOOLS, "cursors", "LICENSE.md"), join(OUT, "cursors", "LICENSE.md"));
copy(join(TOOLS, "trainer-pic-male.png"), join(OUT, "trainer-pic-male.png"));

// --- generated data ---------------------------------------------------------
writeFileSync(
  join(OUT, "data", "gamedata-view.json"),
  JSON.stringify(
    {
      meta: {
        generatedBy: "tools/prepare-assets.js",
        source: "vendor/pokeapi-data + vendor/pokeapi-sprites (local clones, no network)",
        note: "species keys are NATIONAL dex numbers; PokeAPI serves current-gen data, so types may include post-Gen-3 changes (e.g. Fairy)",
      },
      species: viewSpecies,
      moveTypes: viewMoves,
      items: viewItems,
    },
    null,
    0,
  ),
);
// The internal -> national map the app needs at runtime. (The parser reads its
// own tables from public/data/, kept in sync by lib/parser/sync-data.js -- this copy is
// only for the view layer's species lookups.)
copy(join(ROOT, "research/species-mapping.json"), join(OUT, "data", "species-mapping.json"));

const kb = (p) => (existsSync(p) ? (Bun.file(p).size / 1024).toFixed(0) : "?");
console.log(`species: ${Object.keys(viewSpecies).length} (${miss.species.length} without sprite, ${miss.speciesData.length} without data)`);
console.log(`items:   ${Object.keys(viewItems).length} with sprite, ${miss.item.length} without`);
console.log(`moves:   ${Object.keys(viewMoves).length} typed, ${miss.move.length} without`);
if (miss.item.length) console.log(`  unresolved items: ${miss.item.slice(0, 12).join(", ")}${miss.item.length > 12 ? ", ..." : ""}`);
console.log(`gamedata-view.json: ${kb(join(OUT, "data", "gamedata-view.json"))} KB`);
