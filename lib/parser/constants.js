/**
 * Memory-map constants for Pokemon Recharged Yellow (port of parse_ram.py).
 * The prose comments are carried over because they record the evidence behind
 * each value; see research/hack-offsets.md for the full derivations.
 */

export const EWRAM_BASE = 0x02000000;
export const EWRAM_SIZE = 0x40000;
export const IWRAM_BASE = 0x03000000;
export const IWRAM_SIZE = 0x8000;

// Hack's SaveBlock sizes (hack-offsets.json meta.sizes, live-confirmed). Bytes at
// sb2+0xF64..0xFE3 are inter-block ASLR slack, NOT SaveBlock2.
export const SB1_SIZE = 0x3d94;
export const SB2_SIZE = 0xf64;

// Accelerated day/night clock at SB2+0xF5C (8-byte struct, ~9x real time).
export const GAME_CLOCK_OFF = 0xf5c;

// IWRAM addresses of the live save-block pointers (rom-fingerprint.md).
export const PTR_SAVEBLOCK1 = 0x03005ad0;
export const PTR_SAVEBLOCK2 = 0x03005ad4;
export const PTR_STORAGE = 0x03005ad8;

// Vanilla pokeemerald offsets. Overlaid by config files.
export const VANILLA_OFFSETS = {
  "sb2.playerName": { offset: 0x00, status: "vanilla-unverified" },
  "sb2.playerGender": { offset: 0x08, status: "vanilla-unverified" },
  "sb2.playerTrainerId": { offset: 0x0a, status: "vanilla-unverified" },
  "sb2.playTime": { offset: 0x0e, status: "vanilla-unverified" },
  "sb2.options": { offset: 0x14, status: "vanilla-unverified" },
  "sb2.pokedex": { offset: 0x18, status: "vanilla-unverified" },
  "sb2.encryptionKey": { offset: 0xac, status: "vanilla-unverified" },
  "sb1.pos": { offset: 0x000, status: "vanilla-unverified" },
  "sb1.location": { offset: 0x004, status: "vanilla-unverified" },
  "sb1.lastHealLocation": { offset: 0x01c, status: "vanilla-unverified" },
  "sb1.mapLayoutId": { offset: 0x032, status: "vanilla-unverified" },
  "sb1.partyCount": { offset: 0x234, status: "vanilla-unverified" },
  "sb1.playerParty": { offset: 0x238, status: "vanilla-unverified" },
  // Live party globals at fixed EWRAM addresses (offsets from 0x02000000).
  "ewram.partyCount": { offset: 0x38559, status: "vanilla-unverified" },
  "ewram.party": { offset: 0x3855c, status: "vanilla-unverified" },
  // Live overworld state: gObjectEvents[16] (stride 0x24) and gPlayerAvatar.
  "ewram.objectEvents": { offset: 0x5cd4, status: "vanilla-unverified" },
  "ewram.playerAvatar": { offset: 0x5f14, status: "vanilla-unverified" },
  "sb1.money": { offset: 0x490, status: "vanilla-unverified" },
  "sb1.coins": { offset: 0x494, status: "vanilla-unverified" },
  "sb1.registeredItem": { offset: 0x496, status: "vanilla-unverified" },
  "sb1.pcItems": { offset: 0x498, status: "vanilla-unverified" },
  "sb1.bagPocket_Items": { offset: 0x560, status: "vanilla-unverified" },
  "sb1.bagPocket_KeyItems": { offset: 0x5d8, status: "vanilla-unverified" },
  "sb1.bagPocket_PokeBalls": { offset: 0x650, status: "vanilla-unverified" },
  "sb1.bagPocket_TMHM": { offset: 0x690, status: "vanilla-unverified" },
  "sb1.bagPocket_Berries": { offset: 0x790, status: "vanilla-unverified" },
  "sb1.bagPocket_Medicine": { offset: null, status: "vanilla-unverified" },
  // Mail: RESOLVED at SB1+0x1D98 (the once-contested 0x910 is the saved
  // objectEvents copy). Slots 0-5 party, 6-15 PC.
  "sb1.mail": { offset: 0x1d98, status: "verified" },
  "sb1.berryTrees": { offset: 0x1998, status: "vanilla-unverified" },
  "sb1.flags": { offset: 0x1270, status: "vanilla-unverified" },
  "sb1.vars": { offset: 0x139c, status: "vanilla-unverified" },
  "sb1.gameStats": { offset: 0x159c, status: "vanilla-unverified" },
};

// (output name, config key, default capacity, expected pocket type). Pocket types
// are the hack's item-table pocket byte: 1=Items, 2=Medicine, 3=PokeBalls,
// 4=TM/HM, 5=Berries, 6=KeyItems.
export const BAG_POCKETS = [
  ["items", "sb1.bagPocket_Items", 30, 1],
  ["keyItems", "sb1.bagPocket_KeyItems", 30, 6],
  ["pokeBalls", "sb1.bagPocket_PokeBalls", 16, 3],
  ["tmHm", "sb1.bagPocket_TMHM", 64, 4],
  ["berries", "sb1.bagPocket_Berries", 46, 5],
  ["medicine", "sb1.bagPocket_Medicine", null, 2], // hack-only 6th pocket
];
export const PC_ITEMS_COUNT = 50;

/** hack-offsets.json section/field name -> our dotted config key. */
export const HACK_OFFSETS_KEYMAP = {
  SaveBlock1: {
    pos: "sb1.pos",
    location: "sb1.location",
    lastHealLocation: "sb1.lastHealLocation",
    mapLayoutId: "sb1.mapLayoutId",
    playerPartyCount: "sb1.partyCount",
    playerParty: "sb1.playerParty",
    money: "sb1.money",
    coins: "sb1.coins",
    registeredItem: "sb1.registeredItem",
    pcItems: "sb1.pcItems",
    bagPocket_Items: "sb1.bagPocket_Items",
    bagPocket_KeyItems: "sb1.bagPocket_KeyItems",
    bagPocket_PokeBalls: "sb1.bagPocket_PokeBalls",
    bagPocket_TMHM: "sb1.bagPocket_TMHM",
    bagPocket_Berries: "sb1.bagPocket_Berries",
    bagPocket_Medicine: "sb1.bagPocket_Medicine",
    bagPocket_extra100: "sb1.bagPocket_Medicine", // earlier name for the same pocket
    flags: "sb1.flags",
    vars: "sb1.vars",
    gameStats: "sb1.gameStats",
    berryTrees: "sb1.berryTrees",
  },
  SaveBlock2: {
    playerName: "sb2.playerName",
    playerGender: "sb2.playerGender",
    playerTrainerId: "sb2.playerTrainerId",
    playTimeHours: "sb2.playTime",
    options: "sb2.options",
    pokedex: "sb2.pokedex",
    encryptionKey: "sb2.encryptionKey",
  },
};

// PokemonStorage layout (verified fully vanilla for this hack).
export const STORAGE_BOXES = 14;
export const STORAGE_SLOTS = 30;
export const STORAGE_BOX_MONS = 0x4;
export const STORAGE_BOX_NAMES = 0x8344;
export const STORAGE_WALLPAPERS = 0x83c2;

// Badge flags for THIS hack: 0x880-0x887 (badge N = 0x880 + N - 1).
export const BADGE_FLAGS = Array.from({ length: 8 }, (_, i) => 0x880 + i);
export const BADGE_NAMES = [
  "Boulder", "Cascade", "Thunder", "Rainbow", "Soul", "Marsh", "Volcano", "Earth",
];

// Progress flags for THIS hack (hack-offsets.json progress_flags).
export const STARTER_TRIO_FLAGS = [0x860, 0x861, 0x87a];
export const STARTER_PAIR = [0x860, 0x861];
export const FLAG_GAME_CLEAR = 0x864; // champion / Hall of Fame; releases the level cap
export const FLAG_INTRO_COMPLETE = 0x89e; // medium confidence
export const FLAG_STEP_CHARGE = 0x862; // paired with var 0x40C8 (full > 204)

// Vanilla pokeemerald GAME_STAT enum; the hack keeps the order but relocated the
// array to SB1+0xB50 and dropped the XOR.
export const GAME_STAT_NAMES = [
  "SAVED_GAME", "FIRST_HOF_PLAY_TIME", "STARTED_TRENDS", "PLANTED_BERRIES",
  "TRADED_BIKES", "STEPS", "GOT_INTERVIEWED", "TOTAL_BATTLES", "WILD_BATTLES",
  "TRAINER_BATTLES", "ENTERED_HOF", "POKEMON_CAPTURES", "FISHING_CAPTURES",
  "HATCHED_EGGS", "EVOLVED_POKEMON", "USED_POKECENTER", "RESTED_AT_HOME",
  "ENTERED_SAFARI_ZONE", "USED_CUT", "USED_ROCK_SMASH", "MOVED_SECRET_BASE",
  "POKEMON_TRADES", "UNKNOWN_22", "LINK_BATTLE_WINS", "LINK_BATTLE_LOSSES",
  "LINK_BATTLE_DRAWS", "USED_SPLASH", "USED_STRUGGLE", "SLOT_JACKPOTS",
  "CONSECUTIVE_ROULETTE_WINS", "ENTERED_BATTLE_TOWER", "UNKNOWN_31",
  "BATTLE_TOWER_BEST_STREAK", "POKEBLOCKS", "POKEBLOCKS_WITH_FRIENDS",
  "WON_LINK_CONTEST", "ENTERED_CONTEST", "WON_CONTEST", "SHOPPED",
  "USED_ITEMFINDER", "GOT_RAINED_ON", "CHECKED_POKEDEX", "RECEIVED_RIBBONS",
  "JUMPED_DOWN_LEDGES", "WATCHED_TV", "CHECKED_CLOCK", "WON_POKEMON_LOTTERY",
  "USED_DAYCARE", "RODE_CABLE_CAR", "ENTERED_HOT_SPRINGS",
  "NUM_UNION_ROOM_BATTLES", "PLAYED_BERRY_CRUSH",
];

// Story counter var 0x405D tracks the Lavender/Celadon Rocket arc.
export const VAR_STORY_ROCKET = 0x405d;
export const STORY_ROCKET_LABELS = {
  0: "not started",
  1: "rival beaten in Pokemon Tower",
  2: "Lavender grunt cutscene seen",
  3: "later beat",
};

// Player avatar decoding (fully vanilla ObjectEvent layout): graphicsId @+5,
// localId @+8 (player 0xFF; 0xFE = the Yellow-style FOLLOWER object), hidden/
// in-ball = byte +1 bit5, currentCoords s16 x,y @+0x10 (map coords + 7),
// facingDirection = low nibble of byte @+0x18. PlayerAvatar.flags @+0: bit0
// ON_FOOT, bit1 MACH_BIKE, bit2 ACRO_BIKE, bit3 SURFING.
// The follower object does NOT carry its species; that comes from replicating
// GetFollowerMon (@0x080D516C): mode = (SB2+0x91 >> 5) & 3.
export const FOLLOWER_STARTER_SPECIES = 25;
export const FOLLOWER_STARTER_MET = [5, 0x58]; // metLevel, metLocation
export const FACING_NAMES = { 1: "down", 2: "up", 3: "left", 4: "right" };
export const AVATAR_BIKE_MASK = 0x06;
export const AVATAR_SURF_MASK = 0x08;
export const OBJ_EVENT_STRIDE = 0x24;

// Rival name string (SB2+0x6E2, after the challenge-options u16 at 0x6E0).
export const RIVAL_NAME_OFF = 0x6e2;
export const VAR_STEP_CHARGE = 0x40c8;

// Level-cap mechanism (fn @0x08168708): gameClear -> 100; challenge byte
// (SB2+0x6E0) bit2 clear -> 100; else table[badgeCount], +modifier[badgeCount]
// when (byte & 3) == 1.
export const CHALLENGE_OPTIONS_OFF = 0x6e0;
export const LEVEL_CAP_BY_BADGES = [14, 21, 24, 29, 43, 43, 47, 50, 63];
export const LEVEL_CAP_MODE1_MOD = [1, 1, 2, 2, 3, 3, 4, 4, 4];

export const NATURES = [
  "Hardy", "Lonely", "Brave", "Adamant", "Naughty",
  "Bold", "Docile", "Relaxed", "Impish", "Lax",
  "Timid", "Hasty", "Serious", "Jolly", "Naive",
  "Modest", "Mild", "Quiet", "Bashful", "Rash",
  "Calm", "Gentle", "Sassy", "Careful", "Quirky",
];

export const MAX_SPECIES = 411; // vanilla Gen 3 internal range
export const MAX_ITEM = 410; // hack's expanded item table is ~409 entries
export const MAX_MONEY = 999999;
export const MAX_COINS = 9999;
export const MAX_BAG_QTY = 999;

export const UNVERIFIED_SB1 =
  "offset unverified -- the hack reorganized SaveBlock1 internals " +
  "(see meta.offsets); refusing to emit values that would be silent " +
  "garbage. Provide research/hack-offsets.json to enable this section.";
