#!/usr/bin/env bun
/**
 * Refresh public/data/*.json from the canonical copies under research/.
 *
 * research/ is the source of truth (it is what the Python tools read); public/data/ is a
 * copy so the JS parser can load the tables in Bun and in the browser. Run after
 * any research/ offsets or gamedata change:  bun run sync-data
 */

import { copyFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const FILES = [
  ["research/hack-offsets.json", "public/data/hack-offsets.json"],
  ["research/structs.json", "public/data/structs.json"],
  ["research/gamedata.json", "public/data/gamedata.json"],
  ["research/species-mapping.json", "public/data/species-mapping.json"],
  ["research/tools/offsets-discovered.json", "public/data/offsets-discovered.json"],
];

for (const [src, dst] of FILES) {
  await copyFile(join(repo, src), join(repo, dst));
  console.log(`${src} -> ${dst}`);
}
