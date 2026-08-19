// io.js -- the only place that talks to the parser and graphics modules.
//
// lib/parser/** and lib/gfx/** are separate, ROM/RAM-level libraries; this file
// adapts them to what the UI needs (data URLs, one map object, honest error
// strings) so their contracts land in one place. Both are imported lazily, so
// dropping a parsed-state .json works even if they are unavailable, and the UI
// then says plainly what is missing instead of rendering blanks.

/** Read a File as Uint8Array. */
export const fileBytes = async (file) => new Uint8Array(await file.arrayBuffer());

async function importOptional(path) {
  try {
    return await import(path);
  } catch (e) {
    console.warn(`optional module ${path} not loaded:`, e.message);
    return null;
  }
}

export function classify(file) {
  const name = file.name.toLowerCase();
  if (name.endsWith(".json")) return "state-json";
  if (name.endsWith(".gba")) return "rom";
  if (name === "iwram.bin") return "iwram";
  if (name === "ewram.bin") return "ewram";
  // Savestates and flash .sav files alike: the parser tells them apart by
  // content, so the extension never decides.
  return "save-file";
}

const PARSER_MISSING =
  "The in-browser parser (lib/parser) could not be loaded. You can still drop " +
  "a parse_ram.py output .json.";

/**
 * Parse dropped save input into a game-state object.
 *   files: File[] -- one savestate / PNG container, one parsed-state .json, or
 *          the iwram.bin + ewram.bin pair.
 * Throws Error carrying the parser's own message on failure.
 */
export async function parseSaveFiles(files) {
  const byKind = {};
  for (const f of files) (byKind[classify(f)] ||= []).push(f);

  if (byKind["state-json"]) {
    const text = await byKind["state-json"][0].text();
    let state;
    try {
      state = JSON.parse(text);
    } catch (e) {
      throw new Error(`That .json is not valid JSON (${e.message}).`);
    }
    if (!("inGame" in state)) {
      throw new Error('That .json does not look like parse_ram.py output (no "inGame" key).');
    }
    return state;
  }

  // A ROM is a reasonable thing to try dropping, and the save reader's
  // complaint about it would be baffling. Say what is actually true instead.
  if (byKind.rom) {
    throw new Error("That is the game ROM, not a save. Drop a savestate or a .sav " +
                    "instead -- the map, badges and sprites already ship with this " +
                    "page, so no ROM is needed.");
  }

  const parser = await importOptional("../lib/parser/index.js");
  if (!parser) throw new Error(PARSER_MISSING);

  if (byKind.iwram && byKind.ewram) {
    return parser.parseRam({
      iwram: await fileBytes(byKind.iwram[0]),
      ewram: await fileBytes(byKind.ewram[0]),
    });
  }
  if (byKind.iwram || byKind.ewram) {
    throw new Error("A raw dump needs BOTH iwram.bin and ewram.bin -- drop the pair together.");
  }

  const file = (byKind["save-file"] || [])[0];
  if (!file) {
    throw new Error("Drop a savestate (.st0/.st9/.ss*/PNG), a flash .sav, a raw " +
                    "iwram.bin + ewram.bin pair, or a parsed-state .json.");
  }
  // One entry point for both containers: parseSaveFile routes a 128KB flash
  // .sav to the sector reader and everything else to the savestate reader.
  return parser.parseSaveFile(await fileBytes(file));
}

// ---------------------------------------------------------------------------
// Artwork: badges, the overworld player sprite, and the map, all from the PNGs
// under public/ that tools/extract-rom-assets.js pulled out of the ROM ahead
// of time (public/data/manifest.json is their index). The page therefore needs no
// ROM from the user; the save alone is enough.

const REPO_BASE = new URL("../", import.meta.url);
const repoUrl = (rel) => new URL(rel, REPO_BASE).href;

let manifestPromise = null;
/** public/data/manifest.json, or null when the extracted assets are not deployed. */
export function loadManifest() {
  manifestPromise ||= fetch(repoUrl("public/data/manifest.json"))
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);
  return manifestPromise;
}

const loadImage = (rel) =>
  new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`could not load ${rel}`));
    img.src = repoUrl(rel);
  });

/**
 * Artwork from the pre-extracted assets: badge and trainer PNGs straight off
 * disk, and the map composed client-side (tint for the in-game clock, then the
 * player and follower sprites on top -- public/maps/*.png are untinted day
 * colours with no sprite layer).
 */
export async function buildAssetArtwork(state) {
  const manifest = await loadManifest();
  if (!manifest) {
    return { badges: [], playerSprite: null,
             map: { error: "The extracted map assets are not deployed with this page." } };
  }
  const out = {
    badges: (manifest.badges || []).map((b) => repoUrl(b.file)),
    playerSprite: null,
    map: null,
  };
  const avatar = state.playerAvatar || {};
  const facing = avatar.facing || "down";
  // onBike is null (not false) on a flash save -- the bike flag is live-only.
  // Unknown falls to the walking sprite, and the save-source note under the
  // header is what tells the reader this is as-of-last-save.
  const playerSet = manifest.overworld?.player?.[avatar.onBike ? "bike" : "walk"];
  const playerEntry = playerSet?.[facing] || playerSet?.down;
  if (playerEntry) out.playerSprite = repoUrl(playerEntry.file);

  const loc = state.location;
  const entry = loc && manifest.maps?.[`${loc.mapGroup},${loc.mapNum}`];
  const layout = entry && manifest.mapLayouts?.[String(entry.layout)];
  if (!layout) {
    out.map = { error: "no extracted map for this location" };
    return out;
  }
  try {
    const client = await importOptional("../lib/gfx/client.js");
    if (!client) throw new Error("lib/gfx/client.js could not be loaded");
    const mapImg = await loadImage(layout.file);
    // A sprite that will not load leaves the terrain alone rather than losing
    // the whole map -- the same call the Python generator made, and no red-box
    // stand-in.
    const sprites = [];
    const addSprite = async (entry, tileX, tileY) => {
      if (!entry || !Number.isFinite(tileX) || !Number.isFinite(tileY)) return;
      try {
        sprites.push({ image: await loadImage(entry.file), tileX, tileY });
      } catch (e) {
        console.warn("map sprite:", e.message);
      }
    };
    await addSprite(playerEntry, loc.x || 0, loc.y || 0);
    const f = avatar.follower;
    if (f && f.present && f.species && !f.hidden && Array.isArray(f.coords)) {
      // objectEvent coords are map coords + 7. Species with no overworld
      // graphics in the ROM (manifest.emptySpecies) simply have no entry.
      await addSprite(manifest.overworld?.mon?.[String(f.species)]?.[f.facing || "down"],
                      f.coords[0] - 7, f.coords[1] - 7);
    }
    // The game draws the overworld sprite layer back to front by row, so the
    // character on the souther tile occludes the other. Sort is stable and the
    // player was pushed first, so a follower sharing the player's tile (mid-step)
    // lands on top -- which is what the reference renderer does.
    sprites.sort((a, b) => a.tileY - b.tileY);
    // The full map gets the same treatment as the viewport, so the two states
    // of the map box are the same picture at two zooms.
    const fullCanvas = document.createElement("canvas");
    fullCanvas.width = mapImg.naturalWidth;
    fullCanvas.height = mapImg.naturalHeight;
    const fctx = fullCanvas.getContext("2d");
    fctx.imageSmoothingEnabled = false;
    fctx.drawImage(mapImg, 0, 0);
    const { tint, phase } = client.dnsPhase(state.gameClock || null);
    const outdoor = client.isOutdoor(entry.mapType);
    if (tint && outdoor) {
      fctx.putImageData(
        client.applyTint(fctx.getImageData(0, 0, fullCanvas.width, fullCanvas.height), tint),
        0, 0);
    }
    for (const s of sprites) {
      const { x, y } = client.spriteAnchor(s.tileX, s.tileY, s.image.naturalWidth,
                                           s.image.naturalHeight);
      fctx.drawImage(s.image, x, y);
    }
    const crop = client.cropViewport(fullCanvas, loc.x || 0, loc.y || 0);
    out.map = {
      name: entry.name || loc.mapName || `map (${loc.mapGroup},${loc.mapNum})`,
      coords: `(${loc.x || 0}, ${loc.y || 0})`,
      phase: outdoor ? phase : null,
      cropUrl: crop.toDataURL("image/png"),
      fullUrl: fullCanvas.toDataURL("image/png"),
      small: layout.widthMetatiles < 15
        || (layout.widthMetatiles === 15 && layout.heightMetatiles <= 11),
    };
  } catch (e) {
    console.warn("map from assets failed:", e);
    out.map = { error: `map could not be rendered (${e.message})` };
  }
  return out;
}

/** Save an object as a downloaded .json file. */
export function downloadJson(obj, filename) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
