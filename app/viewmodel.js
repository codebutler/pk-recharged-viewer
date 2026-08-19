// viewmodel.js -- parsed game state -> plain view data for the components.
//
// This is a port of the context builders in research/tools/generate_page.py
// (mon_context, bag_context, dex_context, ...). Everything here is a pure
// function of the parsed state plus the prepared view data; nothing renders,
// nothing fetches, nothing depends on the ROM.
//
// The one structural difference from the Python: sprites are relative asset
// paths, not embedded data URIs, because the browser app ships real files.

const ASSET_BASE = new URL("../public/", import.meta.url);

/** Absolute URL for an asset path recorded in gamedata-view.json. */
export const assetUrl = (rel) => (rel ? new URL(rel, ASSET_BASE).href : null);

/** Load the prepared view data (see tools/prepare-assets.js). */
export async function loadViewData() {
  const [view, mapping] = await Promise.all([
    fetch(new URL("data/gamedata-view.json", ASSET_BASE)).then((r) => r.json()),
    fetch(new URL("data/species-mapping.json", ASSET_BASE)).then((r) => r.json()),
  ]);
  const internalToNational = {};
  for (const [internal, s] of Object.entries(mapping.species)) {
    internalToNational[Number(internal)] = s.national;
  }
  return { ...view, internalToNational };
}

// Type-chip palette lifted pixel-by-pixel from Emerald's own type icons:
// (body fill, 1px highlight along the top, shade along the bottom).
const TYPE_COLORS = {
  normal: ["#a8a878", "#d8d8c0", "#705848"],
  fighting: ["#c03028", "#f08030", "#484038"],
  flying: ["#a890f0", "#c8c0f8", "#705898"],
  poison: ["#a040a0", "#d880b8", "#483850"],
  ground: ["#e0c068", "#f8f878", "#886830"],
  rock: ["#b8a038", "#e0c068", "#886830"],
  bug: ["#a8b820", "#d8e030", "#789010"],
  ghost: ["#705898", "#a890f0", "#483850"],
  steel: ["#b8b8d0", "#d8d8c0", "#807870"],
  fire: ["#f08030", "#f8d030", "#c03028"],
  water: ["#6890f0", "#98d8d8", "#807870"],
  grass: ["#78c850", "#c0f860", "#588040"],
  electric: ["#f8d030", "#f8f878", "#b8a038"],
  psychic: ["#f85888", "#f8c0b0", "#906060"],
  ice: ["#98d8d8", "#d0f8e8", "#9090a0"],
  dragon: ["#7038f8", "#b8a0f8", "#483890"],
  dark: ["#705848", "#a8a878", "#484038"],
  // post-Gen-3, so it has no icon in the ROM: shaded to match the set
  fairy: ["#ee99ac", "#f8c0d0", "#a06070"],
  unknown: ["#68a090", "#70c8b0", "#206860"],
};

export const BADGE_NAMES = ["Boulder", "Cascade", "Thunder", "Rainbow",
                            "Soul", "Marsh", "Volcano", "Earth"];
const BADGE_COLORS = ["#9c9c94", "#4890e8", "#f8a800", "#e85890",
                      "#e878a0", "#c8a838", "#e05038", "#58b048"];

function typeInfo(name) {
  const [color, light, dark] = TYPE_COLORS[name] || ["#888", "#aaa", "#555"];
  return { name, color, light, dark };
}

/** Return [data, errorMessage]. Error/absent sections yield [null, msg]. */
function sectionData(state, key) {
  const v = state[key];
  if (v === undefined || v === null) return [null, "not present in this parse"];
  if (typeof v === "object" && !Array.isArray(v) && "error" in v && Object.keys(v).length <= 2) {
    return [null, v.error];
  }
  return [v, null];
}

const pct = (value, max) => (max ? Math.max(0, Math.min(100, Math.trunc((100 * value) / max))) : 0);
const comma = (n) => Number(n).toLocaleString("en-US");

// Gen 3 experience curves (integer math). PokeAPI growth-rate names map:
// medium = medium-fast, slow-then-very-fast = erratic,
// fast-then-very-slow = fluctuating.
export function expForLevel(rate, n) {
  const idiv = (a, b) => Math.floor(a / b);
  if (n <= 1) return 0;
  const n3 = n ** 3;
  switch (rate) {
    case "fast": return idiv(4 * n3, 5);
    case "medium": case "medium-fast": return n3;
    case "medium-slow": return idiv(6 * n3, 5) - 15 * n ** 2 + 100 * n - 140;
    case "slow": return idiv(5 * n3, 4);
    case "slow-then-very-fast": // erratic
      if (n < 50) return idiv(n3 * (100 - n), 50);
      if (n < 68) return idiv(n3 * (150 - n), 100);
      if (n < 98) return idiv(n3 * idiv(1911 - 10 * n, 3), 500);
      return idiv(n3 * (160 - n), 100);
    case "fast-then-very-slow": // fluctuating
      if (n < 15) return idiv(n3 * (idiv(n + 1, 3) + 24), 50);
      if (n < 36) return idiv(n3 * (n + 14), 50);
      return idiv(n3 * (idiv(n, 2) + 32), 50);
    default: return null;
  }
}

/** [pct, toNext] toward the next level, or [null, null] when unknown. */
function expProgress(data, national, level, experience) {
  if (!national || !(level >= 1 && level < 100) || experience === undefined || experience === null) {
    return [null, null];
  }
  const rate = data.species[national]?.growth;
  const cur = rate ? expForLevel(rate, level) : null;
  const next = rate ? expForLevel(rate, level + 1) : null;
  if (cur === null || next === null || next <= cur) return [null, null];
  return [pct(experience - cur, next - cur), Math.max(0, next - experience)];
}

function speciesInfo(data, internal) {
  const national = data.internalToNational[internal] || 0;
  const info = national ? data.species[national] : null;
  return { national, info };
}

function monContext(mon, data) {
  const { national, info } = speciesInfo(data, mon.species || 0);
  const species = mon.speciesName || info?.name || `#${national}`;
  const status = mon.status || {};
  let ailment = ["poison", "burn", "freeze", "paralysis", "badPoison"]
    .find((k) => status[k])?.toUpperCase() || "";
  if (status.sleepTurns) ailment = "SLEEP";
  const hp = mon.hp || 0;
  const maxHp = mon.stats?.maxHP || 0;
  const hpPct = pct(hp, maxHp);
  const level = mon.level || 0;
  const [expPct, expToNext] = expProgress(data, national, level, mon.experience);
  return {
    sprite: assetUrl(info?.sprite),
    name: mon.nickname || info?.name || "?",
    species,
    shiny: !!mon.shiny,
    level,
    ailment,
    types: (info?.types || []).map(typeInfo),
    hp, maxHp, hpPct,
    hpColor: hpPct > 50 ? "#58c858" : hpPct > 20 ? "#f8d030" : "#f05038",
    expPct, expToNext: expToNext === null ? null : comma(expToNext),
    maxed: level >= 100,
    moves: (mon.moves || []).map((m) => {
      const t = data.moveTypes[m.move];
      return { name: m.name || `move ${m.move}`, type: t ? typeInfo(t) : null, pp: m.pp || 0 };
    }),
    held: mon.heldItem ? (mon.heldItemName || `item #${mon.heldItem}`) : null,
  };
}

export function trainerContext(state) {
  const [p, err] = sectionData(state, "player");
  if (!p) return { error: err };
  const badgeMap = state.badges?.badges || {};
  const pt = p.playTime || {};
  const dexOwned = state.pokedex && typeof state.pokedex === "object"
    ? state.pokedex.ownedCount : null;
  // Fields exactly as the in-game card shows them (no thousands separators,
  // Pokedollar sign, dex = owned count).
  const fields = [
    ["Money", `₽${p.money || 0}`],
    ["Pokédex", String(dexOwned ?? "?")],
    ["Time", `${pt.hours || 0}:${String(pt.minutes || 0).padStart(2, "0")}`],
  ];
  return {
    name: p.name || "?",
    gender: p.gender || "male",
    idno: `IDNo.${String(p.trainerId || 0).padStart(5, "0")}`,
    fields,
    badges: BADGE_NAMES.map((n, i) => ({
      name: n, color: BADGE_COLORS[i], lit: !!badgeMap[n], n: i + 1,
    })),
  };
}

function partyContext(state, data) {
  const [party, err] = sectionData(state, "party");
  if (!party) return { error: err };
  const mons = (party.pokemon || []).filter((m) => m && !("error" in m));
  if (!mons.length) {
    return { empty: "No Pokemon in the party yet -- this trainer's journey hasn't started." };
  }
  return { mons: mons.map((m) => monContext(m, data)) };
}

function bagContext(state, data) {
  const [bag, err] = sectionData(state, "bag");
  if (!bag) return { error: err };
  const labels = [["items", "ITEMS"], ["medicine", "MEDICINE"],
                  ["pokeBalls", "POKE BALLS"], ["tmHm", "TM / HM"],
                  ["berries", "BERRIES"], ["keyItems", "KEY ITEMS"]];
  const pockets = [];
  let anyItems = false;
  for (const [key, label] of labels) {
    const slots = bag[key];
    if (!slots) continue;
    const items = slots.map((s) => {
      anyItems = true;
      const name = s.name || `item #${s.itemId}`;
      return {
        name,
        qty: s.quantity || 0,
        sprite: s.name ? assetUrl(data.items[name.toLowerCase()]) : null,
      };
    });
    pockets.push({ label, slots: items });
  }
  if (!anyItems) return { empty: "The bag is empty." };
  return {
    pockets,
    registered: bag.registeredItem
      ? (bag.registeredItemName || `item #${bag.registeredItem}`) : null,
    warning: bag.warning || null,
  };
}

function dexContext(state, data) {
  const [dex, err] = sectionData(state, "pokedex");
  if (!dex) return { error: err };
  const seen = dex.seen || [];
  const owned = new Set(dex.owned || []);
  const ctx = { seenCount: dex.seenCount || 0, ownedCount: dex.ownedCount || 0 };
  if (!seen.length) return { ...ctx, empty: "No Pokemon seen yet." };
  ctx.cells = seen.map((nat) => {
    const info = data.species[nat];
    const isOwned = owned.has(nat);
    return {
      sprite: assetUrl(info?.sprite),
      owned: isOwned,
      label: `#${String(nat).padStart(3, "0")} ${info?.name || "?"}${isOwned ? "" : " (seen)"}`,
    };
  });
  return ctx;
}

function boxesContext(state, data) {
  const [pc, err] = sectionData(state, "pcBoxes");
  if (!pc) return { error: err };
  const total = pc.totalStored || 0;
  if (total === 0) return { empty: "All 14 boxes are empty." };
  const shown = [];
  for (const box of pc.boxes || []) {
    const mons = new Map((box.pokemon || []).map((m) => [m.slot, m]));
    if (!mons.size) continue;
    const cells = [];
    for (let s = 0; s < 30; s++) {
      const m = mons.get(s);
      if (!m) { cells.push(null); continue; }
      const { info } = speciesInfo(data, m.species || 0);
      let label = `${m.speciesName || "?"} Lv?`;
      if (m.nickname && m.nickname !== m.speciesName) {
        label = `${m.nickname} (${m.speciesName || "?"})`;
      }
      cells.push({ sprite: assetUrl(info?.sprite), label });
    }
    shown.push({ name: box.name || "Box", cells });
  }
  return {
    total,
    current: pc.currentBox || 1,
    nEmpty: (pc.boxes || []).filter((b) => !(b.pokemon || []).length).length,
    shown,
  };
}

function gameStatsContext(state) {
  const [gs, err] = sectionData(state, "gameStats");
  if (!gs) return { error: err };
  const named = gs.named || {};
  const rows = Object.entries(named)
    .filter(([k]) => !k.startsWith("UNKNOWN"))
    .map(([k, v]) => [
      k.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
      comma(v),
    ]);
  if (!rows.length) return { empty: "All counters are zero." };
  return { rows };
}

function challengeContext(state) {
  const [lc] = sectionData(state, "levelCap");
  if (!lc) return null;
  const ch = lc.challengeOptions || {};
  if (!ch.levelCapEnabled) {
    return { empty: `Level cap disabled -- cap is ${lc.cap ?? 100}.` };
  }
  return { cap: lc.cap ?? 100, mode: ch.capMode || 0 };
}

function mailContext(state) {
  const [mail, err] = sectionData(state, "mail");
  if (!mail) return { error: err };
  const entries = mail.entries || [];
  if (!entries.length) return { empty: "No mail held or stored." };
  return {
    entries: entries.map((e) => ({
      slot: e.slot, kind: e.slotKind || "?",
      itemId: e.itemId || 0, sender: e.playerName || "?",
    })),
  };
}

/** 12-hour clock text for the in-game-style popup box. */
export function clock12(clock) {
  if (!clock) return null;
  const h24 = clock.hour || 0;
  const h12 = h24 % 12 || 12;
  return `${h12}:${String(clock.minute || 0).padStart(2, "0")} ${h24 < 12 ? "AM" : "PM"}`;
}

/** Everything the components need, derived from the save alone. */
export function buildView(state, data) {
  const inGame = !!state.inGame;
  const playerName = inGame ? (state.player?.name || "?") : "no save";
  if (!inGame) {
    return {
      inGame: false,
      title: `${playerName} -- Recharged Yellow`,
      error: state.error || "This memory dump holds no game state.",
    };
  }
  const ctx = {
    inGame: true,
    title: `${playerName} -- Recharged Yellow`,
    playerName,
    trainer: trainerContext(state),
    party: partyContext(state, data),
    bag: bagContext(state, data),
    dex: dexContext(state, data),
    boxes: boxesContext(state, data),
    gameStats: gameStatsContext(state),
    challenge: challengeContext(state),
    mail: mailContext(state),
    rival: state.rivalName || null,
    location: state.location || null,
    clock: state.gameClock || null,
    // Present when the state did not come from live RAM (a flash .sav). The
    // caveat text is the parser's own -- never a paraphrase.
    source: state.source || null,
  };
  // A tab is "empty" (dimmed label) when its section(s) carry only an
  // empty/error state.
  const isEmpty = (sec) => !sec || !!(sec.empty || sec.error);
  ctx.tabs = [
    { id: "party", label: "PARTY", empty: isEmpty(ctx.party) },
    { id: "bag", label: "BAG", empty: isEmpty(ctx.bag) },
    { id: "pokedex", label: "POKEDEX", empty: isEmpty(ctx.dex) },
    { id: "storage", label: "STORAGE", empty: isEmpty(ctx.boxes) },
    { id: "stats", label: "STATS", empty: isEmpty(ctx.gameStats) },
    { id: "more", label: "MORE",
      empty: isEmpty(ctx.challenge) && isEmpty(ctx.mail) && !ctx.rival },
  ];
  return ctx;
}
