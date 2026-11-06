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
const { producedGoodFor, isLicensedDeuteriumMine } = require('./baseline.js');

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

// byDroidId(a, b) -> THE ONE droid-id order: the LEXICOGRAPHIC order of the id string (docs/droids.md §13.2,
// ruled 06-11-26). Every droid tie-break and every "lowest id" pick uses it — the §5 maintenance triage and
// auto-replace's refill — and it is the order the snapshot sorts droids in, which the client reads. One
// definition, so the engine and the client can never disagree about which droid is "lowest". Note it is string
// order, not number order: it matches mint order up to serial 99, and past that `droid_100` sorts before
// `droid_99`. That is the convention; the numeric alternative was considered and declined. Deterministic
// (invariant 9): ids are unique, so this is a total order.
function byDroidId(a, b) {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

// assignedDroidCount(guild, ventureId) -> how many of the guild's droids are assigned to that venture —
// what the cap gate and the cap invariant both count. Counts every source (the cap is source-blind).
function assignedDroidCount(guild, ventureId) {
  return (guild.droids || []).filter((d) => d.assignedToVentureId === ventureId).length;
}

// ventureIsLicensed(venture) -> does the venture hold EITHER licence a Syndicate droid accepts: the windowed
// `licence` (Tier-1/2/3), or the windowless `deuteriumLicence` of a licensed deuterium mine (sim/baseline.js
// isLicensedDeuteriumMine — the existing predicate, reused so the two can never disagree).
function ventureIsLicensed(venture) {
  return Boolean(venture.licence) || isLicensedDeuteriumMine(venture);
}

// assignDroidRefusal(guild, droid, venture) -> null when `droid` may be assigned to `venture` right now, else
// the reason it may not. THE ONE ASSIGN GATE (docs/droids.md §1/§4): the `assignDroid` action's validate calls
// it after its ownership checks, and auto-replace's refill (below) calls it for every droid it places — so the
// refill can never place a droid the player's own Deploy would be refused (docs/droids.md §13.2). The checks
// run in this order so the player learns WHICH way a request was wrong:
//   1. a PRODUCING venture — a droid's only job is the boost, and the boost multiplies an output good
//      (`producedGoodFor`, the engine's one definition of "what does this venture make");
//   2. the droid is IDLE — a droid staffs one venture at a time;
//   3. SAME SYSTEM — assignment is instant and moves nothing, so the droid must already stand there;
//   4. THE LICENCE GATE — a SYNDICATE droid staffs only a licensed venture (a guild droid any). Assign-time
//      only: a licence that lapses later leaves an assigned Syndicate droid where it is;
//   5. THE CAP — at most DROID_CAP assigned droids per venture, every source counted.
// A pure read: it mutates nothing.
function assignDroidRefusal(guild, droid, venture) {
  if (producedGoodFor(venture) == null) {
    return `venture ${venture.id} produces no good, so a droid there could boost nothing — a droid may be assigned only to a producing venture (a mine or a factory)`;
  }
  if (!isDroidIdle(droid)) {
    return `droid ${droid.id} is already assigned to venture ${JSON.stringify(droid.assignedToVentureId)} — unassign it first`;
  }
  if (droid.systemId !== venture.systemId) {
    return `droid ${droid.id} is in system ${JSON.stringify(droid.systemId)}, but venture ${venture.id} is in ${JSON.stringify(venture.systemId)} — a droid is assigned only within its own system`;
  }
  if (droid.source === DROID_SOURCE_SYNDICATE && !ventureIsLicensed(venture)) {
    return `droid ${droid.id} is a Syndicate droid and venture ${venture.id} is unlicensed — a Syndicate droid may be assigned only to a licensed venture (docs/droids.md §4)`;
  }
  const held = assignedDroidCount(guild, venture.id);
  if (held >= DROID_CAP) {
    return `venture ${venture.id} already holds ${held} droids, the cap of ${DROID_CAP} — unassign one first`;
  }
  return null;
}

// assignDroidTo(droid, ventureId, tick) -> MUTATES an idle droid onto a venture. THE ONE assign mutation: the
// `assignDroid` apply and auto-replace's refill both call it, AFTER assignDroidRefusal said yes. It records
// only WHICH venture and WHEN (§15.2) — it moves no credit, good or fuel, and it NEVER touches `condition`:
// a worn spare deploys still worn, because nothing in the game repairs a droid in place (docs/droids.md §5).
function assignDroidTo(droid, ventureId, tick) {
  droid.assignedToVentureId = ventureId;
  droid.deployedAtTick = tick;
  droid.updatedAtTick = tick;
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
    a.condition - b.condition || byDroidId(a, b)
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

// ── AUTO-REPLACE (droid client slice 2; docs/droids.md §13.2) ───────────────────────────────────────────────
//
// A venture with `autoReplace: true` refills, the SAME tick, a slot a droid vacated by WEARING OUT (decay's
// destroy-at-zero) — never a slot the player emptied or a closure released. The refill takes a spare the guild
// already has: an IDLE droid standing in the same system. It is free (nothing is minted, bought or spent) and
// it goes through the one assign gate and the one assign mutation above, so it can never do anything the
// player's own Deploy could not.

// isAutoReplaceOn(venture) -> is auto-replace switched on for this venture? Stored as `autoReplace: true`,
// omitted when off — so a galaxy that never switches it on carries no new key anywhere.
function isAutoReplaceOn(venture) {
  return venture.autoReplace === true;
}

// autoReplaceVacancies(guild, systemId, spent) -> the slots auto-replace must try to fill, as
// `[{ venture, source }]`: one per droid in `spent` (the droids decay just destroyed in this system) that
// staffed an auto-replace venture, carrying the SOURCE of the droid that died there. In venture order — the
// guild's `ventures` array, which is establishment order — so the fill below is deterministic (invariant 9).
// A pure read.
function autoReplaceVacancies(guild, systemId, spent) {
  const vacancies = [];
  for (const venture of guild.ventures || []) {
    if (venture.systemId !== systemId || !isAutoReplaceOn(venture)) continue;
    for (const d of spent) {
      if (d.assignedToVentureId === venture.id) vacancies.push({ venture, source: d.source });
    }
  }
  return vacancies;
}

// lowestAssignable(guild, systemId, source, venture) -> the lowest-id (byDroidId) IDLE droid of `source` in the system
// that the assign gate allows onto `venture`, or null. No preference for fresh over worn — strictly lowest id
// within the source (docs/droids.md §13.2).
function lowestAssignable(guild, systemId, source, venture) {
  const candidates = (guild.droids || [])
    .filter((d) => d.source === source && d.systemId === systemId && isDroidIdle(d))
    .sort(byDroidId);
  return candidates.find((d) => assignDroidRefusal(guild, d, venture) === null) || null;
}

// refillAutoReplaceVacancies(guild, systemId, spent, tick) -> the refills made, as `[{ droidId, ventureId }]`,
// having MUTATED `guild`. Run by sim/tick.js right after decay destroyed `spent` in this system (the same tick).
//
// THE SOURCE RULE is asymmetric (docs/droids.md §13.2):
//   - a SYNDICATE vacancy takes only a Syndicate spare; if there is none it stays empty — never a guild droid
//     (only the player spends a guild droid onto a new slot);
//   - a GUILD vacancy takes a guild spare, else FALLS BACK to a Syndicate spare, else stays empty.
// THE FILL is two passes over the vacancies, both in venture order:
//   pass 1 — every vacancy from its OWN source;
//   pass 2 — every guild vacancy still empty takes its Syndicate fallback.
// So when one thin buffer must serve several deaths the same tick, a guild fallback can never take a Syndicate
// spare that a genuine Syndicate vacancy needed. Each pick re-runs the assign gate against the guild as it is
// at that moment, so the licence rule and the cap hold refill by refill (a Syndicate vacancy on a venture whose
// licence has lapsed finds no allowed spare and stays empty — the §13.2 erosion).
//
// A guild with no auto-replace venture here makes no vacancies and changes nothing.
function refillAutoReplaceVacancies(guild, systemId, spent, tick) {
  const vacancies = autoReplaceVacancies(guild, systemId, spent);
  if (vacancies.length === 0) return [];
  const refills = [];
  const fill = (vacancy, source) => {
    const droid = lowestAssignable(guild, systemId, source, vacancy.venture);
    if (!droid) return false;
    assignDroidTo(droid, vacancy.venture.id, tick);
    refills.push({ droidId: droid.id, ventureId: vacancy.venture.id });
    return true;
  };
  // Pass 1 — each vacancy from its own source. Remember the ones left empty.
  const stillOpen = [];
  for (const vacancy of vacancies) {
    if (!fill(vacancy, vacancy.source)) stillOpen.push(vacancy);
  }
  // Pass 2 — only now may an empty GUILD vacancy fall back to a Syndicate spare. A Syndicate vacancy left
  // empty in pass 1 stays empty: it never takes a guild droid.
  for (const vacancy of stillOpen) {
    if (vacancy.source === DROID_SOURCE_GUILD) fill(vacancy, DROID_SOURCE_SYNDICATE);
  }
  // Tripwires — a refill only ever REPLACES a death, so it can never put more droids on a venture than the
  // deaths took away, and never past the cap. The gate already guarantees both; this halts loudly if not.
  if (refills.length > vacancies.length) {
    throw new Error(`refillAutoReplaceVacancies: guild ${guild.id} system ${systemId} at tick ${tick}: ${refills.length} refills for ${vacancies.length} vacancies`);
  }
  for (const { ventureId } of refills) {
    const n = assignedDroidCount(guild, ventureId);
    if (n > DROID_CAP) {
      throw new Error(`refillAutoReplaceVacancies: guild ${guild.id} venture ${ventureId} at tick ${tick} holds ${n} droids after a refill, over the cap of ${DROID_CAP}`);
    }
  }
  return refills;
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
  byDroidId,
  assignedDroidCount,
  ventureIsLicensed,
  assignDroidRefusal,
  assignDroidTo,
  unassign,
  releaseDroidsFrom,
  isAutoReplaceOn,
  autoReplaceVacancies,
  refillAutoReplaceVacancies,
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
