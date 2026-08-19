/**
 * Default data tables for the parser.
 *
 * The JSON under public/data/ is a COPY of the canonical files in research/ (see
 * sync-data.js to refresh it).
 *
 * Loading strategy, in order, per file:
 *   1. dynamic import with a JSON import attribute — fastest, and the only one
 *      that needs no extra network round trip in Bun;
 *   2. fetch() — every browser back to the ES-module era, and the fallback that
 *      makes older Safari and Firefox work;
 *   3. node:fs — for the Bun/Node CLI, where fetch may not read file: URLs.
 *
 * These MUST be dynamic. A static `import ... with { type: "json" }` is rejected
 * at module-parse time by engines that lack import attributes (Safari before
 * 17.2, Firefox before 138), which would take the whole app down before a single
 * line of it ran — and no try/catch inside this module could rescue it, because
 * the module itself would never parse. A dynamic import fails at call time
 * instead, which is catchable.
 *
 * The top-level await below means importing this module (or index.js) resolves
 * only once the tables are in hand, so parseRam stays synchronous for callers.
 */

import { Config, GameData } from "./config.js";
import { Codec } from "./pokemon.js";

const FILES = {
  hackOffsets: "hack-offsets.json",
  offsetsDiscovered: "offsets-discovered.json",
  gamedataRaw: "gamedata.json",
  structs: "structs.json",
};

/** Exported so the fallback chain itself can be tested. */
export async function loadJson(filename) {
  const url = new URL(`../../public/data/${filename}`, import.meta.url);
  const attempts = [];

  try {
    const mod = await import(url.href, { with: { type: "json" } });
    if (mod?.default) return mod.default;
    attempts.push("import attribute: no default export");
  } catch (e) {
    attempts.push(`import attribute: ${e.message}`);
  }

  try {
    const res = await fetch(url);
    if (res.ok) return await res.json();
    attempts.push(`fetch: HTTP ${res.status}`);
  } catch (e) {
    attempts.push(`fetch: ${e.message}`);
  }

  // Last resort, and the only branch that touches a platform API. It is never
  // reached in a browser (fetch above succeeds there), and the import is dynamic
  // so a browser never has to resolve the specifier.
  try {
    const { readFile } = await import("node:fs/promises");
    return JSON.parse(await readFile(url, "utf8"));
  } catch (e) {
    attempts.push(`node:fs: ${e.message}`);
  }

  throw new Error(`could not load public/data/${filename} -- ${attempts.join("; ")}`);
}

const loaded = Object.fromEntries(
  await Promise.all(
    Object.entries(FILES).map(async ([key, filename]) => [key, await loadJson(filename)]),
  ),
);

export const hackOffsets = loaded.hackOffsets;
export const offsetsDiscovered = loaded.offsetsDiscovered;
export const gamedataRaw = loaded.gamedataRaw;
export const structs = loaded.structs;

/**
 * Build a parsing context: the two config layers Python loads (offsets-discovered,
 * then hack-offsets), the gamedata name tables, and the charmap/permutation codec.
 *
 * Every table can be overridden with an already-parsed object, so a caller that
 * wants to control loading and caching can bypass the loader above entirely:
 *
 *   const gamedata = await (await fetch("public/data/gamedata.json")).json();
 *   const ctx = createContext({ gamedata });
 *   const state = parseRam({ iwram, ewram }, { context: ctx });
 *
 * @param {{gamedata?: object, structs?: object, hackOffsets?: object,
 *          offsetsDiscovered?: object}} [tables]
 */
export function createContext(tables = {}) {
  const cfg = new Config();
  cfg.loadData(
    tables.offsetsDiscovered ?? offsetsDiscovered,
    "discovered",
    "public/data/offsets-discovered.json",
  );
  cfg.loadData(tables.hackOffsets ?? hackOffsets, "hack-offsets", "public/data/hack-offsets.json");
  return {
    cfg,
    gamedata: new GameData(tables.gamedata ?? gamedataRaw),
    codec: new Codec(tables.structs ?? structs),
  };
}
