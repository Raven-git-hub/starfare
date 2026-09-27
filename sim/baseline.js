'use strict';

// baseline.js — the FIXED DROIDLESS BASELINE OUTPUT per venture type
// (docs/licence-and-price-system.md Part 2 "Fixed output per venture TYPE").
//
// WHY it exists NOW, ahead of the licence slice: the price engine's capacity
// normaliser (sim/prices.js) needs a good's MAX POSSIBLE production — "Σ of the
// fixed droidless baseline outputs of every venture making the good" — not the
// current `productionRate`, which is a free per-venture dial a player can throttle
// to zero. If capacity read `productionRate`, throttling every mine to 0 would
// divide the level by zero and make a hoard infinitely valuable: the denominator
// has to be what the venture COULD make, which is a property of its TYPE.
//
// WHAT THIS FILE DELIBERATELY IS NOT (deferred): the `productionRate` →
// throttle-below / droids-above refactor. `productionRate` stays exactly what it
// is — the free per-venture rate the resolver runs at — and NOTHING in
// production.js reads these tables.
//
// WHO READS THE TABLES — three consumers, and the resolver is not one of them:
//   1. the price engine's capacity normaliser (sim/prices.js), the first consumer;
//   2. the licence: its fee and committed quantity are priced off the baseline at
//      signing (sim/actions.js, with the fee arithmetic in sim/licence.js), and the
//      snapshot's licence quotes read the same path (sim/snapshot.js) — for a CONTINUOUS
//      good. A timed Tier-3 good's licence reads its timer over the week instead
//      (`licenceBasisFor`, sim/licence.js — the Tier-3 settlement slice, 3a);
//   3. the establish path (sim/actions.js, 24-09-26): when an `establishVenture`
//      names no `productionRate`, the engine stamps the venture's baseline as its
//      rate (`baselineRateFor`), so a licence commits a share of what the venture
//      really makes (design.md §2 "A mine's yield IS its establish rate"). Read ONCE,
//      at establishment; from then on the venture runs off its own stored rate.
// `sim/production.js` imports only `producedGoodFor`, the venture → good IDENTITY
// below (since the factory-commitment slice, 28-08-26); it reads neither table.
//
// THE ONE EXCEPTION — TICKS_PER_UNIT (the Tier-3 timed-production slice). That table is
// not a baseline output: it is the Tier-3 production TIMER, and the resolver DOES read it
// (through `ticksPerUnitFor`), because a timed factory's pace is its timer, not a rate. It
// sits here beside the two baseline tables because it is the same kind of thing — a fixed
// per-type production fact that tuning edits in one file. The price engine reads it too, for
// the per-period capacity (sim/prices.js `capacityOutputFor`).
//
// [FIRST-CUT] EVERY number below is provisional and recorded in
// docs/phase-1-tuning.md; the tables are written out entry by entry so tuning is a
// one-file edit.
//   - MINES are differentiated by YIELD TIER (RULED 24-09-26, design.md §2 "Resource
//     Yield Tiers & the Homeworld Production Floor"; the numbers are copied from
//     phase-1-tuning.md "Resource yield tiers", which is where they are argued).
//     A mine's yield is a property of the RESOURCE, galaxy-wide — a mine has no tier.
//   - FACTORIES are still the uniform first cut, 5 batches/tick per recipe; the
//     per-recipe baselines are open on the decision checklist, not guessed here.
// A refinery's baseline is in BATCHES/tick; its output units are batches × the
// recipe's output qty. Every value in both tables must be a positive integer (a
// tripwire in tests/baseline.test.js): the engine stamps them onto new ventures as
// `productionRate`, and a mine deposits its rate as whole units with no carry.
// The homeworld production floor that these yields were derived to satisfy is its own
// tripwire, tests/homeworld-floor.test.js.

const {
  RAW_RESOURCES, PROCESSED_GOODS, TIER3_GOODS, DEUTERIUM,
  TIER3_PRICE_CLASS, SPECIALIST, UNCLASSIFIED,
} = require('./resources.js');
const { getRecipe, listRecipes } = require('./recipes.js');

// [FIRST-CUT] the uniform FACTORY baseline, batches/tick: every REFINERY_BASELINE
// entry below is set to it. Mines no longer share it (they are tiered, below).
const FIRST_CUT_REFINERY_BASELINE = 5;

// Mining ventures: baseline units/tick, keyed by the RAW resource mined. RULED 24-09-26
// by yield tier (design.md §2); the values are phase-1-tuning.md "Resource yield tiers"
// exactly — change them THERE first, then here.
const MINE_BASELINE = Object.freeze({
  // Common (abundant)
  titanium: 160,
  copper: 100,
  lead: 100,
  silica: 200,
  nitrogen: 300,
  helium: 100,
  carbon_products: 300,
  polymers: 300,
  // Uncommon — lithium is ruled Uncommon, not Rare: Terran-only, and every battery needs it
  ammonia: 50,
  xenon: 50,
  silver: 50,
  gold: 50,
  tungsten: 50,
  lithium: 50,
  // Rare
  neodymium: 10,
  palladium: 10,
  // Fuel sits OUTSIDE the tiers: its supply is governed by the fuel economy (§1.4), so
  // it keeps the old uniform 5.
  deuterium: 5,
});

// Refining/manufacturing ventures: baseline BATCHES/tick, keyed by recipeId. Both the
// Tier-2 refines and (as of 2.1a) the 25 Tier-3 module manufactures sit here at the one
// uniform first-cut factory baseline, FIRST_CUT_REFINERY_BASELINE (= 5) — a module is quoted and
// its capacity summed by the same path as a processed good (docs/phase-1-tuning.md).
const REFINERY_BASELINE = Object.freeze({
  battery_cells: 5,
  carbon_fiber_weave: 5,
  composite_resin: 5,
  conductive_material: 5,
  heat_resistant_alloy: 5,
  luminite_glass: 5,
  magnetic_assemblies: 5,
  nanotube_cable: 5,
  radiation_shielding: 5,
  refrigerant_fluid: 5,
  silicon_wafer: 5,
  titanium_alloy: 5,
  // Tier-3 modules (recipeId === module good id), alphabetical, all at FIRST_CUT_REFINERY_BASELINE.
  cargo_handling_system: 5,
  cargo_module: 5,
  chassis: 5,
  claim_beacon: 5,
  comms_array: 5,
  control_module: 5,
  deep_scan_mast: 5,
  defence_system: 5,
  drive_module: 5,
  droid_components: 5,
  extraction_head: 5,
  fabrication_line: 5,
  fuel_tank: 5,
  habitation_module: 5,
  heavy_reactor_engine: 5,
  hull_plating: 5,
  interdiction_projector: 5,
  life_support_module: 5,
  medium_reactor_engine: 5,
  photovoltaic_array: 5,
  power_cells: 5,
  reactor_housing: 5,
  sensor_suite: 5,
  small_reactor_engine: 5,
  stealth_module: 5,
});

// ── TIER-3 TIMED PRODUCTION: TICKS PER UNIT (RULED 27-09-26, docs/tier3-timed-production.md;
// the numbers are docs/phase-1-tuning.md "Tier-3 production timers" exactly) ─────────────────
//
// A Tier-3 factory does not run at a continuous rate like the tables above. It builds ONE WHOLE
// UNIT at a time: its full input set is taken when the unit starts, the unit takes this many
// ticks, and it lands in the stockpile at the end (sim/production.js). 1 tick = 1 minute, so
// 15 = a quarter hour and 2,880 = two days. Dearer parts are slower on purpose — the timer is
// what keeps a 20M part from being a 20M-per-tick printer (design.md §5).
//
// [FIRST-CUT] every value. Keyed the way the ruling states them: by SUB-TIER for the three
// uniform tiers, and by GOOD for each specialist (each specialist has its own timer, as it has
// its own price). A good's class comes from TIER3_PRICE_CLASS (sim/resources.js).
const TICKS_PER_UNIT = Object.freeze({
  '3-1': 15,                       // 15 min — bulk / dumb parts
  '3-2': 30,                       // 30 min — standard gear
  '3-3': 60,                       // 1 h    — complex systems
  extraction_head: 360,            // 6 h
  fabrication_line: 480,           // 8 h
  medium_reactor_engine: 720,      // 12 h
  interdiction_projector: 1440,    // 24 h
  stealth_module: 2880,            // 48 h
  heavy_reactor_engine: 2880,      // 48 h
  deep_scan_mast: 4320,            // 72 h
});

// ticksPerUnitFor(good) -> how many ticks one whole unit of `good` takes, or null when the good
// is NOT timed — which means it is produced CONTINUOUSLY, per tick, like every Tier-1 mine and
// Tier-2 refinery. This one function is the whole "timed or continuous?" question: the
// production resolver, the price engine's capacity and the invariants all ask it, so they can
// never disagree about a good (a good is all-timed or all-continuous — never both).
//
// NULL for the four UNCLASSIFIED modules (drive_module, droid_components, claim_beacon,
// habitation_module). The ruling makes every Tier-3 good timed, but their timer depends on the
// sub-tier they have not been given yet (the same open question that keeps them on the old
// uniform price band). Picking one would invent a number, so they stay CONTINUOUS — their
// status quo — until their sub-tier is ruled; then they become timed with no code change. This
// is on docs/roadmap.md's decision checklist.
function ticksPerUnitFor(good) {
  if (!Object.prototype.hasOwnProperty.call(TIER3_PRICE_CLASS, good)) return null; // not Tier 3
  const priceClass = TIER3_PRICE_CLASS[good];
  if (priceClass === UNCLASSIFIED) return null;
  const key = priceClass === SPECIALIST ? good : priceClass;
  return Object.prototype.hasOwnProperty.call(TICKS_PER_UNIT, key) ? TICKS_PER_UNIT[key] : null;
}

// LOAD-TIME TRIPWIRE: every CLASSIFIED Tier-3 good must resolve to a timer. A new specialist
// added to TIER3_PRICE_CLASS without a TICKS_PER_UNIT row would otherwise fall back to
// continuous production silently — the exact per-tick printer the timer exists to prevent. So
// it throws, naming the good, the moment this file is required (§15.5: fail loud).
for (const good of TIER3_GOODS) {
  if (TIER3_PRICE_CLASS[good] === UNCLASSIFIED) continue;
  if (ticksPerUnitFor(good) === null) {
    throw new Error(`baseline: Tier-3 good "${good}" (class ${JSON.stringify(TIER3_PRICE_CLASS[good])}) has no TICKS_PER_UNIT timer — add its row rather than let it produce continuously`);
  }
}

// producedGoodFor(venture) -> the good this venture's output lands as, or null when it
// produces nothing identifiable. A mine is identified by `resourceType`, a refinery by
// its recipe's OUTPUT good — a venture sets one XOR the other (§15.4).
//
// ONE DEFINITION of "what does this venture make", and that is the whole reason it is a
// named export rather than five inline reads. Five callers need it — the §5 commitment
// target (`sim/production.js`), the sale's equity split (`ownerFraction`,
// `sim/licence.js`), the licence intake (`sim/actions.js`) and the boundary fee charge
// (`sim/tick.js`), plus the profile REVIEW that flags a stale `pursue` entry — and they
// MUST agree: a factory whose commitment accrues under one key but is paid out, judged or
// reviewed under another is a licence that silently cannot be met.
// While commitment was mines-only every one of those sites could write `v.resourceType`
// and be right by accident; extending it to factory output is exactly the moment that
// stops being true, so the identity gets a home before it gets a second copy.
//
// Returns null for a dangling `recipeId` (which the occupancy invariant already halts
// on) or a future venture type that produces neither — the caller simply skips it.
function producedGoodFor(venture) {
  if (!venture) return null;
  if (venture.resourceType) return venture.resourceType;
  if (venture.recipeId) {
    const recipe = getRecipe(venture.recipeId);
    return recipe ? recipe.output.good : null;
  }
  return null;
}

// isLicensedDeuteriumMine(venture) -> true iff this venture is a deuterium mine that
// carries a deuterium licence (§1.4 "The Deuterium Cycle", fuel-supply-and-allocation.md).
//
// THE ONE PLACE the two consumers of the deuterium lever ask the question, so they can
// never disagree about which ventures it governs: the per-tick auto-sale (sim/tick.js,
// which redirects the mine's output to the Syndicate + the fuel pool instead of the
// stockpile) and the zero-GP exclusion (sim/points.js, since a licensed deuterium mine's
// output serves the Syndicate, not the guild, so it scores no size).
//
// The deuterium licence is a WINDOWLESS variant granted by `licenseDeuteriumMine`
// (sim/actions.js) — a `venture.deuteriumLicence` object, deliberately NOT the windowed
// `venture.licence` the fee/window/breach machinery reads (§1.4: the two paths are
// mutually exclusive). `resourceType === DEUTERIUM` is belt-and-braces: the action refuses
// to license anything but a deuterium mine, so a `deuteriumLicence` can only sit on one —
// but the predicate names its own precondition rather than trusting a field's mere presence.
function isLicensedDeuteriumMine(venture) {
  return !!(venture && venture.deuteriumLicence && venture.resourceType === DEUTERIUM);
}

// isDeuteriumMine(venture) -> true iff this venture is a deuterium mine, LICENSED OR NOT
// (§1.4 "The Deuterium Cycle", fuel-supply-and-allocation.md). The broader sibling of
// `isLicensedDeuteriumMine` above: it keys off the mined good alone, ignoring the licence.
//
// Two consumers ask it, and both apply to EVERY deuterium mine, not only the licensed one:
//   - GP (sim/points.js): §1.4 rules that an unlicensed deuterium mine is "idle to the
//     Syndicate — no GP, no RP", so the GP skip widens from the licensed predicate to this;
//   - the production fork (sim/tick.js): an unlicensed deuterium mine routes its raw output
//     to the guild-wide contraband store instead of a per-system stockpile (the B1 exemption,
//     slice 1a). The licensed branch is checked FIRST there, so this only ever catches the
//     unlicensed mine — but it names "any deuterium mine" honestly, keyed off the good.
function isDeuteriumMine(venture) {
  return !!(venture && venture.resourceType === DEUTERIUM);
}

// isIllegalDeuteriumRefinery(venture) -> true iff this venture is an illegal deuterium
// refinery (§1.4 "The illegal path, made concrete", fuel-supply-and-allocation.md — slice 1b).
//
// A refinery is a factory venture running the special 1:1 `deuterium → deuterium_fuel`
// conversion; there is no legal guild refinery (the Syndicate's legal conversion is the
// abstract pool mint), so a guild deuterium refinery is inherently the illegal path — hence
// no licence dimension in the predicate, just the `deuteriumRefinery` marker set at deploy
// (`establishDeuteriumRefinery`, sim/actions.js). It carries neither a `resourceType` nor a
// `recipeId`, so `producedGoodFor` returns null for it and the ordinary resolveProduction path
// skips it entirely; the conversion is its own guild-wide step (sim/tick.js).
//
// Two consumers ask it, both applying to every illegal refinery:
//   - the conversion step (sim/tick.js): each tick it draws min(guild.deuterium, its rate)
//     from the guild's raw store and mints that into the guild's contraband fuel store;
//   - the GP skip (sim/points.js): idle to the Syndicate, so zero GP (and no RP path reaches
//     it), like the deuterium mine.
function isIllegalDeuteriumRefinery(venture) {
  return !!(venture && venture.deuteriumRefinery);
}

// isDockyard(venture) -> true iff this venture is a Tier-4 build yard (docs/build-yard.md §2,
// roadmap 2.1b). The analogue of `isIllegalDeuteriumRefinery` above: a plain marker predicate,
// keyed off the `dockyard` boolean set at deploy (`establishDockyard`, sim/actions.js).
//
// A dockyard is a FACTORY venture (type 'refining') in construct mode — it carries neither a
// `resourceType` nor a `recipeId`, so `producedGoodFor` returns null and resolveProduction skips
// it entirely; its output (finished assets) is emitted by a dedicated guild-wide build step
// (sim/tick.js `buildDockyards`). It is INDEPENDENT of `isIllegalDeuteriumRefinery`, which keys
// off `deuteriumRefinery`: a venture is at most one of the two, and neither marker implies the
// other. Since 2.1b slice 2 the dockyard is a FULL Tier-4 venture in the mean-line economy: GP
// special-COUNTs it at Tier 4 (`isDockyard` → `TIER_WEIGHT[4]` = 500, sim/points.js) and it takes
// a held Tier-4 RP signing bump on establish (`signingBump` special-cased on `isDockyard`, 900,
// sim/licence.js). This predicate is the single keyed question both readers ask (docs/build-yard.md §5).
function isDockyard(venture) {
  return !!(venture && venture.dockyard);
}

// baselineOutputFor(venture) -> { good, units } | null
//   `good`  — the good this venture produces (`producedGoodFor`, above)
//   `units` — its fixed droidless baseline output of that good, in units/tick
// Returns null for a venture that produces nothing priceable (an unknown resource, a
// dangling recipeId — which the occupancy invariant is already halting on — or a future
// venture type with no entry), so the caller simply doesn't count it. The `good` half is
// DELEGATED, so this table and the identity above can never drift apart.
function baselineOutputFor(venture) {
  const good = producedGoodFor(venture);
  if (!good) return null;
  if (venture.resourceType) {
    const units = MINE_BASELINE[venture.resourceType];
    return units === undefined ? null : { good, units };
  }
  const batches = REFINERY_BASELINE[venture.recipeId];
  const recipe = getRecipe(venture.recipeId);
  if (batches === undefined || !recipe) return null;
  return { good, units: batches * recipe.output.qty };
}

// baselineRateFor(venture) -> the venture's droidless baseline in its OWN rate unit, or
// null when it has none. A mine's is MINE_BASELINE[resourceType] (units/tick); a factory's
// is REFINERY_BASELINE[recipeId] (BATCHES/tick) — the same unit `productionRate` is in.
//
// WHY a second reader beside `baselineOutputFor` above: that one answers in output UNITS
// (batches × the recipe's output qty), the unit the price engine and the licence fee need.
// A factory's `productionRate` is counted in batches, so stamping a factory from
// `baselineOutputFor` would run it at the wrong rate whenever a recipe makes more than one
// unit per batch. This is the reader for "what rate does a new venture run at", and the
// establish path (sim/actions.js) is its consumer (design.md §2 "A mine's yield IS its
// establish rate").
//
// Null (never a default number) for an unknown resource or recipe, or a venture that names
// neither, so the caller refuses rather than inventing a rate. `hasOwnProperty`, not a
// plain lookup, so a name like `constructor` can never read a prototype value as a rate.
function baselineRateFor(venture) {
  if (!venture) return null;
  if (venture.resourceType) {
    return Object.prototype.hasOwnProperty.call(MINE_BASELINE, venture.resourceType)
      ? MINE_BASELINE[venture.resourceType] : null;
  }
  if (venture.recipeId) {
    return Object.prototype.hasOwnProperty.call(REFINERY_BASELINE, venture.recipeId)
      ? REFINERY_BASELINE[venture.recipeId] : null;
  }
  return null;
}

// baselineUnitsForGood(good) -> the fixed droidless baseline output, in units/tick, of a
// venture that PRODUCES this good — or null when nothing in the engine can make it.
//
// The INVERSE of `baselineOutputFor` above, and it exists because a reader can want the
// number before any venture exists: the snapshot's per-good licence-fee quote
// (`feeQuote`, sim/snapshot.js) has to price a licence a player has not signed yet, on a
// site that may hold nothing. Answering that from the tables directly would be a SECOND
// definition of "what can a venture of this type make", free to drift from the one the
// licence path prices off — so this doesn't read the tables at all. It builds the minimal
// venture shape `baselineOutputFor` recognises (a mine's `resourceType`, a refinery's
// `recipeId`) and asks IT, then checks the good it answers about is the good asked for.
// One lookup path, so a quote and a signed licence cannot disagree.
//
// A processed good is resolved by finding the recipe whose OUTPUT is that good, rather
// than assuming the recipe is named after it (it is today — one recipe per processed
// good — but that is a convention, not a rule). If a good ever had TWO recipes, "the
// baseline of a venture making it" would have two answers and no ruling says which one
// prices a licence: this returns null (no quote) rather than pick, and that ambiguity is
// flagged on the roadmap instead of being decided here.
function baselineUnitsForGood(good) {
  const venture = producerShapeFor(good);
  if (!venture) return null;
  const baseline = baselineOutputFor(venture);
  // The identity check: if the shape we built produces something else, the assumption
  // behind it is wrong and no number here would be trustworthy.
  return baseline && baseline.good === good ? baseline.units : null;
}

// producerShapeFor(good) -> the minimal venture shape that PRODUCES `good` — a mine's
// `{ resourceType }` or a refinery's `{ recipeId }` — or null when nothing can make it (see
// refineryVentureFor below for the two-recipe case). Factored out of `baselineUnitsForGood`
// (unchanged behaviour) because the licence path now needs the same shape to price a quote
// for a good nobody has built yet (`licenceBasisForGood`, sim/licence.js): one shape, so the
// quote and a signed licence are priced off the same venture.
function producerShapeFor(good) {
  if (!good) return null;
  return Object.prototype.hasOwnProperty.call(MINE_BASELINE, good)
    ? { resourceType: good }
    : refineryVentureFor(good);
}

// refineryVentureFor(good) -> the minimal refining-venture shape that makes `good`, or
// null when no recipe outputs it (a raw good, fuel) or when more than one does (see
// above). Since 2.1a a Tier-3 module DOES have a recipe, so it resolves here like a
// processed good — it is no longer an example of the no-recipe case.
function refineryVentureFor(good) {
  const makers = listRecipes().filter((r) => r.output.good === good);
  return makers.length === 1 ? { recipeId: makers[0].id } : null;
}

// The drift guard's material: every raw resource and every recipe must have an
// entry, so adding a good/recipe without a baseline is a loud test failure rather
// than a good that silently prices off a zero capacity.
const BASELINE_KEYS = Object.freeze({
  mines: Object.freeze([...RAW_RESOURCES]),
  // recipeId === its output good: one per processed good (Tier 2) AND one per module
  // (Tier 3, 2.1a). Both must carry a baseline or the drift guard fails loudly.
  recipes: Object.freeze([...PROCESSED_GOODS, ...TIER3_GOODS]),
});

module.exports = {
  FIRST_CUT_REFINERY_BASELINE, MINE_BASELINE, REFINERY_BASELINE, BASELINE_KEYS,
  TICKS_PER_UNIT, ticksPerUnitFor,
  producedGoodFor, baselineOutputFor, baselineRateFor, baselineUnitsForGood, producerShapeFor,
  isLicensedDeuteriumMine, isDeuteriumMine, isIllegalDeuteriumRefinery, isDockyard,
};
