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

// --- Entity constructors -----------------------------------------------

// Guild (OWNED, design.md §15.4). `ventures` is nested here (rather than a
// separate top-level array keyed by ownerGuildId) because that's the shape
// invariants.js already reads (`g.ventures`) — see design.md §15.4's note
// that Venture.ownerGuildId is the same fact seen from the other end.
function createGuild({
  id,
  name = id,
  isBot = false,
  credits,
  fuelHoard,
  influence = 0,
  incomeRate = 0,
  ventures = [],
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
    guildReputation: 0,
    lifetimeProduced: {}, // good -> int; monotonic, only ever increases (§13)
    ventures: ventures.map(createVenture),
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
  productionRate = 0,
  inputStockpiles = {},
  outputStockpile = 0,
}) {
  if (id === undefined) throw new Error('createVenture: id is required');
  if (ownerGuildId === undefined) throw new Error('createVenture: ownerGuildId is required');
  if (type === undefined) throw new Error('createVenture: type is required');

  return {
    id,
    ownerGuildId,
    type,
    productionRate,
    inputStockpiles: { ...inputStockpiles },
    outputStockpile,
    // §15.2: "every mutation records its tick." null until tick.js's
    // stepProduction first touches this venture -- there's been no
    // mutation to record yet at construction time.
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
  if (!Array.isArray(scenario.guilds) || scenario.guilds.length === 0) {
    throw new Error('createState: scenario.guilds must be a non-empty array');
  }

  const guilds = scenario.guilds.map(createGuild);
  const reserve = createReserve(scenario.reserve);
  const syndicate = createSyndicate(scenario.syndicate);

  const state = {
    tick: 0,
    guilds,
    reserve,
    syndicate,
    shipments: [], // IN-FLIGHT: empty until routes exist (walking skeleton has none)
    audit: {
      totalProduced: sumFuelHoards(guilds) + reserve.reserveLevel,
      totalConsumed: 0,
      expectedCreditTotal: sumCredits(guilds) + syndicate.ledger,
    },
  };

  return state;
}

module.exports = {
  createGuild,
  createVenture,
  createReserve,
  createSyndicate,
  createState,
};
