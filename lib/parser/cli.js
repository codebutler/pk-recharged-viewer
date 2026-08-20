#!/usr/bin/env bun
/**
 * CLI wrapper around the browser-safe parser:
 *
 *   bun lib/parser/cli.js --dump  <dumpdir-or-iwram.bin> [--ewram PATH] [--pretty]
 *   bun lib/parser/cli.js --state <savestate-or-.sav> [--pretty]      (--save is an alias)
 *
 * Every input takes an explicit flag and a bare filename is rejected. The JSON
 * output still matches research/tools/parse_ram.py field-for-field so
 * tests/compare-python.js can diff the two, but the argument surface
 * deliberately diverges from the oracle's. The oracle takes a bare positional
 * dump path; mirroring that here made it too easy to hand a savestate to the
 * dump reader and get back a confusing "missing dump file: .../ewram.bin",
 * naming a file the caller never meant to have.
 *
 * --state also accepts a flash .sav, which parse_ram.py does not. Detection is
 * by content, so the flag spelling need not match the container.
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

const USAGE = `usage:
  bun lib/parser/cli.js --dump  <dumpdir-or-iwram.bin> [--ewram PATH] [--pretty]
  bun lib/parser/cli.js --state <savestate-or-.sav> [--pretty]`;

function usageError(message) {
  process.stderr.write(`error: ${message}\n${USAGE}\n`);
  process.exit(2);
}

/**
 * Guess which flag a bare path was meant for, so the error can name it. Size is
 * enough: only a raw IWRAM dump is exactly IWRAM_SIZE, and every save container
 * is some other length.
 */
async function suggestFlagFor(path) {
  try {
    const st = await stat(path);
    if (st.isDirectory()) return "--dump";
    return st.size === IWRAM_SIZE ? "--dump" : "--state";
  } catch {
    return null;
  }
}

async function main(argv) {
  let dumpPath = null;
  let statePath = null;
  let ewramPath = null;
  let pretty = false;
  let doScan = true;
  const stray = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--state" || a === "--save") statePath = argv[++i];
    else if (a === "--dump") dumpPath = argv[++i];
    else if (a === "--ewram") ewramPath = argv[++i];
    else if (a === "--pretty") pretty = true;
    else if (a === "--no-scan") doScan = false;
    else stray.push(a);
  }
  if (stray.length) {
    const hint = await suggestFlagFor(stray[0]);
    usageError(
      `unexpected argument '${stray[0]}' -- every input needs an explicit flag` +
        (hint ? `\nhint: pass it as '${hint} ${stray[0]}'` : ""),
    );
  }
  if (dumpPath && statePath) usageError("--dump and --state are mutually exclusive");
  if (ewramPath && !dumpPath) usageError("--ewram only applies to --dump");
  if (!dumpPath && !statePath) usageError("need --dump or --state");

  let state;
  try {
    if (statePath) {
      // parseSaveFile detects the container: a 128KB flash .sav, or a savestate
      // in any of the three formats.
      let blob;
      try {
        blob = new Uint8Array(await readFile(statePath));
      } catch {
        throw new DumpError(`missing save file: ${statePath}`);
      }
      state = await parseSaveFile(blob, { doScan });
    } else {
      state = parseRam(await loadDump(dumpPath, ewramPath), { doScan });
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
