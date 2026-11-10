'use strict';

// craft-maintenance.js — spacecraft WEAR and the guild's craft MAINTENANCE POOL (roadmap 2.6 maintenance,
// slice 3; docs/maintenance.md §2 / §3). The craft sibling of sim/droids.js's decay + upkeep: the same
// whole-wear-unit arithmetic, the same lowest-condition-first triage, the same "wear is ambient" rule.
//
//   WEAR (§2) — a craft wears ONLY on a tick it is flying (stored status `inTransit`), one tick of wear per
//   tick of flight, at its class's maintained or unmaintained rate. Idle, docked (`loading`) or anything else:
//   no wear. Clamped at 0 — a craft at 0 keeps flying and stays at 0 until deep maintenance (sim/deep-maintenance.js).
//
//   THE POOL (§3) — guild-wide credits held aside for maintenance. Every tick, the guild's flying craft are
//   ordered lowest condition first (id tie-break) and each is COVERED if the pool still holds its class rate:
//   the rate is paid to the Syndicate ledger and the craft wears at the slow rate. A craft the pool cannot pay
//   for is skipped (wears fast) and the loop goes on. At each cycle boundary min(budget, credits) refills it.
//
// Condition changes nothing else (speed, fuel, capacity, dispatch are untouched) and nothing here moves GP,
// RP, the mean line, fuel, a licence or a fee (§5) — only craft condition and credits.
//
// THE STORED SHAPE (all omit-when-default, so a guild that never touches maintenance is byte-identical):
//   guild.craftMaintenance = { budget?, pool?, spentThisCycle?, spentLastCycle?, ranDryThisCycle? }
//     budget          — whole credits ≥ 0 moved into the pool at each cycle boundary (player-set, default 0);
//     pool            — whole credits ≥ 0 held for maintenance (counted in credit conservation, invariant 2);
//     spentThisCycle  — what the pool has paid out so far in the cycle running now;
//     spentLastCycle  — what it paid out over the whole previous cycle (the readout's figure);
//     ranDryThisCycle — `true` once this cycle's pool-ran-dry notice has been written (one per cycle at most).
//   Each key is omitted when 0 / false, and the object itself when it is empty.
//   vehicle.maintenanceCovered = true — this craft was covered on its most recent flight tick. Omitted otherwise.

const {
  LIGHT_TRANSPORT, MEDIUM_TRANSPORT, HEAVY_TRANSPORT, SPYCRAFT, VEHICLE_CLASSES,
} = require('./vehicles.js');
const { DEFAULT_WINDOW_N, TIER3_WINDOW_N, winStartFor } = require('./windows.js');
const { recordEvent, MAINTENANCE_POOL_DRY, CRAFT_REACHED_ZERO } = require('./events.js');

// A week of ticks — the 10,080-tick week (7 days × 1,440) the droid lives are written in, so both kinds of
// wear are measured against one week.
const WEEK_TICKS = TIER3_WINDOW_N;

// CRAFT_LIFE_TICKS — how many ticks of FLIGHT a NEW craft lasts, unmaintained and maintained. `[FIRST-CUT]`,
// docs/phase-1-tuning.md §"Maintenance" (RULED 09-11-26): light 8 / 16 weeks, medium 6 / 12, heavy 4 / 8,
// spycraft 1 / 2. Maintenance doubles every class's life (×2) — the same as halving its wear per tick.
const CRAFT_LIFE_TICKS = Object.freeze({
  [LIGHT_TRANSPORT]: Object.freeze({ unmaintained: 8 * WEEK_TICKS, maintained: 16 * WEEK_TICKS }),
  [MEDIUM_TRANSPORT]: Object.freeze({ unmaintained: 6 * WEEK_TICKS, maintained: 12 * WEEK_TICKS }),
  [HEAVY_TRANSPORT]: Object.freeze({ unmaintained: 4 * WEEK_TICKS, maintained: 8 * WEEK_TICKS }),
  [SPYCRAFT]: Object.freeze({ unmaintained: 1 * WEEK_TICKS, maintained: 2 * WEEK_TICKS }),
});

// CRAFT_MAINTENANCE_RATE — credits the pool pays for ONE tick of flight of ONE craft, by class. `[FIRST-CUT]`,
// docs/phase-1-tuning.md §"Maintenance": light 1 · medium 2 · heavy 5 · spycraft 10. Whole credits (§15.2).
const CRAFT_MAINTENANCE_RATE = Object.freeze({
  [LIGHT_TRANSPORT]: 1,
  [MEDIUM_TRANSPORT]: 2,
  [HEAVY_TRANSPORT]: 5,
  [SPYCRAFT]: 10,
});

// The default per-cycle budget (docs/phase-1-tuning.md §"Maintenance": 0 — maintenance is opt-in).
const CRAFT_MAINTENANCE_BUDGET_DEFAULT = 0;

// Every class must have a life and a rate — a class added to vehicles.js without one halts here, at load.
for (const cls of VEHICLE_CLASSES) {
  if (!CRAFT_LIFE_TICKS[cls] || CRAFT_MAINTENANCE_RATE[cls] === undefined) {
    throw new Error(`craft-maintenance: class ${cls} has no life or no maintenance rate`);
  }
  const rate = CRAFT_MAINTENANCE_RATE[cls];
  if (!Number.isSafeInteger(rate) || rate < 1) {
    throw new Error(`craft-maintenance: the ${cls} rate ${rate} must be a whole number of credits ≥ 1`);
  }
}

// THE WEAR SCALE — exactly droids.md §5's reason (sim/droids.js "WHY A WEAR SCALE"): subtracting 1/80,640
// from a float eighty thousand times does not land on exactly 0, so wear is counted in WHOLE units. A new
// craft holds CRAFT_WEAR_SCALE units; each tick of flight takes a whole number of them; the stored fraction is
// units ÷ CRAFT_WEAR_SCALE. The scale is the least common multiple of the eight lives (483,840 today) —
// COMPUTED here, never typed, so retuning a life retunes it.
function gcd(a, b) { return b === 0 ? a : gcd(b, a % b); }
const ALL_LIVES = Object.values(CRAFT_LIFE_TICKS).flatMap((l) => [l.unmaintained, l.maintained]);
const CRAFT_WEAR_SCALE = ALL_LIVES.reduce((acc, life) => (acc / gcd(acc, life)) * life, 1);

// craftWearPerTick(class, maintained) -> the whole wear units one tick of flight takes (SCALE ÷ life).
function craftWearPerTick(vehicleClass, maintained) {
  const life = CRAFT_LIFE_TICKS[vehicleClass];
  if (!life) throw new Error(`craftWearPerTick: unknown vehicle class ${JSON.stringify(vehicleClass)}`);
  return CRAFT_WEAR_SCALE / (maintained ? life.maintained : life.unmaintained);
}

// Load-time tripwire: every rate must be a whole number of units, or "lands on exactly 0" breaks.
for (const cls of VEHICLE_CLASSES) {
  for (const maintained of [false, true]) {
    const w = craftWearPerTick(cls, maintained);
    if (!Number.isSafeInteger(w) || w < 1) {
      throw new Error(`craft-maintenance: the ${cls}'s ${maintained ? 'maintained' : 'unmaintained'} wear ${w} units/tick is not a whole number ≥ 1 — CRAFT_WEAR_SCALE ${CRAFT_WEAR_SCALE} must divide every life`);
    }
  }
}

// conditionUnits(condition) -> the stored fraction as whole wear units. Exact for any value this code wrote;
// `Math.round` snaps a hand-set fraction (an operator spawn's 0.33) to the nearest unit — droids' rule.
function conditionUnits(condition) {
  return Math.round(condition * CRAFT_WEAR_SCALE);
}

// wornCondition(condition, wear) -> the condition after `wear` units, never below 0.
function wornCondition(condition, wear) {
  const units = conditionUnits(condition) - wear;
  return units <= 0 ? 0 : units / CRAFT_WEAR_SCALE;
}

// flightTicksLeft(vehicle, maintained) -> whole ticks of flight until the craft reaches 0 at one rate
// (rounded up: a last part-tick of units still takes a tick to wear off). 0 for a craft already at 0.
function flightTicksLeft(vehicle, maintained) {
  return Math.ceil(conditionUnits(vehicle.maintenanceCondition) / craftWearPerTick(vehicle.class, maintained));
}

function isFlying(vehicle) {
  return vehicle.status === 'inTransit';
}

// ── the pool record ───────────────────────────────────────────────────────────────────────────────────────

const POOL_NUMBER_KEYS = Object.freeze(['budget', 'pool', 'spentThisCycle', 'spentLastCycle']);

// readCraftMaintenance(guild) -> every field with its default filled in. A fresh object; mutating it changes
// nothing until it is written back.
function readCraftMaintenance(guild) {
  const r = guild.craftMaintenance || {};
  return {
    budget: r.budget || CRAFT_MAINTENANCE_BUDGET_DEFAULT,
    pool: r.pool || 0,
    spentThisCycle: r.spentThisCycle || 0,
    spentLastCycle: r.spentLastCycle || 0,
    ranDryThisCycle: r.ranDryThisCycle === true,
  };
}

// writeCraftMaintenance(guild, rec) — MUTATES `guild`: the ONE writer of the record's shape. Zero numbers and a
// false flag are left out, and the object itself is left out once empty, so set-then-clear is byte-identical
// to never-set. A fresh object every time, so nothing outside can hold a reference to the stored one.
function writeCraftMaintenance(guild, rec) {
  const out = {};
  for (const key of POOL_NUMBER_KEYS) if (rec[key] !== 0) out[key] = rec[key];
  if (rec.ranDryThisCycle) out.ranDryThisCycle = true;
  if (Object.keys(out).length > 0) guild.craftMaintenance = out;
  else delete guild.craftMaintenance;
}

// setCraftMaintenanceBudget(guild, budget) — the budget action's mutation. The caller checked `budget`.
function setCraftMaintenanceBudget(guild, budget) {
  const rec = readCraftMaintenance(guild);
  rec.budget = budget;
  writeCraftMaintenance(guild, rec);
}

// topUpCraftMaintenancePool(guild, amount) — the top-up action's mutation: `amount` credits move from the
// guild's credits into its pool at once. Internal to the guild (both count in invariant 2), so the Syndicate
// ledger and the expected credit total do not move. The caller checked 1 ≤ amount ≤ credits.
function topUpCraftMaintenancePool(guild, amount) {
  const rec = readCraftMaintenance(guild);
  guild.credits -= amount;
  rec.pool += amount;
  writeCraftMaintenance(guild, rec);
}

// cycleTicksOf(state) / nextRefillTickFor(state) — the cycle is the commitment cycle: `state.windowN` ticks
// (1,440 in a real galaxy), on the galaxy's day-anchored cadence (docs/cycle-and-calendar.md §2).
function cycleTicksOf(state) {
  return state.windowN == null ? DEFAULT_WINDOW_N : state.windowN;
}
function nextRefillTickFor(state) {
  const N = cycleTicksOf(state);
  const anchor = state.dayAnchorTick == null ? 0 : state.dayAnchorTick;
  // The cycle holding the NEXT tick to run ends on its last tick — the boundary the refill lands on.
  return winStartFor(state.tick + 1, N, anchor) + N - 1;
}

// ── the per-tick step ─────────────────────────────────────────────────────────────────────────────────────

// byConditionThenId — the drain's TOTAL order (invariant 9): fewest units first, then id.
function byConditionThenId(a, b) {
  return (conditionUnits(a.maintenanceCondition) - conditionUnits(b.maintenanceCondition))
    || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

// stepCraftMaintenance(state, guild, tick, isCycleBoundary) — MUTATES `state` and `guild`. Run once per guild
// per tick, from sim/tick.js stepVehicleArrivals, BEFORE that tick's arrivals land. `tick` is the tick being
// built (state.tick + 1).
//
// WHICH TICKS A LEG OWNS (docs/maintenance.md §2 AS-BUILT). A leg dispatched with departureTick d and
// arrivalTick a flies ticks d+1 … a: the craft is `inTransit` when tick d+1 starts, and the arrival step lands
// it during tick a. Running here, BEFORE the landing, means the arrival tick a is charged and the departure
// tick d is not (it belonged to the berth) — exactly a − d = L ticks. A routed craft's next leg departs on
// tick a and owns a+1 …, so back-to-back legs never share or skip a tick, and a dock pause (`loading`, then
// `idle`) between them is never charged.
//
// In order:
//   1. DRAIN — every flying craft above 0, lowest condition first (id tie-break), is covered if the pool holds
//      its class rate (paid), else skipped (skip-and-continue). A craft AT 0 is EXCLUDED: never charged
//      (RULED 10-11-26 — maintenance cannot slow a craft with nothing left to lose).
//   2. WEAR — every flying craft takes one tick of wear at its rate: maintained if covered, unmaintained if not.
//      Not re-stamped (`updatedAtTick` untouched): wear is ambient, as droids.
//      The tick a craft's condition first reaches 0, a `craft_reached_zero` notice (slice 4).
//   3. THE NOTICE — the first tick in a cycle a craft above 0 went uncovered, one `maintenance_pool_dry`.
//   4. BOUNDARY (the cycle's last tick only, AFTER the drain): spentThisCycle rolls into spentLastCycle, then
//      the refill moves min(budget, credits) into the pool (never from credits below 0).
// A guild with no flying craft and no pool record does nothing at all (the byte-identical no-op).
function stepCraftMaintenance(state, guild, tick, isCycleBoundary) {
  const vehicles = guild.vehicles || [];
  const flying = vehicles.filter(isFlying);
  // The covered flag describes the most recent flight tick, so a craft not flying keeps none.
  for (const v of vehicles) if (!isFlying(v)) delete v.maintenanceCovered;
  if (flying.length === 0 && guild.craftMaintenance === undefined) return;

  const rec = readCraftMaintenance(guild);
  const poolBefore = rec.pool;
  // "Funding maintenance this cycle" — a budget, or a pool that held credits at some point in it. Only such a
  // guild can be told its pool RAN DRY; a guild that never opted in is simply unmaintained (§3 "Opt-in").
  const funding = rec.budget > 0 || rec.pool > 0 || rec.spentThisCycle > 0;

  // 1. DRAIN.
  let paid = 0;
  const uncoveredIds = [];
  for (const v of [...flying].sort(byConditionThenId)) {
    const rate = CRAFT_MAINTENANCE_RATE[v.class];
    if (conditionUnits(v.maintenanceCondition) > 0 && rec.pool >= rate) {
      rec.pool -= rate;
      paid += rate;
      v.maintenanceCovered = true;
    } else {
      if (conditionUnits(v.maintenanceCondition) > 0) uncoveredIds.push(v.id);
      delete v.maintenanceCovered;
    }
  }
  // The paid credits leave the guild's pool for the Syndicate ledger — the one sanctioned transfer; the
  // credit total (guild credits + pools + ledger) does not move.
  state.syndicate.ledger += paid;

  // Tripwire: the pool fell by exactly what the covered craft cost, and never below 0.
  const covered = flying.filter((v) => v.maintenanceCovered === true);
  const owed = covered.reduce((sum, v) => sum + CRAFT_MAINTENANCE_RATE[v.class], 0);
  if (poolBefore - rec.pool !== owed || paid !== owed || rec.pool < 0) {
    throw new Error(`stepCraftMaintenance: guild ${guild.id} at tick ${tick}: pool ${poolBefore} → ${rec.pool}, paid ${paid}, for covered craft costing ${owed}`);
  }
  rec.spentThisCycle += paid;

  // 2. WEAR.
  for (const v of flying) {
    const before = v.maintenanceCondition;
    v.maintenanceCondition = wornCondition(before, craftWearPerTick(v.class, v.maintenanceCovered === true));
    // Tripwire: wear only goes down, and a craft at 0 stays at 0.
    if (!(v.maintenanceCondition < before || (before === 0 && v.maintenanceCondition === 0))) {
      throw new Error(`stepCraftMaintenance: vehicle ${v.id} at tick ${tick} went from condition ${before} to ${v.maintenanceCondition} — wear must only go down`);
    }
    // REACHED 0% (maintenance slice 4, docs/event-log.md §19) — on the tick the condition FIRST hits 0. A craft
    // already at 0 does not cross again; only finishing deep maintenance raises it, so this is once per crossing.
    if (before > 0 && v.maintenanceCondition === 0) {
      recordEvent(guild, tick, CRAFT_REACHED_ZERO, { craftId: v.id, craftClass: v.class });
    }
  }

  // 3. THE NOTICE — at most one a cycle.
  if (funding && uncoveredIds.length > 0 && !rec.ranDryThisCycle) {
    rec.ranDryThisCycle = true;
    recordEvent(guild, tick, MAINTENANCE_POOL_DRY, {
      pool: rec.pool,
      vehicleIds: uncoveredIds.sort(),
      nextRefillTick: nextRefillTickFor(state), // state.tick is still tick − 1 here
    });
  }

  // 4. BOUNDARY — roll, then refill.
  if (isCycleBoundary) {
    rec.spentLastCycle = rec.spentThisCycle;
    rec.spentThisCycle = 0;
    rec.ranDryThisCycle = false;
    // Credits may be negative (a breach fee can drive them there), so the refill is clamped at 0 both ways.
    const refill = Math.max(0, Math.min(rec.budget, guild.credits));
    guild.credits -= refill;
    rec.pool += refill;
    if (refill > 0 && guild.credits < 0) {
      throw new Error(`stepCraftMaintenance: guild ${guild.id} at tick ${tick}: the refill of ${refill} took credits to ${guild.credits}`);
    }
  }
  writeCraftMaintenance(guild, rec);
}

// ── the readout (snapshot) ────────────────────────────────────────────────────────────────────────────────

// craftMaintenanceReadout(state, guild) -> the guild row's `craftMaintenance` block, or null when the guild has
// no craft and no pool record (so a craft-less snapshot is byte-identical). Every number engine-derived:
//   pool, budget, spentLastCycle — the stored figures (0 when absent);
//   ceiling — Σ over ALL the guild's craft of rate × the cycle's ticks: every craft flying the whole cycle;
//   nextRefillTick — the tick the next refill lands on (the current cycle's last tick).
function craftMaintenanceReadout(state, guild) {
  const vehicles = guild.vehicles || [];
  if (vehicles.length === 0 && guild.craftMaintenance === undefined) return null;
  const rec = readCraftMaintenance(guild);
  const N = cycleTicksOf(state);
  return {
    pool: rec.pool,
    budget: rec.budget,
    ceiling: vehicles.reduce((sum, v) => sum + CRAFT_MAINTENANCE_RATE[v.class] * N, 0),
    spentLastCycle: rec.spentLastCycle,
    nextRefillTick: nextRefillTickFor(state),
  };
}

// vehicleMaintenanceReadout(vehicle) -> the vehicle row's `craftMaintenance` block: ticks of flight left to 0%
// at each rate, and — only while it is flying — whether it was covered on its most recent flight tick
// (`false` until its first flight tick has been drained).
function vehicleMaintenanceReadout(vehicle) {
  return {
    flightTicksLeftMaintained: flightTicksLeft(vehicle, true),
    flightTicksLeftUnmaintained: flightTicksLeft(vehicle, false),
    ...(isFlying(vehicle) ? { covered: vehicle.maintenanceCovered === true } : {}),
  };
}

module.exports = {
  CRAFT_LIFE_TICKS,
  CRAFT_MAINTENANCE_RATE,
  CRAFT_MAINTENANCE_BUDGET_DEFAULT,
  CRAFT_WEAR_SCALE,
  craftWearPerTick,
  conditionUnits,
  wornCondition,
  flightTicksLeft,
  readCraftMaintenance,
  setCraftMaintenanceBudget,
  topUpCraftMaintenancePool,
  nextRefillTickFor,
  stepCraftMaintenance,
  craftMaintenanceReadout,
  vehicleMaintenanceReadout,
};
