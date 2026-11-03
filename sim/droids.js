'use strict';

// droids.js — the droid vocabulary, its id scheme, and THE ONE droid mint (roadmap 2.6, droid engine
// slice 2; docs/droids.md §1).
//
// A droid is a production buff that will attach to a VENTURE (docs/droids.md §0). It is not a ground
// asset (miner / factory), not a vehicle and not an installation kit, so it lives in its own collection,
// `guild.droids`, beside `assets` / `ventures` / `vehicles`. One row per droid, because condition will be
// per-unit once decay lands.
//
// Slice 2 built the entity and the guild dockyard build: a finished `droid` build mints one idle,
// guild-source droid at the dockyard's system (sim/tick.js mintFinishedKind). Slice 3 adds the SYNDICATE
// buy (a flat tariff, sim/actions.js buyAssetFromSyndicate) and ASSIGNMENT (assignDroid / unassignDroid,
// licence-gated for a Syndicate droid, capped per venture). Slice 4 adds THE BOOST (`productionBoost`,
// below): a venture's WORKING droids raise its production, applied transiently by sim/production.js
// resolveProduction. Slice 5 (this file's last engine slice) adds DECAY, the weekly droid_components
// UPKEEP that slows it, and DESTRUCTION at zero (`decayDroidsIn`, `fundDroidUpkeep`, below; docs/droids.md §5).
//
// Like sim/assets.js, this file holds RULES and the mint. The row itself is built by `createDroid` in
// sim/state.js, beside the other entity constructors.

const { createDroid } = require('./state.js');
const { assetId } = require('./assets.js');
const { getStock, addStock } = require('./stock.js');
const { TIER3_WINDOW_N } = require('./windows.js');

// The bill kind a dockyard queue entry carries for a droid build. Spelled ONCE, here.
const DROID = 'droid';

// The two sources (docs/droids.md §3). Source is NOT a quality tier: it will govern durability, cost,
// upkeep and where a droid may be used, never the boost. A dockyard build mints 'guild'; a Syndicate buy
// (slice 3) mints 'syndicate'.
const DROID_SOURCE_GUILD = 'guild';
const DROID_SOURCE_SYNDICATE = 'syndicate';
const DROID_SOURCES = Object.freeze([DROID_SOURCE_GUILD, DROID_SOURCE_SYNDICATE]);

// SYNDICATE_DROID_TARIFF — the FLAT credit price of one Syndicate droid (docs/phase-1-tuning.md §Droids,
// pinned at 10,000 cr for droid engine slice 3, `[FIRST-CUT]`). Market-independent ON PURPOSE: the
// Syndicate droid is "a special institutional product", not a market good (docs/droids.md §3), so it is
// NOT the parts-priced, floor-baselined path every other Syndicate buy takes (sim/asset-recipes.js
// priceAssetForPurchase reads THIS for a droid instead). An integer, like every credit amount (§15.2).
const SYNDICATE_DROID_TARIFF = 10_000;

// DROID_CAP — the most droids ONE VENTURE may hold assigned (docs/phase-1-tuning.md §Droids, `[FIRST-CUT]`
// 20; docs/droids.md §1). A 21st assign is refused. SOURCE-BLIND: guild and Syndicate droids count alike.
// The boost curve below reads the same constant as its `CAP`, so it is spelled once, here.
const DROID_CAP = 20;

// THE BOOST CURVE (docs/droids.md §2; the numbers are docs/phase-1-tuning.md §Droids, `[FIRST-CUT]`):
//     boost(n) = BOOST_MAX × (n / CAP) ^ p
// A full complement (n = CAP) gives boost 1.0, i.e. production ×2. p slightly above 1 makes the curve
// mildly convex — the twentieth droid adds more than the first, so concentrating droids is rewarded.
const DROID_BOOST_MAX = 1.0;
const DROID_BOOST_P = 1.5;

// n can only be a whole number from 0 to CAP, so the 21 possible boosts are worked out ONCE, here, and
// production just looks one up. That keeps Math.pow out of the tick loop entirely: the same n always
// reads the same stored number, so the boost is deterministic by construction (invariant 9). n = 0 is
// written as an exact 0 — a droidless venture multiplies by exactly 1 and its bytes cannot move — and
// n = CAP is exactly BOOST_MAX (1 ^ p = 1).
const BOOST_TABLE = Object.freeze(Array.from({ length: DROID_CAP + 1 }, (_, n) => (
  n === 0 ? 0 : DROID_BOOST_MAX * Math.pow(n / DROID_CAP, DROID_BOOST_P)
)));

// productionBoost(n) -> the boost fraction for n WORKING droids on one venture (0 for none, 1.0 for a full
// complement). Production multiplies by (1 + boost). Anything but a whole number in [0, CAP] is a bug
// upstream — the cap gate and checkDroids keep a venture at or under CAP — so it throws rather than guess.
// SOURCE-BLIND: the caller counts guild and Syndicate droids alike.
function productionBoost(n) {
  if (!Number.isInteger(n) || n < 0 || n > DROID_CAP) {
    throw new Error(`productionBoost: working-droid count ${n} is not a whole number in [0, ${DROID_CAP}]`);
  }
  return BOOST_TABLE[n];
}

// isDroidWorking(droid) -> true when the droid is assigned to a venture AND still has condition left.
// Only a working droid boosts (docs/droids.md §2: "Working droids (condition > 0)"). Decay (slice 5)
// destroys a droid the tick it reaches 0, so in a running galaxy every assigned droid is working; the
// `condition > 0` test still guards a hand-built state.
function isDroidWorking(droid) {
  return droid.assignedToVentureId !== undefined && droid.condition > 0;
}

// workingDroidCounts(guild) -> a Map of ventureId -> how many WORKING droids staff it. Ventures with
// none are simply absent. Built in one pass so production can look up every venture's count cheaply.
function workingDroidCounts(guild) {
  const counts = new Map();
  for (const d of guild.droids || []) {
    if (isDroidWorking(d)) counts.set(d.assignedToVentureId, (counts.get(d.assignedToVentureId) || 0) + 1);
  }
  return counts;
}

// isDroidIdle(droid) -> true when no venture holds it. Idle/deployed is DERIVED from the one stored pointer
// (invariant 5): `assignedToVentureId` is present exactly while the droid is assigned, and absent otherwise.
function isDroidIdle(droid) {
  return droid.assignedToVentureId === undefined;
}

// assignedDroidCount(guild, ventureId) -> how many of the guild's droids are assigned to that venture —
// what the cap gate and the cap invariant both count. Counts every source (the cap is source-blind).
function assignedDroidCount(guild, ventureId) {
  return (guild.droids || []).filter((d) => d.assignedToVentureId === ventureId).length;
}

// unassign(droid, tick) -> MUTATES the droid back to idle, in the system it already sits in (a droid never
// moves on assignment — assignment is same-system). Both assignment fields go together, so a droid is never
// left half-assigned. The one place a droid is released: the unassignDroid apply and a venture's closure.
// Stamps `updatedAtTick` (§15.2: every mutation records its tick).
function unassign(droid, tick) {
  delete droid.assignedToVentureId;
  delete droid.deployedAtTick;
  // Coverage is for a DEPLOYED droid only (slice 5): an idle droid does not wear, so it is not maintained.
  // The week's components were spent at the boundary and are not refunded; redeployed, the droid wears at
  // the fast rate until the next boundary covers it — the same as any droid deployed mid-week.
  delete droid.maintained;
  droid.updatedAtTick = tick;
}

// releaseDroidsFrom(guild, ventureId) -> MUTATES every droid of the guild assigned to `ventureId` back to
// idle. Called by the ONE venture-removal path (sim/licence.js applyVentureClosure — teardown, forced
// closure, eviction, the operator lever), BEFORE the venture is spliced out. Without it a closed venture
// would leave droids pointing at nothing and `checkDroids` would halt the next tick. The design derives
// "deployed" from a venture referencing the droid (docs/droids.md §1), so a gone venture makes its droids
// idle by definition — this only keeps the stored pointer in step with that, exactly as a closed venture's
// asset "returns to idle" (sim/licence.js). Returns the number released (for a test or a notice).
function releaseDroidsFrom(guild, ventureId, tick) {
  let released = 0;
  for (const d of guild.droids || []) {
    if (d.assignedToVentureId === ventureId) {
      unassign(d, tick);
      released += 1;
    }
  }
  return released;
}

// ── DECAY & UPKEEP (droid engine slice 5; docs/droids.md §5, the numbers docs/phase-1-tuning.md §Droids) ──────
//
// A DEPLOYED droid wears out linearly; an idle one does not wear at all. Each week a system's
// `droid_components` stock pays to MAINTAIN its deployed droids, and a maintained droid wears half as fast.
// Maintenance only SLOWS the wear — nothing ever raises a droid's condition. At zero the droid is destroyed.

// The maintenance week: the same 10,080-tick week the Tier-3 contracts settle on (7 days × 1,440 ticks), on
// the same anchored cadence (sim/windows.js), so a galaxy has one week, not two.
const DROID_WEEK_TICKS = TIER3_WINDOW_N;

// The good maintenance burns. Spelled once, here.
const DROID_COMPONENTS = 'droid_components';

// DROID_LIFE_TICKS — how many ticks a NEW droid lasts, by source, uncovered (no maintenance) and covered
// (maintained every tick). `[FIRST-CUT]`, docs/phase-1-tuning.md §Droids: guild 4 weeks / 8 weeks, Syndicate
// 2 weeks / 4 weeks. Maintenance doubles the life, which is the same as halving the wear per tick.
const DROID_LIFE_TICKS = Object.freeze({
  [DROID_SOURCE_GUILD]: Object.freeze({ uncovered: 4 * DROID_WEEK_TICKS, covered: 8 * DROID_WEEK_TICKS }),
  [DROID_SOURCE_SYNDICATE]: Object.freeze({ uncovered: 2 * DROID_WEEK_TICKS, covered: 4 * DROID_WEEK_TICKS }),
});

// DROID_UPKEEP_PER_WEEK — how many droid_components keep ONE droid maintained for ONE week, by source.
// `[FIRST-CUT]`, docs/phase-1-tuning.md §Droids: 1 for a guild droid, 2 for a Syndicate droid (the red tape).
const DROID_UPKEEP_PER_WEEK = Object.freeze({ [DROID_SOURCE_GUILD]: 1, [DROID_SOURCE_SYNDICATE]: 2 });

// The default per-system floor maintenance never draws below (docs/phase-1-tuning.md §Droids: default 0).
const DROID_COMPONENT_RESERVE_DEFAULT = 0;

// WHY A "WEAR SCALE". Condition is stored as a fraction (1 = new), but subtracting 1/40,320 from a float
// forty thousand times does not land on exactly 0 — rounding error piles up, and "reaches zero on the
// ruled tick" would be off by one, or never quite reach 0 at all. So the arithmetic is done in WHOLE
// "wear units" instead: a new droid holds DROID_WEAR_SCALE units, each tick takes away a whole number of
// them, and the stored fraction is just units ÷ DROID_WEAR_SCALE. Whole numbers subtract exactly, so a
// droid hits exactly 0 on exactly the ruled tick, every run (invariant 9).
//
// The scale is not a tuning number: it is the smallest number every life divides into (their least common
// multiple — 80,640 at today's lives), worked out from DROID_LIFE_TICKS, so retuning a life retunes it.
function gcd(a, b) { return b === 0 ? a : gcd(b, a % b); }
const ALL_LIVES = Object.values(DROID_LIFE_TICKS).flatMap((l) => [l.uncovered, l.covered]);
const DROID_WEAR_SCALE = ALL_LIVES.reduce((acc, life) => (acc / gcd(acc, life)) * life, 1);

// wearPerTick(source, covered) -> the whole wear units one tick takes from a droid. Uncovered = SCALE ÷ the
// uncovered life, covered = SCALE ÷ the covered life — so a new droid runs out in exactly its life.
function wearPerTick(source, covered) {
  const life = DROID_LIFE_TICKS[source];
  if (!life) throw new Error(`wearPerTick: unknown droid source ${JSON.stringify(source)}`);
  return DROID_WEAR_SCALE / (covered ? life.covered : life.uncovered);
}

// Load-time tripwire: every wear rate must be a whole number of units, or the exact-zero promise above breaks.
for (const source of DROID_SOURCES) {
  for (const covered of [false, true]) {
    const w = wearPerTick(source, covered);
    if (!Number.isSafeInteger(w) || w < 1) {
      throw new Error(`droids: the ${source} droid's ${covered ? 'covered' : 'uncovered'} wear ${w} units/tick is not a whole number ≥ 1 — DROID_WEAR_SCALE ${DROID_WEAR_SCALE} must divide every life`);
    }
  }
}

// decayedCondition(condition, wear) -> the condition after taking `wear` units off it, never below 0.
// `Math.round` turns the stored fraction back into its whole units (exact for any value this code wrote).
// Because `wear` is at least 1 and the rounding moves by less than ½, the result is ALWAYS strictly lower
// than `condition` (or 0) — decay is monotonic even for a hand-built condition that is off the grid.
function decayedCondition(condition, wear) {
  const units = Math.round(condition * DROID_WEAR_SCALE) - wear;
  return units <= 0 ? 0 : units / DROID_WEAR_SCALE;
}

// isDroidMaintained(droid) -> is this droid covered by this week's upkeep? Stored as `maintained: true`,
// omitted otherwise, and only ever on a deployed droid (unassign clears it).
function isDroidMaintained(droid) {
  return droid.maintained === true;
}

// deployedDroidsIn(guild, systemId) -> the guild's DEPLOYED droids standing in that system, in stored order.
function deployedDroidsIn(guild, systemId) {
  return (guild.droids || []).filter((d) => !isDroidIdle(d) && d.systemId === systemId);
}

// droidComponentReserveFor(guild, systemId) -> the floor maintenance keeps in that system's droid_components
// stock. Stored per system in `guild.droidComponentReserve` (omitted when empty); absent means the default 0.
function droidComponentReserveFor(guild, systemId) {
  const map = guild.droidComponentReserve || {};
  return Object.prototype.hasOwnProperty.call(map, systemId) ? map[systemId] : DROID_COMPONENT_RESERVE_DEFAULT;
}

// weeklyUpkeepFor(droids) -> how many droid_components would cover all of `droids` for one week.
function weeklyUpkeepFor(droids) {
  return droids.reduce((sum, d) => sum + DROID_UPKEEP_PER_WEEK[d.source], 0);
}

// decayDroidsIn(guild, systemId) -> the droids DESTROYED this tick (removed rows), having MUTATED `guild`.
// Run once per tick per system (sim/tick.js stepProduction, right after that system's production — so a
// droid still boosts on the tick it wears out, and is gone before the next). For each deployed droid in the
// system: take one tick of wear (covered or uncovered); a droid that reaches 0 is removed from guild.droids.
//
// NOT re-stamped: wear is the tick's ambient process, not a discrete event, so `updatedAtTick` keeps marking
// the last mint / assign / unassign / upkeep. The destruction IS a discrete event — the caller records it.
// An idle droid is untouched, so a galaxy with no deployed droid changes nothing here at all.
function decayDroidsIn(guild, systemId) {
  const deployed = deployedDroidsIn(guild, systemId);
  if (deployed.length === 0) return [];
  const spent = [];
  for (const d of deployed) {
    const before = d.condition;
    d.condition = decayedCondition(before, wearPerTick(d.source, isDroidMaintained(d)));
    // Tripwire: decay must only ever go DOWN (docs/droids.md §5, monotonic). decayedCondition guarantees it;
    // this halts loudly if that ever stops being true rather than let a droid quietly heal.
    if (!(d.condition < before || before === 0)) {
      throw new Error(`decayDroidsIn: droid ${d.id} went from condition ${before} to ${d.condition} — decay must only go down`);
    }
    if (d.condition === 0) spent.push(d);
  }
  if (spent.length > 0) {
    const gone = new Set(spent);
    guild.droids = guild.droids.filter((d) => !gone.has(d));
    // Omit-when-empty, like createGuild: a guild whose last droid wore out carries no `droids` key. The
    // serial stays — it only climbs, so a spent droid's number is never handed out again (§15.4).
    if (guild.droids.length === 0) delete guild.droids;
  }
  return spent;
}

// fundDroidUpkeep(guild, systemId, tick) -> { drawn, covered, uncovered }, having MUTATED `guild`. Run at each
// WEEK boundary, per system, AFTER that tick's decay: it pays for the week that STARTS on the next tick.
//
// The droids are maintained from THEIR OWN system's droid_components stock only — goods are system-local, so
// one system's stock never maintains another system's droids. Only stock ABOVE the system's reserve floor is
// spent. Each deployed droid costs DROID_UPKEEP_PER_WEEK[source] (1 guild, 2 Syndicate). When the stock cannot
// cover them all, the LOWEST-condition droids are covered first (the ones closest to wearing out), ties broken
// by id so two runs always pick the same droids (invariant 9). A droid the remaining stock cannot pay for is
// skipped, and a cheaper droid after it may still be covered — so no component sits unused while a droid it
// could have paid for wears fast. (That skip rule is on the roadmap decision checklist.)
//
// Every deployed droid's coverage is SET here — `maintained: true`, or the key removed — and each is stamped
// `updatedAtTick` (a discrete, weekly mutation, §15.2). A droid deployed after this boundary has no
// `maintained` key, so it wears at the fast rate until the next boundary pays for it.
function fundDroidUpkeep(guild, systemId, tick) {
  const deployed = deployedDroidsIn(guild, systemId);
  if (deployed.length === 0) return { drawn: 0, covered: 0, uncovered: 0 };
  const order = [...deployed].sort((a, b) => (
    a.condition - b.condition || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  ));
  const reserve = droidComponentReserveFor(guild, systemId);
  const stockBefore = getStock(guild, systemId, DROID_COMPONENTS);
  let spendable = Math.max(0, stockBefore - reserve);
  let drawn = 0;
  let covered = 0;
  for (const d of order) {
    const cost = DROID_UPKEEP_PER_WEEK[d.source];
    if (spendable >= cost) {
      d.maintained = true;
      spendable -= cost;
      drawn += cost;
      covered += 1;
    } else {
      delete d.maintained;
    }
    d.updatedAtTick = tick;
  }
  if (drawn > 0) addStock(guild, systemId, DROID_COMPONENTS, -drawn);
  // Tripwires — the draw must be exactly what the covered droids cost, and must never dig below the floor.
  const stockAfter = getStock(guild, systemId, DROID_COMPONENTS);
  const paidFor = weeklyUpkeepFor(deployed.filter(isDroidMaintained));
  if (stockBefore - stockAfter !== drawn || drawn !== paidFor) {
    throw new Error(`fundDroidUpkeep: guild ${guild.id} system ${systemId} at tick ${tick}: drew ${drawn} ${DROID_COMPONENTS} (stock ${stockBefore} → ${stockAfter}) for droids costing ${paidFor}`);
  }
  if (drawn > 0 && stockAfter < reserve) {
    throw new Error(`fundDroidUpkeep: guild ${guild.id} system ${systemId} at tick ${tick}: upkeep left ${stockAfter} ${DROID_COMPONENTS}, below the reserve floor ${reserve}`);
  }
  return { drawn, covered, uncovered: deployed.length - covered };
}

// droidId(guildId, n) -> `asset_<guildId>_droid_NN`. The same shape as every other asset id
// (sim/assets.js assetId), so the id names its owner and its number the same way.
function droidId(guildId, n) {
  return assetId(guildId, DROID, n);
}

// nextDroidSerial(guild) -> one above the guild's stored `droidSerial` (absent/0 -> 1). The kitAssetSerial
// pattern (sim/assets.js nextKitAssetSerial): droids DO leave the collection (spent at end of life —
// decayDroidsIn, slice 5), so "the highest live number + 1" could hand out a spent droid's id again. A stored counter
// that only climbs cannot (design.md §15.4 "Ids never repeat"). A pure read — the caller bumps it.
function nextDroidSerial(guild) {
  return (guild.droidSerial || 0) + 1;
}

// mintDroid(guild, source, systemId, tick) -> the new idle droid, having MUTATED `guild`. THE ONE droid mint
// (docs/droids.md §3: "Both sources mint one idle droid row, source-stamped, through one helper"). Bumps
// the serial FIRST, so two mints in one tick get two different numbers. Throws on a duplicate id: the
// serial only climbs, so a hit means the counter itself has been corrupted — halt rather than share an id.
// The row is stamped `updatedAtTick: tick` (§15.2); a missing tick is a caller bug, so it throws.
function mintDroid(guild, source, systemId, tick) {
  if (!Number.isSafeInteger(tick) || tick < 0) {
    throw new Error(`mintDroid: guild ${guild.id} minted a droid without a valid tick (got ${tick}) — every mutation records its tick (§15.2)`);
  }
  const serial = nextDroidSerial(guild);
  guild.droidSerial = serial;
  const id = droidId(guild.id, serial);
  if (!Array.isArray(guild.droids)) guild.droids = [];
  if (guild.droids.some((d) => d.id === id)) {
    throw new Error(`mintDroid: guild ${guild.id} minted duplicate droid id ${id} — droidSerial corrupted`);
  }
  const droid = createDroid({ id, systemId, source, updatedAtTick: tick });
  guild.droids.push(droid);
  return droid;
}

module.exports = {
  DROID,
  DROID_SOURCE_GUILD,
  DROID_SOURCE_SYNDICATE,
  DROID_SOURCES,
  SYNDICATE_DROID_TARIFF,
  DROID_CAP,
  DROID_BOOST_MAX,
  DROID_BOOST_P,
  productionBoost,
  isDroidWorking,
  workingDroidCounts,
  isDroidIdle,
  assignedDroidCount,
  unassign,
  releaseDroidsFrom,
  droidId,
  nextDroidSerial,
  mintDroid,
  DROID_WEEK_TICKS,
  DROID_COMPONENTS,
  DROID_LIFE_TICKS,
  DROID_UPKEEP_PER_WEEK,
  DROID_COMPONENT_RESERVE_DEFAULT,
  DROID_WEAR_SCALE,
  wearPerTick,
  decayedCondition,
  isDroidMaintained,
  deployedDroidsIn,
  droidComponentReserveFor,
  weeklyUpkeepFor,
  decayDroidsIn,
  fundDroidUpkeep,
};
