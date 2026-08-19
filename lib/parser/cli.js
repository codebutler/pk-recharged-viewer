#!/usr/bin/env bun
/**
 * CLI wrapper around the browser-safe parser, mirroring parse_ram.py's interface:
 *
 *   bun lib/parser/cli.js <dumpdir-or-iwram.bin> [--ewram PATH] [--pretty]
 *   bun lib/parser/cli.js --state <savestate-or-.sav> [--pretty]
 *
 * --state also accepts a flash .sav, which parse_ram.py does not; everything else
 * matches the Python tool so the two can be diffed.
 *
 * This is the only file in lib/parser that touches the filesystem.
 */

import { readFile, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { DumpError, parseRam, parseSaveFile } from "./index.js";
import { EWRAM_SIZE, IWRAM_SIZE } from "./constants.js";

async function loadDump(target, ewramPath) {
  let iwramPath;
  let isDir = false;
  try {
    isDir = (await stat(target)).isDirectory();
  } catch {
    throw new DumpError(`missing dump file: ${target}`);
  }
  if (isDir) {
    iwramPath = join(target, "iwram.bin");
    ewramPath = ewramPath || join(target, "ewram.bin");
  } else {
    iwramPath = target;
    if (!ewramPath) ewramPath = join(dirname(target), "ewram.bin");
  }
  const regions = [];
  for (const [p, want] of [
    [iwramPath, IWRAM_SIZE],
    [ewramPath, EWRAM_SIZE],
  ]) {
    let buf;
    try {
      buf = new Uint8Array(await readFile(p));
    } catch {
      throw new DumpError(`missing dump file: ${p}`);
    }
    if (buf.length < want) {
      throw new DumpError(`dump truncated: ${p} is ${buf.length} bytes (expected ${want})`);
    }
    if (buf.length > want) {
      process.stderr.write(
        `warning: ${p} is ${buf.length} bytes (expected ${want}); using the first ${want}\n`,
      );
    }
    regions.push(buf.subarray(0, want));
  }
  return { iwram: regions[0], ewram: regions[1] };
}

async function main(argv) {
  let target = null;
  let statePath = null;
  let ewramPath = null;
  let pretty = false;
  let doScan = true;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--state") statePath = argv[++i];
    else if (a === "--ewram") ewramPath = argv[++i];
    else if (a === "--pretty") pretty = true;
    else if (a === "--no-scan") doScan = false;
    else target = a;
  }
  let state;
  try {
    if (statePath) {
      // parseSaveFile detects the container: a 128KB flash .sav, or a savestate
      // in any of the three formats.
      const blob = new Uint8Array(await readFile(statePath));
      state = await parseSaveFile(blob, { doScan });
    } else if (target) {
      state = parseRam(await loadDump(target, ewramPath), { doScan });
    } else {
      process.stderr.write("error: need a dump target or --state\n");
      process.exit(2);
    }
  } catch (e) {
    if (e instanceof DumpError) {
      process.stdout.write(JSON.stringify({ error: e.message }, null, pretty ? 2 : undefined) + "\n");
      process.exit(1);
    }
    throw e;
  }
  process.stdout.write(JSON.stringify(state, null, pretty ? 2 : undefined) + "\n");
}

await main(process.argv.slice(2));
