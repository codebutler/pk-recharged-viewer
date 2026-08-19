import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createContext,
  gamedataRaw,
  hackOffsets,
  loadJson,
  offsetsDiscovered,
  structs,
} from "../lib/parser/data.js";

const REPO = join(import.meta.dir, "..");
const FILES = ["hack-offsets.json", "offsets-discovered.json", "gamedata.json", "structs.json"];

describe("data table loading", () => {
  test("every table loads and matches the module's exports", async () => {
    expect(await loadJson("hack-offsets.json")).toEqual(hackOffsets);
    expect(await loadJson("offsets-discovered.json")).toEqual(offsetsDiscovered);
    expect(await loadJson("gamedata.json")).toEqual(gamedataRaw);
    expect(await loadJson("structs.json")).toEqual(structs);
  });

  // The point of the fallback chain is that a browser without import attributes
  // gets IDENTICAL data, not merely *some* data. Exercise each strategy directly
  // and require they agree, for every table.
  test.each(FILES)("all three load strategies agree for %s", async (filename) => {
    const url = new URL(`../public/data/${filename}`, import.meta.url);

    const viaImport = (await import(url.href, { with: { type: "json" } })).default;
    const viaFetch = await (await fetch(url)).json();
    const viaFs = JSON.parse(await readFile(join(REPO, "public", "data", filename), "utf8"));

    expect(viaFetch).toEqual(viaImport);
    expect(viaFs).toEqual(viaImport);
  });

  test("a missing table reports what every strategy tried", async () => {
    const err = await loadJson("does-not-exist.json").catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain("could not load public/data/does-not-exist.json");
    // All three attempts must be named, so a load failure is diagnosable rather
    // than a bare "failed to fetch".
    expect(err.message).toContain("import attribute:");
    expect(err.message).toContain("fetch:");
    expect(err.message).toContain("node:fs:");
  });

  test("the loader is dynamic, so no static JSON import can break module parse", async () => {
    // A static `import ... with {type:"json"}` would fail to PARSE on Safari <17.2,
    // taking the whole app down. Guard against one being reintroduced.
    const src = await readFile(join(REPO, "lib", "parser", "data.js"), "utf8");
    expect(src).not.toMatch(/^\s*import\s+[^(]*\bwith\s*\{\s*type:\s*["']json["']/m);
  });

  test("context building is unaffected by which strategy loaded the tables", async () => {
    const fetched = {};
    for (const [key, filename] of [
      ["hackOffsets", "hack-offsets.json"],
      ["offsetsDiscovered", "offsets-discovered.json"],
      ["gamedata", "gamedata.json"],
      ["structs", "structs.json"],
    ]) {
      fetched[key] = await (await fetch(new URL(`../public/data/${filename}`, import.meta.url))).json();
    }
    const injected = createContext(fetched);
    const dflt = createContext();
    expect(injected.cfg.entries).toEqual(dflt.cfg.entries);
    expect(injected.gamedata.loaded).toBe(dflt.gamedata.loaded);
  });
});
