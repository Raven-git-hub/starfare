'use strict';

// state.js — entity constructors, and createState(scenario): the one-time
// mold that builds tick-0 state. It runs ONCE, at the start of a run — never
// again during play. Every subsequent state comes from tick.js applying
// changes to the state this file built.
//
// WHAT THIS FILE DOES NOT DO: invent game-balance numbers. The walking
// skeleton's actual starting credits, fuel needs, production rates, etc. are
// a SCENARIO (design.md's "widened Phase 1" starting setup) — a separate,
// not-yet-built concern (see sim/README.md's planned scenarios/ folder).
// createState() below just assembles whatever scenario data it is given into
// a valid state object; it never supplies its own numbers. That keeps this
// file honest infrastructure, reusable by every scenario and every test.
//
// Shape produced matches what invariants.js already expects (see the comment
// block at the top of that file) and design.md §15.4 for full entity fields —
// this is a SUBSET of §15.4, just what the walking skeleton needs first.

const { computeGalacticSupply } = require('./supply.js');

// --- Entity constructors -----------------------------------------------

// Guild (OWNED, design.md §15.4). `ventures` and `vehicles` are nested here
// (rather than separate top-level arrays keyed by ownerGuildId) because
// that's the shape invariants.js already reads (`g.ventures`) — see
// design.md §15.4's note that Venture.ownerGuildId is the same fact seen
// from the other end. Vehicle follows the identical pattern.
function createGuild({
  id,
  name = id,
  isBot = false,
  credits,
  fuelHoard,
  influence = 0,
  incomeRate = 0,
  homeSystemId = null,
  homePlanetId = null,
  stockpiles = {},
  ventures = [],
  vehicles = [],
}) {
  if (id === undefined) throw new Error('createGuild: id is required');
  if (credits === undefined) throw new Error('createGuild: credits is required');
  if (fuelHoard === undefined) throw new Error('createGuild: fuelHoard is required');

  return {
    id,
    name,
    isBot,
    credits,
    fuelHoard,
    influence,
    incomeRate,
    // Home (design.md §13): the starter system a guild entered on, and its
    // Terran homeworld planet within it. A DENORMALISED pointer for convenience;
    // the OWNERSHIP source of truth is the guild's home claim in state.claims
    // (§15.2). invariants.js asserts the two agree and that the system is really
    // starter-eligible. null until seated — a guild built directly by a test
    // (bypassing the foundGuild action) may legitimately have no home.
    homeSystemId,
    homePlanetId,
    guildReputation: 0,
    // stockpiles: good -> int, the guild's holdings of each RAW resource
    // (design.md §15.4). Fuel is NOT here — it lives in fuelHoard, tracked by
    // the fuel-conservation law. Empty = holds nothing; keys are added as
    // production deposits goods. Legality of keys/values (known resource,
    // integer, non-negative) is enforced every tick by invariants.js, not here
    // — same division of labour as credits (this file assembles, invariants.js
    // judges). Copied so a caller's object can't alias into state.
    stockpiles: { ...stockpiles },
    lifetimeProduced: {}, // good -> int; monotonic, only ever increases (§13)
    ventures: ventures.map(createVenture),
    vehicles: vehicles.map(createVehicle),
  };
}

// Venture (OWNED, design.md §15.4). Fields not yet needed by the walking
// skeleton (licenceId, siteId, droneComplement, shareholders, automation,
// reputation) are left out rather than defaulted to a made-up value —
// add them when a real consumer needs them, not speculatively.
function createVenture({
  id,
  ownerGuildId,
  type,
  siteId = null,
  resourceType = null,
  productionRate = 0,
  inputStockpiles = {},
}) {
  if (id === undefined) throw new Error('createVenture: id is required');
  if (ownerGuildId === undefined) throw new Error('createVenture: ownerGuildId is required');
  if (type === undefined) throw new Error('createVenture: type is required');

  return {
    id,
    ownerGuildId,
    type,
    // siteId: the seed site this venture occupies — a resource node (mining) or
    // a settlement slot (refinery/factory/construction). Reference only: it
    // names a place in data/seed.json; the seed is never written back to. null
    // = not seated anywhere yet. Referential integrity (the id resolves to a
    // real site) and one-venture-per-site are enforced every tick by
    // invariants.js, which is also where "a mining venture's resourceType must
    // match its node's" lives — this file assembles, invariants.js judges.
    siteId,
    // resourceType: the RAW good a MINING venture extracts. Its output goes to
    // the owner guild's stockpile (tick.js stepProduction). This DRIVES
    // production; the seed node at siteId is the authority it is checked
    // against (see invariants.js). null for ventures that don't mine a single
    // named good (e.g. a future refinery/factory on a settlement slot).
    resourceType,
    productionRate,
    inputStockpiles: { ...inputStockpiles },
    // NOTE: the old typeless `outputStockpile` scalar was retired in the
    // resource-representation slice (02-08-26). Produced goods are typed and go
    // straight into the owner guild's `stockpiles` — one home, no drift. There
    // is no market or shipping yet, so "produced-but-unsold sits on the
    // venture" carries no behaviour; when selling/shipping needs that state, it
    // returns deliberately. Producer attribution is preserved via the guild's
    // lifetimeProduced counter (§13).
    // §15.2: "every mutation records its tick." null until tick.js's
    // stepProduction first touches this venture -- there's been no
    // mutation to record yet at construction time.
    updatedAtTick: null,
  };
}

// Vehicle (OWNED, design.md §15.4): "id, ownerGuildId, class, speed/capacity/
// defenseRating/fuelCostToRun, status." Only ONE class exists so far —
// `lightTransport` (design.md §4's simplest ship, no sensors/weapons) — so
// that's the default; anything else is a later addition, not invented here.
//
// speed/capacity/defenseRating/fuelCostToRun are REQUIRED, not defaulted —
// same discipline as createGuild's credits/fuelHoard. None of these numbers
// has a decided value anywhere in docs/phase-1-tuning.md yet; defaulting
// them to something plausible would be inventing a game-balance number
// silently (working practice #5). The caller must supply real numbers.
function createVehicle({
  id,
  ownerGuildId,
  class: vehicleClass = 'lightTransport',
  speed,
  capacity,
  defenseRating,
  fuelCostToRun,
  status = 'idle',
}) {
  if (id === undefined) throw new Error('createVehicle: id is required');
  if (ownerGuildId === undefined) throw new Error('createVehicle: ownerGuildId is required');
  if (speed === undefined) throw new Error('createVehicle: speed is required');
  if (capacity === undefined) throw new Error('createVehicle: capacity is required');
  if (defenseRating === undefined) throw new Error('createVehicle: defenseRating is required');
  if (fuelCostToRun === undefined) throw new Error('createVehicle: fuelCostToRun is required');

  return {
    id,
    ownerGuildId,
    class: vehicleClass,
    speed,
    capacity,
    defenseRating,
    fuelCostToRun,
    status,
    // §15.2: "every mutation records its tick." null until something (a
    // future consumption/movement step) first touches this vehicle.
    updatedAtTick: null,
  };
}

// Fuel Utility reserve (SHARED, design.md §15.4) — the subset the walking
// skeleton needs. `currentPrice`/`priceBand`/etc. are left out until the
// market step of tick.js needs them.
function createReserve({ reserveLevel }) {
  if (reserveLevel === undefined) throw new Error('createReserve: reserveLevel is required');
  return { reserveLevel };
}

// The Syndicate's credit-conservation balancing account (design.md invariant
// 2). May be negative — see invariants.js's non-negativity exemption for it.
function createSyndicate({ ledger }) {
  if (ledger === undefined) throw new Error('createSyndicate: ledger is required');
  return { ledger };
}

// --- Assembly -------------------------------------------------------------

// Sum every guild's fuelHoard.
function sumFuelHoards(guilds) {
  return guilds.reduce((sum, g) => sum + g.fuelHoard, 0);
}

// Sum every guild's credits.
function sumCredits(guilds) {
  return guilds.reduce((sum, g) => sum + g.credits, 0);
}

// createState(scenario) — the one-time bootstrap.
//
// scenario shape:
//   {
//     guilds:    [ <args to createGuild>, ... ],
//     reserve:   <args to createReserve>,
//     syndicate: <args to createSyndicate>,
//   }
//
// Returns a full tick-0 state, including a freshly-computed `audit` block —
// NOT supplied by the scenario, because the audit totals must always equal
// whatever the assembled state actually contains (invariants.js checks the
// live totals against them). At tick 0, before any production or trade has
// happened: everything currently held (hoards + reserve) is the "total
// produced so far" and nothing has been consumed yet; the sanctioned credit
// total is just what guilds and the ledger currently hold, since nothing has
// moved yet either. Computing this here, rather than trusting the scenario to
// get it right by hand, is what makes createState's OUTPUT always pass the
// invariants immediately — regardless of what numbers the scenario contains.
function createState(scenario) {
  if (!scenario) throw new Error('createState: scenario is required');
  if (!Array.isArray(scenario.guilds)) {
    throw new Error('createState: scenario.guilds must be an array');
  }
  // NOTE: an EMPTY roster is legal -- it is the guild-less zero-state a fresh
  // server boots into and waits in until the owner founds the first guild
  // (scenarios/zero-state.js, actions.js foundGuild).

  const guilds = scenario.guilds.map(createGuild);
  const reserve = createReserve(scenario.reserve);
  const syndicate = createSyndicate(scenario.syndicate);

  const state = {
    tick: 0,
    guilds,
    reserve,
    syndicate,
    // world is an opaque reference the engine carries inert (tick/intake/assert
    // read none of it). The zero-state now sets it to { seed: <number> } — the
    // galaxy IS the seed (§15.3), referenced, not copied — replacing the old
    // placeholder node graph. A test may pass any shape or none. Real hex
    // geography stays Phase 4 (§2, §15.4). claims (SHARED territory rows) DO
    // carry weight: they reference real seed landmarks, guarded by invariants.js.
    world: scenario.world || {},
    claims: Array.isArray(scenario.claims) ? scenario.claims : [],
    shipments: [], // IN-FLIGHT: empty until routes exist (walking skeleton has none)
    audit: {
      totalProduced: sumFuelHoards(guilds) + reserve.reserveLevel,
      totalConsumed: 0,
      expectedCreditTotal: sumCredits(guilds) + syndicate.ledger,
    },
    // Derived galactic-supply totals (the "resources section"). A CACHE for the
    // viewer/telemetry, re-derived and asserted every tick by invariants.js so
    // it can never silently drift from the guilds' actual stockpiles. Computed
    // here (not trusted from the scenario) so createState's output always
    // matches what it assembled — same discipline as `audit` above.
    galacticSupply: null, // set just below, once `state` is assembled
  };

  state.galacticSupply = computeGalacticSupply(state);

  return state;
}

module.exports = {
  createGuild,
  createVenture,
  createVehicle,
  createReserve,
  createSyndicate,
  createState,
};
