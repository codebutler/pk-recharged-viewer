#!/usr/bin/env bun
/**
 * Equivalence harness: run the Python parser and the JS parser over every
 * available input and deep-diff their JSON output.
 *
 *   bun tests/compare-python.js            # all inputs
 *   bun tests/compare-python.js --limit 5  # first N inputs (quick loop)
 *   bun tests/compare-python.js --filter statepair
 *
 * Two fields are normalized before diffing because they necessarily differ
 * between the implementations:
 *   meta.tool                   ("parse_ram.py" vs "parse-ram.js")
 *   meta.config_layers[*].file  (research/ paths vs public/data/ paths)
 * Everything else must match exactly (key order is ignored).
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const PY = join(REPO, "research", "tools", "parse_ram.py");
// The handheld backups are dated directories that come and go as the user takes
// new ones, so resolve the newest rather than pinning one. Missing is fine --
// the repo copies under research/real-saves/ cover the same states.
const BACKUP_ROOTS = ["/Users/eric/Code/RGSP/backups", "/Users/eric"];
function newestRealSaves() {
  const hits = [];
  for (const root of BACKUP_ROOTS) {
    let names = [];
    try { names = readdirSync(root); } catch { continue; }
    for (const n of names) {
      if (!n.startsWith("rgsp-saves-backup-")) continue;
      for (const sub of ["userdata/shared/MGBA-mgba", "shared/MGBA-mgba"]) {
        const p = join(root, n, sub);
        if (existsSync(p)) hits.push([n, p]);
      }
    }
  }
  hits.sort((a, b) => a[0].localeCompare(b[0]));
  return hits.length ? hits[hits.length - 1][1] : null;
}
const REAL_SAVES = newestRealSaves();

/** Recursively collect directories holding both iwram.bin and ewram.bin. */
async function findDumpDirs(root) {
  const out = [];
  const walk = async (dir) => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const names = new Set(entries.filter((e) => e.isFile()).map((e) => e.name));
    if (names.has("iwram.bin") && names.has("ewram.bin")) out.push(dir);
    for (const e of entries) if (e.isDirectory()) await walk(join(dir, e.name));
  };
  await walk(root);
  out.sort();
  return out;
}

function normalize(obj) {
  if (obj && typeof obj === "object" && obj.meta) {
    delete obj.meta.tool;
    for (const layer of obj.meta.config_layers ?? []) delete layer.file;
  }
  return obj;
}

/** Collect every value difference between two JSON trees (key order ignored). */
function diff(a, b, path = "", out = []) {
  if (a === b) return out;
  const ta = a === null ? "null" : Array.isArray(a) ? "array" : typeof a;
  const tb = b === null ? "null" : Array.isArray(b) ? "array" : typeof b;
  if (ta !== tb) {
    out.push(`${path || "<root>"}: type ${ta} (py) vs ${tb} (js)`);
    return out;
  }
  if (ta === "array") {
    if (a.length !== b.length) {
      out.push(`${path}: length ${a.length} (py) vs ${b.length} (js)`);
    }
    for (let i = 0; i < Math.min(a.length, b.length); i++) diff(a[i], b[i], `${path}[${i}]`, out);
    return out;
  }
  if (ta === "object") {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) {
      const p = path ? `${path}.${k}` : k;
      if (!(k in a)) out.push(`${p}: missing in py (js has ${JSON.stringify(b[k])?.slice(0, 120)})`);
      else if (!(k in b)) out.push(`${p}: missing in js (py has ${JSON.stringify(a[k])?.slice(0, 120)})`);
      else diff(a[k], b[k], p, out);
    }
    return out;
  }
  out.push(`${path}: ${JSON.stringify(a)} (py) vs ${JSON.stringify(b)} (js)`);
  return out;
}

async function run(cmd) {
  const proc = Bun.spawn(cmd, { cwd: REPO, stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  await proc.exited;
  return { stdout, stderr, code: proc.exitCode };
}

const args = process.argv.slice(2);
const limit = args.includes("--limit") ? Number(args[args.indexOf("--limit") + 1]) : Infinity;
const filter = args.includes("--filter") ? args[args.indexOf("--filter") + 1] : null;

const inputs = [];
for (const dir of await findDumpDirs(join(REPO, "research", "dumps"))) {
  inputs.push({ label: relative(REPO, dir), pyArgs: [dir], jsArgs: [dir] });
}
for (const name of REAL_SAVES
       ? ["Pokemon Recharged Yellow.gba.st0", "Pokemon Recharged Yellow.gba.st9"]
       : []) {
  const p = join(REAL_SAVES, name);
  try {
    await stat(p);
    inputs.push({ label: `real-save: ${name}`, pyArgs: ["--state", p], jsArgs: ["--state", p] });
  } catch {
    console.warn(`skipping missing real save: ${p}`);
  }
}
for (const name of ["st0.bin", "st9.bin"]) {
  const p = join(REPO, "research", "real-saves", name);
  try {
    await stat(p);
    inputs.push({ label: `real-saves/${name}`, pyArgs: ["--state", p], jsArgs: ["--state", p] });
  } catch {
    /* optional */
  }
}
// Container variants of one known dump (PNG and raw serialized state).
for (const name of ["state_all.ss", "state_default.ss", "state_screenshot.ss", "state_flags0.ss"]) {
  const p = join(REPO, "research", "dumps", "statepair", name);
  try {
    await stat(p);
    inputs.push({ label: `statepair/${name}`, pyArgs: ["--state", p], jsArgs: ["--state", p] });
  } catch {
    /* optional */
  }
}

const selected = inputs.filter((i) => !filter || i.label.includes(filter)).slice(0, limit);

let matched = 0;
const failures = [];
for (const input of selected) {
  const py = await run(["python3", PY, ...input.pyArgs]);
  // process.execPath, not "bun": works regardless of the caller's PATH.
  const js = await run([process.execPath, join(REPO, "lib", "parser", "cli.js"), ...input.jsArgs]);
  let a;
  let b;
  try {
    a = normalize(JSON.parse(py.stdout));
    b = normalize(JSON.parse(js.stdout));
  } catch (e) {
    failures.push({ label: input.label, diffs: [`unparseable output: ${e.message}`, py.stderr.trim(), js.stderr.trim()] });
    continue;
  }
  if (py.code !== js.code) {
    failures.push({ label: input.label, diffs: [`exit code ${py.code} (py) vs ${js.code} (js)`] });
    continue;
  }
  const diffs = diff(a, b);
  if (diffs.length === 0) {
    matched += 1;
    console.log(`OK    ${input.label}`);
  } else {
    failures.push({ label: input.label, diffs });
    console.log(`DIFF  ${input.label}  (${diffs.length} differences)`);
    for (const d of diffs.slice(0, 8)) console.log(`        ${d}`);
    if (diffs.length > 8) console.log(`        ... ${diffs.length - 8} more`);
  }
}

console.log(`\n${matched}/${selected.length} inputs match exactly.`);
if (failures.length) {
  console.log(`${failures.length} differ: ${failures.map((f) => f.label).join(", ")}`);
  process.exit(1);
}
