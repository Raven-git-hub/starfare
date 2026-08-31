'use strict';

const { createGuild, createVenture } = require('./state.js');
const { isStarterSystem, getTerranHomeworld, getSite } = require('./seed.js');
const { getRecipe } = require('./recipes.js');
const {
  EQUITY_CEILING, isValidEquityPct, COMMITMENT_FLOOR, WINDOW_DAYS_MIN, WINDOW_DAYS_MAX,
  isValidCommitmentPct, isValidWindowDays, licenceFee, commitmentUnitsFor, equityOf,
} = require('./licence.js');
const { producedGoodFor, baselineOutputFor } = require('./baseline.js');
const { postedPrice, PRICED_GOODS } = require('./prices.js');
const { DEFAULT_WINDOW_N } = require('./windows.js');
const { isStockpileGood, isFuel } = require('./resources.js');
const { setEntry } = require('./profile.js');
const { getStock, addStock } = require('./stock.js');
const { computeGalacticSupply } = require('./supply.js');
const { guildHolds } = require('./claims.js');
const { nearestWaystation, arrivalTickFor } = require('./transport.js');
const { GUILD_STARTING_FUEL } = require('./fuel.js');
const {
  STARTER_MINERS, STARTER_FACTORIES, starterAssetSpecs, assetKindForVentureType,
  deployedAssetIds,
} = require('./assets.js');

// actions.js — action constructors, and the validate-as-they-arrive intake
// discipline (design.md §15.6). This is the guard against the game's own
// named failure mode: "a guild with 100 credits gets three 'spend 80' orders
// all approved" if you validate a batch against one stale snapshot. The fix
// is sequential: validate each action against state-as-it-stands — start-of-
// batch PLUS every action already accepted earlier in this same batch — and
// apply it immediately if it passes. Contested claims resolve first-valid-
// wins under the same discipline (not exercised yet: no claims exist).
//
// SCOPE: the action types the walking skeleton + testbed need so far, each
// grounded in fields that already exist so it MEANS something without an
// economy.js/territory.js to lean on:
//   - paySyndicateFee   — credits move an OWNED balance -> the SHARED ledger
//                         (invariant 2 holds: none minted or destroyed).
//   - foundGuild        — a guild enters on a starter-eligible home (§13);
//                         starting credits are debited from the ledger, so
//                         nothing is minted, and it seats + claims the home. It
//                         also GRANTS the starter asset gift (§4, 30-08-26) —
//                         engine policy, not an action field.
//   - establishVenture  — seat a NEW venture on a real seed node so it produces
//                         on the next tick, OCCUPYING an idle asset of the
//                         matching kind. Three gates (§4): vacant node, idle
//                         asset in inventory, and the guild holds the system.
//   - setProductionProfile — store a guild's per-system Gate-1/Gate-3 policy.
//   - sellToSyndicate   — the guild sells stockpile goods to the Syndicate at the
//                         posted price (design.md §5 "SELL GOES LIVE", 29-08-26).
//                         The FIRST action that mutates a stockpile, and so the
//                         first that has to refresh the galactic-supply cache.
//   - buyFromSyndicate  — the mirror (design.md §6, "Syndicate Delivery — the BUY
//                         side", 29-08-26): the cash is debited NOW and the goods
//                         are SCHEDULED, arriving some ticks later. The first
//                         action to write the IN-FLIGHT layer (state.shipments);
//                         tick.js's stepArrivals is the half that lands it.
//   - setSyndicateCommitment / setWindowN — the THROWAWAY commitment-injection dev
//                         scaffold (design.md §15.4 "Scaffold 11-08-26", §5): they
//                         set the windowed-accrual placeholders the engine already
//                         reads (Venture.syndicateCommitment, state.windowN) so a
//                         test scenario can light the console's commitment bar and
//                         give a scripted bot real targets before the real Licence
//                         entity exists. Explicitly transitional — retired when the
//                         licence grant becomes syndicateCommitment's source.
// Every OTHER action design.md eventually needs (placing an order, setting a
// toll, casting a vote) waits for the module that would give it an effect —
// inventing them now would mean guessing at economy.js before it exists.

// --- Action constructor -----------------------------------------------

// A guild paying credits to the Syndicate (the shape of a toll, tariff, or
// fee — the specific occasion doesn't matter yet, only that credits move
// from an OWNED balance into the SHARED ledger).
function createPaySyndicateFeeAction({ guildId, amount }) {
  if (guildId === undefined) throw new Error('createPaySyndicateFeeAction: guildId is required');
  if (amount === undefined) throw new Error('createPaySyndicateFeeAction: amount is required');
  return { type: 'paySyndicateFee', guildId, amount };
}

// Founding a guild: the conservation-clean event by which a guild comes into
// being on a running galaxy -- the "owner creates their first guild" moment,
// and later any join. Starting credits are DEBITED from the Syndicate ledger
// (design.md §8: the ledger is the balancing account that funds guild credits),
// so nothing is minted and invariant 2 holds.
//
// FUEL-GENESIS IS NOW DECIDED (fuel Slice 1). This note used to read "starting
// fuelHoard is always 0 ... minting fuel into a hoard would need a fuel-genesis
// rule we have not decided". The rule is decided: a founding guild opens with
// GUILD_STARTING_FUEL (sim/fuel.js) in its hoard — the early-game STARTER FLOOR
// ruled in docs/fuel-economy.md §7, anchored on design.md §8's survival floor,
// which closes the no-fuel -> no-trade -> no-reputation trap a brand-new guild
// would otherwise be born into.
//
// Unlike credits, this fuel is MINTED, not moved: there is no fuel counterpart
// to the Syndicate ledger to debit (the reserve is a physical pool, not a
// balancing account), so genesis is honest about being genesis and pays for it
// in the audit — the apply below increments `audit.totalProduced` by exactly the
// grant, which is how invariant 1 balances from tick 0. It stays ENGINE POLICY,
// not an action field — exactly like the starter asset gift — so the action
// shape is unchanged and no caller can ask for a different hoard.
//
// homeSystemId (design.md §13, decided 03-08-26): every guild enters ON a
// starter-eligible system (one holding >=1 Terran planet), so it is REQUIRED.
// Founding claims that system for the guild and seats it on the system's Terran
// homeworld. The claim is the ownership source of truth; the guild's
// homeSystemId/homePlanetId are the denormalised pointer (invariants.js guards
// the match). The genesis home-claim deliberately does NOT grant the "+20 on
// claiming an uncontested system" earn bonus — that is for play actions, not
// setup — so a guild starts at exactly its passed influence.
function createFoundGuildAction({
  guildId, name, isBot = false, credits, influence = 0, incomeRate = 0, homeSystemId, ventures = [],
}) {
  if (guildId === undefined) throw new Error('createFoundGuildAction: guildId is required');
  if (credits === undefined) throw new Error('createFoundGuildAction: credits is required');
  if (homeSystemId === undefined) throw new Error('createFoundGuildAction: homeSystemId is required');
  return { type: 'foundGuild', guildId, name, isBot, credits, influence, incomeRate, homeSystemId, ventures };
}

// Establishing a venture: seating a NEW venture belonging to an existing guild
// onto a real seed site, so it starts producing on the next tick. Two kinds:
//   - MINING (`type: 'mining'`): on a resource NODE. `resourceType` must match
//     the node's good. Extracts `productionRate` units/tick.
//   - REFINING (`type: 'refining'`, 03-08-26): on a SETTLEMENT SLOT. `recipeId`
//     must be a known recipe (recipes.js). Runs up to `productionRate` batches/
//     tick, consuming the recipe's input good from and producing its output good
//     into the owner's stockpile (throttled by available input — tick.js).
// Each rule is validated up front, mirroring the occupancy invariant, so a bad
// request is refused cleanly rather than applied-then-halted. Deploying also has
// THREE gates (design.md §4, 30-08-26) — a vacant node, the NAMED idle asset of the
// matching kind in the guild's inventory, and the guild holding the node's system —
// and on success that named asset is OCCUPIED (the venture's `assetId` points at it).
// `assetId` is REQUIRED and the CALLER'S choice (31-08-26): which machine goes onto
// which site is a player decision, not the engine's tie-break, so the deploy names
// it and validation proves it is owned, idle and of the matching kind. (Founding is
// unaffected — a `foundGuild`'s inline ventures still draw from the starter pool that
// same founding mints, where there is no inventory for a caller to name.)
// `productionRate` is REQUIRED and operator-supplied — a testbed dial, since only
// Titanium's mining rate is ruled; the rest (and refinery throughput) are undecided.
// Establishing a venture moves no credits or fuel (no licence/site cost yet).
function createEstablishVentureAction({
  guildId, ventureId, type = 'mining', siteId, assetId, resourceType, recipeId, productionRate, equityPct,
}) {
  if (guildId === undefined) throw new Error('createEstablishVentureAction: guildId is required');
  if (ventureId === undefined) throw new Error('createEstablishVentureAction: ventureId is required');
  if (siteId === undefined) throw new Error('createEstablishVentureAction: siteId is required');
  if (assetId === undefined) throw new Error('createEstablishVentureAction: assetId is required');
  if (productionRate === undefined) throw new Error('createEstablishVentureAction: productionRate is required');
  // Type-specific required field: a mining venture names the good it extracts;
  // a refining venture names the recipe it runs.
  if (type === 'mining' && resourceType === undefined) throw new Error('createEstablishVentureAction: resourceType is required for a mining venture');
  if (type === 'refining' && recipeId === undefined) throw new Error('createEstablishVentureAction: recipeId is required for a refining venture');
  // `ventureType` (not `type`) in the action object, so it never collides with
  // the action's own discriminator `type: 'establishVenture'`.
  // equityPct (`o`, §5's equity lever) is OPTIONAL and omitted from the action when
  // not offered, so an establish call that says nothing about equity is byte-identical
  // to one made before this slice — the venture lands at 0 (no equity offered).
  return {
    type: 'establishVenture', guildId, ventureId, ventureType: type, siteId, assetId, resourceType, recipeId, productionRate,
    ...(equityPct === undefined ? {} : { equityPct }),
  };
}

// Setting a guild's System Production Profile: storing, for ONE (guildId,
// systemId), an optional per-good Gate-1 policy and/or optional per-venture
// Gate-3 throttles (§5, §15.4) — the standing policy stepProduction will read to
// route each good through the three gates. This slice only STORES it: no tick
// step reads the profile yet (that is slice 2a-ii), so applying this action is a
// behavioural no-op on production. Both `goods` and `throttles` are optional; an
// action may set one, the other, or both, and it MERGES into the guild's profile
// (per §15.4's sparse, standing-policy shape) rather than replacing it.
function createSetProductionProfileAction({ guildId, systemId, goods, throttles }) {
  if (guildId === undefined) throw new Error('createSetProductionProfileAction: guildId is required');
  if (systemId === undefined) throw new Error('createSetProductionProfileAction: systemId is required');
  return { type: 'setProductionProfile', guildId, systemId, goods, throttles };
}

// --- Commitment-injection dev scaffold (design.md §15.4 "Scaffold 11-08-26", §5;
// roadmap Phase 1 Stage 2). Two DELIBERATELY THROWAWAY dev-scaffold actions that
// set the windowed-accrual placeholders at runtime on the live in-memory server —
// so a test scenario can light the console's commitment bar and give a scripted
// bot real targets BEFORE the real Licence entity exists. They only write existing
// state the windowed engine already reads (Venture.syndicateCommitment, state.
// windowN); NO engine/resolver/snapshot-schema change, NO fee, NO credits (breach
// stays status-only). When the real Licence grant lands it becomes
// syndicateCommitment's source and these setters retire.

// setSyndicateCommitment: write ONE venture's per-tick committed quantity — the
// venture field the resolver sums into the per-good aggregate target Q (§5). An
// integer ≥ 0; 0 clears back to unlicensed. It does NOT set committedFromTick, so a
// scaffold-committed venture stays FULL-WINDOW by design: windowFraction reads a
// missing stamp as "present since before the window opened" and returns 1. Moves no
// credits/fuel.
function createSetSyndicateCommitmentAction({ guildId, ventureId, commitment }) {
  if (guildId === undefined) throw new Error('createSetSyndicateCommitmentAction: guildId is required');
  if (ventureId === undefined) throw new Error('createSetSyndicateCommitmentAction: ventureId is required');
  if (commitment === undefined) throw new Error('createSetSyndicateCommitmentAction: commitment is required');
  return { type: 'setSyndicateCommitment', guildId, ventureId, commitment };
}

// applyForLicence: grant ONE mining venture a Syndicate Venture Licence — the real
// player path the throwaway `setSyndicateCommitment` scaffold above stands in for
// (design.md §5 "LICENCE FEE MECHANICS — RULED", Slice 3b-i). The player offers a
// share of the venture's droidless BASELINE output and a renegotiation window in days;
// the Syndicate does not negotiate — it has fixed terms keyed to what you offer, so
// everything else (the fee, and the commitment quantity the window machinery reads) is
// COMPUTED at apply time from the terms plus the posted price at that tick, and stored.
// The equity lever `o` is not set here: it is a term of the venture, offered at
// establishment (Slice 3a), and the fee simply reads it.
//
// Grants are once-only. Re-applying is RENEGOTIATION — window-gated and, with
// investors, a 75% majority (§5, #57) — which this slice does not build, so a second
// application on the same venture is refused rather than quietly re-locking the terms
// at today's price.
function createApplyForLicenceAction({ guildId, ventureId, committedOutputPct, windowDays }) {
  if (guildId === undefined) throw new Error('createApplyForLicenceAction: guildId is required');
  if (ventureId === undefined) throw new Error('createApplyForLicenceAction: ventureId is required');
  if (committedOutputPct === undefined) throw new Error('createApplyForLicenceAction: committedOutputPct is required');
  if (windowDays === undefined) throw new Error('createApplyForLicenceAction: windowDays is required');
  return { type: 'applyForLicence', guildId, ventureId, committedOutputPct, windowDays };
}

// setWindowN: set the single engine-wide accrual window length `state.windowN`. The
// codebase's FIRST state-scoped action — window length is engine-wide state, not a
// guild's, so there is NO guildId. An integer ≥ 1, settable ONLY before the run
// starts (setup-only knob, fixed before tick 0).
function createSetWindowNAction({ windowN }) {
  if (windowN === undefined) throw new Error('createSetWindowNAction: windowN is required');
  return { type: 'setWindowN', windowN };
}

// Selling stockpile goods to the Syndicate (design.md §5, "SELL GOES LIVE").
//
// The sale is PLAYER-ALLOCATED, PER SYSTEM: `allocations` is a set of
// `{systemId, qty}` — never one guild-wide quantity. There is no automatic drain
// and no largest-pile-first rule (that idea is explicitly REJECTED in §5). Which
// system a sale comes out of is a real supply-chain lever, because a factory
// draws its inputs from its OWN system's pile, so pulling stock out from under
// one must be the player's deliberate act.
function createSellToSyndicateAction({ guildId, good, allocations }) {
  if (guildId === undefined) throw new Error('createSellToSyndicateAction: guildId is required');
  if (good === undefined) throw new Error('createSellToSyndicateAction: good is required');
  if (allocations === undefined) throw new Error('createSellToSyndicateAction: allocations is required');
  return { type: 'sellToSyndicate', guildId, good, allocations };
}

// Buying goods from the Syndicate, for SCHEDULED DELIVERY (design.md §6,
// "Syndicate Delivery — the BUY side").
//
// The deliberate asymmetry with SELL (§5): a sale is instant, so it can be
// pick-and-mixed across every system that holds the good; a purchase TRAVELS, so
// it commits to exactly ONE destination — one shipment, one destination, no
// splitting. Hence a single `destinationSystemId` where the sale takes a list.
//
// The destination is a PARAMETER, not something the engine picks: which system a
// player wants goods delivered to is a supply-chain decision, and there is no
// defensible default (the home system would be one invention, the largest pile
// another). The confirm popup that asks for it is the next slice; this action is
// complete and testable without it.
function createBuyFromSyndicateAction({ guildId, good, qty, destinationSystemId }) {
  if (guildId === undefined) throw new Error('createBuyFromSyndicateAction: guildId is required');
  if (good === undefined) throw new Error('createBuyFromSyndicateAction: good is required');
  if (qty === undefined) throw new Error('createBuyFromSyndicateAction: qty is required');
  if (destinationSystemId === undefined) throw new Error('createBuyFromSyndicateAction: destinationSystemId is required');
  return { type: 'buyFromSyndicate', guildId, good, qty, destinationSystemId };
}

// --- Validation -------------------------------------------------------

// A Gate-1 `order` is a PERMUTATION of exactly these three fork names (§15.4):
// same three, each once, any ordering. No more, no fewer, no strangers.
const FORK_NAMES = ['syndicate', 'downstream', 'stockpile'];
function isValidOrder(order) {
  if (!Array.isArray(order) || order.length !== FORK_NAMES.length) return false;
  const seen = new Set(order);
  return seen.size === order.length && FORK_NAMES.every((name) => seen.has(name));
}

function isIntInRange(n, lo, hi) {
  return typeof n === 'number' && Number.isInteger(n) && n >= lo && n <= hi;
}

function findGuild(state, guildId) {
  return state.guilds.find((g) => g.id === guildId);
}

// Venture ids are unique across the whole galaxy, not just within a guild —
// scan every guild's ventures. Returns the venture or undefined.
function findVenture(state, ventureId) {
  for (const g of state.guilds || []) {
    for (const v of g.ventures || []) {
      if (v.id === ventureId) return v;
    }
  }
  return undefined;
}

// Which venture (if any) currently sits on a site — the same lookup the
// occupancy invariant polices, used here to refuse a double-seating up front.
function siteOccupant(state, siteId) {
  for (const g of state.guilds || []) {
    for (const v of g.ventures || []) {
      if (v.siteId === siteId) return v;
    }
  }
  return undefined;
}

// Validates ONE action against state-as-it-stands. Never mutates `state`.
// Returns { valid: true } or { valid: false, reason }.
function validateAction(state, action) {
  if (!action || typeof action.type !== 'string') {
    return { valid: false, reason: 'action must have a string type' };
  }

  if (action.type === 'paySyndicateFee') {
    const guild = findGuild(state, action.guildId);
    if (!guild) {
      return { valid: false, reason: `no guild with id ${JSON.stringify(action.guildId)}` };
    }
    if (typeof action.amount !== 'number' || !Number.isInteger(action.amount) || action.amount <= 0) {
      return { valid: false, reason: 'amount must be a positive integer (§15.2)' };
    }
    if (guild.credits < action.amount) {
      return {
        valid: false,
        reason: `guild ${guild.id} has ${guild.credits} credits, cannot pay ${action.amount}`,
      };
    }
    return { valid: true };
  }

  if (action.type === 'foundGuild') {
    if (typeof action.guildId !== 'string' || action.guildId.length === 0) {
      return { valid: false, reason: 'guildId must be a non-empty string' };
    }
    if (findGuild(state, action.guildId)) {
      return { valid: false, reason: `a guild with id ${JSON.stringify(action.guildId)} already exists` };
    }
    if (typeof action.credits !== 'number' || !Number.isInteger(action.credits) || action.credits < 0) {
      return { valid: false, reason: 'credits must be a non-negative integer (§15.2)' };
    }
    // Home must be a real starter-eligible system (§13) that no one has claimed
    // yet — checked against state-as-it-stands, so two guilds racing for the
    // same home in one batch resolve first-valid-wins like any other contest.
    if (typeof action.homeSystemId !== 'string' || action.homeSystemId.length === 0) {
      return { valid: false, reason: 'homeSystemId must be a non-empty string' };
    }
    if (!isStarterSystem(action.homeSystemId)) {
      return { valid: false, reason: `homeSystemId ${JSON.stringify(action.homeSystemId)} is not a starter-eligible system (§13)` };
    }
    if ((state.claims || []).some((c) => c.landmarkId === action.homeSystemId)) {
      return { valid: false, reason: `system ${JSON.stringify(action.homeSystemId)} is already claimed` };
    }
    // INLINE VENTURES OCCUPY TOO (design.md §4, 30-08-26). A founding may carry
    // ventures directly; in v1 every real create-path attaches an asset, so each
    // one must take a starter asset of its matching kind out of the very pool this
    // founding grants. Refused up front if the founding asks for more machines of a
    // kind than the gift holds — that is a genuine gap and it fails LOUDLY here,
    // rather than the engine quietly minting extra assets (an invented number) or
    // seating an asset-less venture (a state the real paths never produce).
    const inline = Array.isArray(action.ventures) ? action.ventures : [];
    const wanted = {};
    for (const v of inline) {
      const kind = assetKindForVentureType(v && v.type);
      if (!kind) {
        return { valid: false, reason: `inline venture ${JSON.stringify(v && v.id)} has ventureType ${JSON.stringify(v && v.type)}, which needs no known asset kind (expected 'mining' or 'refining')` };
      }
      wanted[kind] = (wanted[kind] || 0) + 1;
    }
    const pool = { miner: STARTER_MINERS, factory: STARTER_FACTORIES };
    for (const [kind, want] of Object.entries(wanted)) {
      if (want > pool[kind]) {
        return { valid: false, reason: `founding carries ${want} ventures needing a ${kind} but the starter gift holds only ${pool[kind]} ${kind} assets (docs/phase-1-tuning.md "Starter asset gift")` };
      }
    }
    return { valid: true };
  }

  if (action.type === 'establishVenture') {
    const guild = findGuild(state, action.guildId);
    if (!guild) {
      return { valid: false, reason: `no guild with id ${JSON.stringify(action.guildId)}` };
    }
    if (typeof action.ventureId !== 'string' || action.ventureId.length === 0) {
      return { valid: false, reason: 'ventureId must be a non-empty string' };
    }
    if (findVenture(state, action.ventureId)) {
      return { valid: false, reason: `a venture with id ${JSON.stringify(action.ventureId)} already exists` };
    }
    if (typeof action.siteId !== 'string' || action.siteId.length === 0) {
      return { valid: false, reason: 'siteId must be a non-empty string' };
    }
    const site = getSite(action.siteId);
    if (!site) {
      return { valid: false, reason: `site ${JSON.stringify(action.siteId)} does not exist in the seed` };
    }
    // Checked against state-as-it-stands, so two ventures racing for the same
    // site in one batch resolve first-valid-wins (the second is refused).
    const occupant = siteOccupant(state, action.siteId);
    if (occupant) {
      return { valid: false, reason: `site ${JSON.stringify(action.siteId)} is already occupied by venture ${JSON.stringify(occupant.id)}` };
    }
    // GATE 3 — the guild must HOLD the node's system (design.md §4's deploy
    // contract, 30-08-26): no building on land you don't own. This closes a real
    // gap — until now establish checked the site but never the territory, so a
    // guild could seat a venture anywhere in the galaxy. Same predicate the BUY
    // side already uses for "you may only buy into a system you hold"
    // (sim/claims.js), asked the same way, so the two can never disagree.
    if (!guildHolds(state, action.guildId, site.systemId)) {
      return { valid: false, reason: `guild ${JSON.stringify(action.guildId)} does not hold system ${JSON.stringify(site.systemId)} — a venture may only be deployed in a system you hold (§4)` };
    }
    if (typeof action.productionRate !== 'number' || !Number.isInteger(action.productionRate) || action.productionRate <= 0) {
      return { valid: false, reason: 'productionRate must be a positive integer (§15.2)' };
    }
    // The equity offer `o` (§5, Slice 3a): optional, a FRACTION in [0, 0.49] — the
    // structural ceiling that keeps the owner in control of its own venture. REFUSED
    // rather than clamped: a silently-clamped 0.8 would be the engine rewriting the
    // terms the player agreed to, and terms that are not what you set are worse than
    // a rejection (pressure over prohibition governs the GAME's rules, not the
    // engine's honesty about a contract).
    if (action.equityPct !== undefined && !isValidEquityPct(action.equityPct)) {
      return { valid: false, reason: `equityPct must be a fraction between 0 and ${EQUITY_CEILING} (§5's 49% ceiling)` };
    }
    // Type-specific placement rules, mirroring the occupancy invariant so a bad
    // request is refused here rather than applied and then halted mid-tick.
    const ventureType = action.ventureType || 'mining';
    if (ventureType === 'mining') {
      if (site.kind !== 'resource') {
        return { valid: false, reason: `site ${JSON.stringify(action.siteId)} is a ${site.kind} site, not a resource node (mining ventures need a resource node)` };
      }
      if (typeof action.resourceType !== 'string' || action.resourceType !== site.resourceType) {
        return { valid: false, reason: `resourceType ${JSON.stringify(action.resourceType)} does not match node ${JSON.stringify(action.siteId)}'s good ${JSON.stringify(site.resourceType)}` };
      }
    } else if (ventureType === 'refining') {
      if (site.kind !== 'settlement') {
        return { valid: false, reason: `site ${JSON.stringify(action.siteId)} is a ${site.kind} site, not a settlement slot (refining ventures sit on settlement slots)` };
      }
      if (!getRecipe(action.recipeId)) {
        return { valid: false, reason: `recipeId ${JSON.stringify(action.recipeId)} is not a known recipe (recipes.js)` };
      }
    } else {
      return { valid: false, reason: `unknown ventureType ${JSON.stringify(ventureType)} (expected 'mining' or 'refining')` };
    }
    // GATE 2 — the deploy NAMES the machine, and the named one must be an IDLE asset
    // of the matching kind in this guild's inventory (design.md §4): a Miner for a
    // resource node, a Factory for a settlement slot. The asset starts in inventory,
    // not on the node — the deploy is what takes it out. "Idle" is DERIVED
    // (sim/assets.js): an owned asset no venture of this guild references.
    //
    // Four separate refusals, in this order, because the player needs to know WHICH
    // way the id was wrong — "no idle asset" would be the same message for a typo, a
    // rival's machine, a factory sent to a mine and a machine already at work.
    // Checked against state-as-it-stands, so two deploys naming the SAME idle asset
    // in one batch resolve first-valid-wins exactly as two racing for the same node
    // do: the first occupies it, the second is refused as already deployed.
    const kind = assetKindForVentureType(ventureType);
    if (typeof action.assetId !== 'string' || action.assetId.length === 0) {
      return { valid: false, reason: 'assetId must be a non-empty string' };
    }
    // Ownership is "the guild whose array holds it" (§4), so an asset belonging to
    // ANOTHER guild fails this same check — it is not in this inventory.
    const asset = (guild.assets || []).find((a) => a.id === action.assetId);
    if (!asset) {
      return { valid: false, reason: `guild ${JSON.stringify(action.guildId)} owns no asset ${JSON.stringify(action.assetId)}` };
    }
    const heldBy = deployedAssetIds(guild).get(action.assetId);
    if (heldBy !== undefined) {
      return { valid: false, reason: `asset ${JSON.stringify(action.assetId)} is already deployed to venture ${JSON.stringify(heldBy)}` };
    }
    if (asset.kind !== kind) {
      return { valid: false, reason: `asset ${JSON.stringify(action.assetId)} is a ${asset.kind}; a ${ventureType} venture needs a ${kind} (§4)` };
    }
    return { valid: true };
  }

  if (action.type === 'setProductionProfile') {
    const guild = findGuild(state, action.guildId);
    if (!guild) {
      return { valid: false, reason: `no guild with id ${JSON.stringify(action.guildId)}` };
    }
    if (typeof action.systemId !== 'string' || action.systemId.length === 0) {
      return { valid: false, reason: 'systemId must be a non-empty string' };
    }
    if (action.goods !== undefined) {
      if (typeof action.goods !== 'object' || action.goods === null || Array.isArray(action.goods)) {
        return { valid: false, reason: 'goods must be an object keyed by good' };
      }
      for (const [good, policy] of Object.entries(action.goods)) {
        // Each key must be a real stockpile good (raw OR processed, NEVER
        // deuterium_fuel, which is not a stockpile good — §resources.js).
        if (!isStockpileGood(good)) {
          return { valid: false, reason: `${JSON.stringify(good)} is not a known stockpile good` };
        }
        if (typeof policy !== 'object' || policy === null || Array.isArray(policy)) {
          return { valid: false, reason: `policy for good ${JSON.stringify(good)} must be an object` };
        }
        // Each field is TRI-STATE (§15.4 sparse model): ABSENT (undefined) = leave
        // untouched; a valid VALUE = set; **null = CLEAR** — delete the stored key so
        // the good reverts to that field's default (e.g. the Syndicate send back to the
        // paced required-rate). So a field is validated only where PRESENT and NOT null;
        // null is always accepted as the clear-to-default instruction (setEntry deletes).
        if (policy.order !== undefined && policy.order !== null && !isValidOrder(policy.order)) {
          return { valid: false, reason: `order for good ${JSON.stringify(good)} must be a permutation of ["syndicate","downstream","stockpile"]` };
        }
        if (policy.downstreamPct !== undefined && policy.downstreamPct !== null && !isIntInRange(policy.downstreamPct, 0, 100)) {
          return { valid: false, reason: `downstreamPct for good ${JSON.stringify(good)} must be an integer 0..100 (§15.2)` };
        }
        // reserveLevel (§5 one-pot distribution, Slice A): the quantity the Reserve
        // claimant holds back at its priority slot — an integer ≥ 0. Replaces the
        // old stockpile {mode,value} fork amount and the separate reserveFloor.
        if (policy.reserveLevel !== undefined && policy.reserveLevel !== null
            && (typeof policy.reserveLevel !== 'number' || !Number.isInteger(policy.reserveLevel) || policy.reserveLevel < 0)) {
          return { valid: false, reason: `reserveLevel for good ${JSON.stringify(good)} must be a non-negative integer (§15.2)` };
        }
        // syndicate (§5 Slice B): the Syndicate fork's per-tick send control. ABSENT =
        // the paced required-rate default; null CLEARS back to it. When present it is
        // { mode, value } with mode ∈ {absolute, percent} and value an integer ≥ 0
        // (percent = share of this tick's fresh; percent > 100 is legal — "send all fresh").
        if (policy.syndicate !== undefined && policy.syndicate !== null) {
          const syn = policy.syndicate;
          if (typeof syn !== 'object' || syn === null || Array.isArray(syn)) {
            return { valid: false, reason: `syndicate for good ${JSON.stringify(good)} must be an object { mode, value }` };
          }
          if (syn.mode !== 'absolute' && syn.mode !== 'percent') {
            return { valid: false, reason: `syndicate.mode for good ${JSON.stringify(good)} must be "absolute" or "percent"` };
          }
          if (typeof syn.value !== 'number' || !Number.isInteger(syn.value) || syn.value < 0) {
            return { valid: false, reason: `syndicate.value for good ${JSON.stringify(good)} must be a non-negative integer (§15.2)` };
          }
        }
        // pursue (§5 licence distribution): the ORDER the good's delivered pile fills
        // its licensed ventures at the window boundary. An ARRAY of venture ids, or
        // null to clear back to establishment order. Deliberately NOT checked against
        // the current ventures — exactly like `throttles` below, and for the same
        // reason: the profile is standing intent, reconciled at READ time, so ranking
        // a venture you are about to establish (or one you have just removed) is legal
        // and simply resolves at the boundary. The review flag surfaces a stale entry
        // to the player rather than the action refusing it.
        if (policy.pursue !== undefined && policy.pursue !== null) {
          if (!Array.isArray(policy.pursue)) {
            return { valid: false, reason: `pursue for good ${JSON.stringify(good)} must be an array of ventureIds` };
          }
          for (const id of policy.pursue) {
            if (typeof id !== 'string' || id.length === 0) {
              return { valid: false, reason: `pursue for good ${JSON.stringify(good)} must contain non-empty ventureId strings` };
            }
          }
        }
      }
    }
    if (action.throttles !== undefined) {
      if (typeof action.throttles !== 'object' || action.throttles === null || Array.isArray(action.throttles)) {
        return { valid: false, reason: 'throttles must be an object keyed by ventureId' };
      }
      for (const [ventureId, pct] of Object.entries(action.throttles)) {
        if (!isIntInRange(pct, 0, 100)) {
          return { valid: false, reason: `throttle for venture ${JSON.stringify(ventureId)} must be an integer 0..100 (§15.2)` };
        }
      }
    }
    // DELIBERATE NON-CHECKS (§5, §15.4): a `throttles` key naming a venture that
    // does not currently exist, and a `goods` key for a good with no current
    // producer, are BOTH accepted. The profile is advisory standing intent,
    // reconciled at READ time — storing it ahead of, or after, the ventures it
    // references is legal. Do not "fix" this into a referential check: the engine
    // ignores stale entries at read time and a future venture picks up its policy.
    return { valid: true };
  }

  if (action.type === 'setSyndicateCommitment') {
    const guild = findGuild(state, action.guildId);
    if (!guild) {
      return { valid: false, reason: `no guild with id ${JSON.stringify(action.guildId)}` };
    }
    if (typeof action.ventureId !== 'string' || action.ventureId.length === 0) {
      return { valid: false, reason: 'ventureId must be a non-empty string' };
    }
    // The venture must exist AND belong to THIS guild — a commitment is the guild's
    // promise on its own venture's output, so scan only this guild's ventures.
    const venture = (guild.ventures || []).find((v) => v.id === action.ventureId);
    if (!venture) {
      return { valid: false, reason: `guild ${JSON.stringify(action.guildId)} has no venture with id ${JSON.stringify(action.ventureId)}` };
    }
    if (typeof action.commitment !== 'number' || !Number.isInteger(action.commitment) || action.commitment < 0) {
      return { valid: false, reason: 'commitment must be a non-negative integer (§15.2)' };
    }
    // FAIL LOUD, do not accept a silent no-op: the resolver sums commitment over the
    // ventures PRODUCING a good, keyed on `producedGoodFor` (sim/baseline.js), so a
    // venture that produces nothing identifiable — neither a `resourceType` nor a
    // resolvable recipe output — would never contribute to any `Q`. Refuse it rather
    // than store an inert number. commitment === 0 is always allowed (it clears to
    // unlicensed, meaningful on any venture).
    //
    // A FACTORY IS NOW ACCEPTED (factory-commitment slice, 28-08-26). This used to read
    // `!venture.resourceType` and refuse every refining venture, because the accrual was
    // mines-only; the accrual is producer-general now, so a factory's commitment lands
    // on its recipe's OUTPUT good and is delivered, sold and judged like a mine's.
    if (action.commitment > 0 && !producedGoodFor(venture)) {
      return { valid: false, reason: `venture ${JSON.stringify(action.ventureId)} produces no identifiable good (no resourceType and no resolvable recipe output), so a non-zero commitment here would be silently inert` };
    }
    return { valid: true };
  }

  if (action.type === 'applyForLicence') {
    const guild = findGuild(state, action.guildId);
    if (!guild) {
      return { valid: false, reason: `no guild with id ${JSON.stringify(action.guildId)}` };
    }
    if (typeof action.ventureId !== 'string' || action.ventureId.length === 0) {
      return { valid: false, reason: 'ventureId must be a non-empty string' };
    }
    // Scan only THIS guild's ventures: a licence is a contract over a venture you own.
    const venture = (guild.ventures || []).find((v) => v.id === action.ventureId);
    if (!venture) {
      return { valid: false, reason: `guild ${JSON.stringify(action.guildId)} has no venture with id ${JSON.stringify(action.ventureId)}` };
    }
    if (venture.licence) {
      return { valid: false, reason: `venture ${JSON.stringify(action.ventureId)} is already licensed — changing agreed terms is a renegotiation (§5), not a second application, and renegotiation is not built yet`};
    }
    // The good this licence is a contract over — a mine's `resourceType`, a FACTORY's
    // recipe output (`producedGoodFor`, sim/baseline.js). The mines-only refusal that
    // stood here is GONE (factory-commitment slice, 28-08-26): it existed for a purely
    // mechanical reason — the §5 accrual summed `Q` over ventures with a `resourceType`,
    // so a factory licence could never have been delivered or judged — and that accrual
    // is producer-general now. What remains is the same check with no venture type in
    // it: a venture that produces nothing identifiable has no good to commit.
    const committedGood = producedGoodFor(venture);
    if (!committedGood) {
      return { valid: false, reason: `venture ${JSON.stringify(action.ventureId)} produces no identifiable good (no resourceType and no resolvable recipe output) — there is nothing for a licence to commit` };
    }
    // Fuel is a Syndicate MONOPOLY with no guild licence to price (§8, §5 "Fuel is
    // excluded"). `deuterium_fuel` is not minable and no recipe outputs it, so nothing
    // can produce it, but the exclusion is stated here rather than left to be implied.
    if (isFuel(committedGood)) {
      return { valid: false, reason: `${JSON.stringify(committedGood)} is Syndicate-regulated — fuel carries no venture licence (§8)` };
    }
    // The terms. Refused, not clamped — as with 3a's equity offer, a silently-adjusted
    // term would be the engine rewriting a contract the player agreed to.
    if (!isValidCommitmentPct(action.committedOutputPct)) {
      return { valid: false, reason: `committedOutputPct must be a fraction between ${COMMITMENT_FLOOR} and 1 (§5's commitment floor)` };
    }
    if (!isValidWindowDays(action.windowDays)) {
      return { valid: false, reason: `windowDays must be a whole number of days between ${WINDOW_DAYS_MIN} and ${WINDOW_DAYS_MAX} (§5's renegotiation window)` };
    }
    // The fee is priced off the POSTED price at signing, so there must be one to lock.
    // Every non-fuel good carries a price from tick 0; this catches a state whose price
    // block was removed, rather than locking a licence against `null` forever.
    if (postedPrice(state, committedGood) == null) {
      return { valid: false, reason: `${JSON.stringify(committedGood)} has no posted price to lock the fee against` };
    }
    // And the venture must have a baseline to price the fee off (sim/baseline.js). A
    // mine whose resource has no baseline entry is caught by that file's drift guard;
    // refusing here keeps a fee from being computed against a zero capacity.
    const baseline = baselineOutputFor(venture);
    if (!baseline || !(baseline.units > 0)) {
      return { valid: false, reason: `venture ${JSON.stringify(action.ventureId)} has no droidless baseline output to price a fee against` };
    }
    return { valid: true };
  }

  if (action.type === 'sellToSyndicate') {
    const guild = findGuild(state, action.guildId);
    if (!guild) {
      return { valid: false, reason: `no guild with id ${JSON.stringify(action.guildId)}` };
    }
    // WHAT MAY BE SOLD. `PRICED_GOODS` is the Exchange's own vocabulary (every
    // stockpile good that is not fuel), so this one check refuses fuel, an unknown
    // name and a catalog-only Tier-3 placeholder alike. Fuel is called out
    // separately only so the refusal SAYS why: it is Syndicate-regulated and never
    // listed (§8, §5 "Fuel is never sold here") — a permanent rule, not a gap.
    if (isFuel(action.good)) {
      return { valid: false, reason: `${JSON.stringify(action.good)} is Syndicate-regulated — fuel is never listed on the Exchange (§8)` };
    }
    if (typeof action.good !== 'string' || !PRICED_GOODS.includes(action.good)) {
      return { valid: false, reason: `${JSON.stringify(action.good)} is not a good the Syndicate posts a price for` };
    }
    // ...and there must actually BE a posted price to sell at. Every priced good
    // carries one from tick 0, so this catches a state whose price block was
    // removed by hand rather than a normal case — refused here so applyAction's
    // loud guard is the backstop, not the first line.
    if (postedPrice(state, action.good) == null) {
      return { valid: false, reason: `${JSON.stringify(action.good)} has no posted price to sell at` };
    }
    if (!Array.isArray(action.allocations) || action.allocations.length === 0) {
      return { valid: false, reason: 'allocations must be a non-empty array of { systemId, qty } (§5: a sale is composed per system)' };
    }
    const seen = new Set();
    for (const alloc of action.allocations) {
      if (!alloc || typeof alloc !== 'object' || Array.isArray(alloc)) {
        return { valid: false, reason: 'each allocation must be an object { systemId, qty }' };
      }
      if (typeof alloc.systemId !== 'string' || alloc.systemId.length === 0) {
        return { valid: false, reason: 'each allocation needs a non-empty systemId' };
      }
      // A DUPLICATE systemId is refused rather than summed: two rows for one system
      // is an ambiguous order, and quietly adding them up would be the engine
      // deciding what the player meant.
      if (seen.has(alloc.systemId)) {
        return { valid: false, reason: `allocations name system ${JSON.stringify(alloc.systemId)} twice — one row per system` };
      }
      seen.add(alloc.systemId);
      if (typeof alloc.qty !== 'number' || !Number.isInteger(alloc.qty) || alloc.qty <= 0) {
        return { valid: false, reason: `qty for system ${JSON.stringify(alloc.systemId)} must be a positive integer (§15.2)` };
      }
      // THE OWNERSHIP CHECK IS THE PILE ITSELF. A guild's stockpiles are keyed by
      // the systems it actually operates in, so "a system the guild owns that holds
      // the good" and "a system whose pile of this good is non-empty" are the same
      // question — and the pile is the thing the sale drains, so it is the honest
      // one to ask. A system the guild does not hold reads as 0 here and is refused
      // by name.
      const held = getStock(guild, alloc.systemId, action.good);
      if (held <= 0) {
        return { valid: false, reason: `guild ${guild.id} holds no ${action.good} in system ${JSON.stringify(alloc.systemId)}` };
      }
      // NO RESERVE GUARD (§5): selling a system's whole pile — or every system's —
      // is legal. The only ceiling is what is actually there.
      if (alloc.qty > held) {
        return { valid: false, reason: `guild ${guild.id} holds ${held} ${action.good} in system ${JSON.stringify(alloc.systemId)}, cannot sell ${alloc.qty}` };
      }
    }
    return { valid: true };
  }

  if (action.type === 'buyFromSyndicate') {
    const guild = findGuild(state, action.guildId);
    if (!guild) {
      return { valid: false, reason: `no guild with id ${JSON.stringify(action.guildId)}` };
    }
    // WHAT MAY BE BOUGHT — the same vocabulary a sale uses, for the same reasons.
    // A single posted price serves both directions (#43, no spread, no transport
    // fee: the Syndicate charges for control, not carriage — §6), so anything it
    // will not buy it will not sell either.
    if (isFuel(action.good)) {
      return { valid: false, reason: `${JSON.stringify(action.good)} is Syndicate-regulated — fuel is never listed on the Exchange (§8)` };
    }
    if (typeof action.good !== 'string' || !PRICED_GOODS.includes(action.good)) {
      return { valid: false, reason: `${JSON.stringify(action.good)} is not a good the Syndicate posts a price for` };
    }
    const price = postedPrice(state, action.good);
    if (price == null) {
      return { valid: false, reason: `${JSON.stringify(action.good)} has no posted price to buy at` };
    }
    if (typeof action.qty !== 'number' || !Number.isInteger(action.qty) || action.qty <= 0) {
      return { valid: false, reason: 'qty must be a positive integer (§15.2)' };
    }
    if (typeof action.destinationSystemId !== 'string' || action.destinationSystemId.length === 0) {
      return { valid: false, reason: 'destinationSystemId must be a non-empty string' };
    }
    // YOU MAY ONLY BUY INTO A SYSTEM YOU HOLD. `guildHolds` (sim/claims.js) is the
    // ONE predicate for that question, and stepArrivals asks the SAME one at the
    // arrival tick — where a `false` is what makes the cargo vanish (§6). Two
    // different readings of "holds" would mean a delivery legal to schedule and
    // impossible to land.
    if (!guildHolds(state, action.guildId, action.destinationSystemId)) {
      return { valid: false, reason: `guild ${guild.id} does not hold system ${JSON.stringify(action.destinationSystemId)} — a delivery goes only to a system you hold (§6)` };
    }
    // ...and there must be a waystation to sail from, and a destination with real
    // coords to sail to. Refused rather than defaulted: an invented origin would
    // silently invent an arrival tick.
    if (!nearestWaystation(action.destinationSystemId)) {
      return { valid: false, reason: `no Syndicate waystation can reach system ${JSON.stringify(action.destinationSystemId)} — it resolves to no seed coordinates` };
    }
    // THE CASH IS DEBITED NOW, in full, at the single posted price with no fee
    // (§6 step 3). Rounded once on the whole order, exactly as a sale is (#43).
    const cost = Math.round(action.qty * price);
    if (guild.credits < cost) {
      return { valid: false, reason: `guild ${guild.id} holds ${guild.credits} credits, cannot pay ${cost} for ${action.qty} ${action.good}` };
    }
    return { valid: true };
  }

  if (action.type === 'setWindowN') {
    if (typeof action.windowN !== 'number' || !Number.isInteger(action.windowN) || action.windowN < 1) {
      return { valid: false, reason: 'windowN must be an integer >= 1 (§15.2)' };
    }
    // Setup-only knob: the window length is fixed BEFORE the run. Once the galaxy
    // has advanced (tick > 0) changing it would move the boundary cadence mid-run,
    // so refuse it — no state change.
    if (state.tick > 0) {
      return { valid: false, reason: `windowN is a setup-only knob — state.tick is ${state.tick}, it can only be set before the run starts (tick 0)` };
    }
    // ...and not once any licence has been signed (Slice 3b-i). A licence's fee and
    // committed quantity are both computed over ONE WINDOW at signing and then locked;
    // moving `N` afterwards would silently make those locked terms describe a window
    // that no longer exists. Set the window length first, then license. (Reachable
    // only at tick 0, where a licence can legitimately already exist.)
    const licensed = (state.guilds || []).some((g) => (g.ventures || []).some((v) => v.licence));
    if (licensed) {
      return { valid: false, reason: 'windowN cannot change once a licence has been signed — its fee and committed quantity are locked over one window of the length in force at signing' };
    }
    return { valid: true };
  }

  return { valid: false, reason: `unknown action type: ${action.type}` };
}

// Applies ONE already-validated action. Never mutates `state` — returns a
// new state. Callers MUST validate first; this does not re-check.
function applyAction(state, action) {
  const next = structuredClone(state);
  if (action.type === 'paySyndicateFee') {
    const guild = findGuild(next, action.guildId);
    guild.credits -= action.amount;
    next.syndicate.ledger += action.amount;
    return next;
  }
  if (action.type === 'foundGuild') {
    // Seat the guild on its home: record the denormalised home pointer and add
    // the ownership claim (the source of truth). The Terran homeworld is the
    // system's lowest-id Terran planet, resolved from the seed.
    const homePlanetId = getTerranHomeworld(action.homeSystemId);
    // THE STARTER ASSET GIFT (design.md §4, docs/phase-1-tuning.md "Starter asset
    // gift"): 15 Miners + 10 Factories, idle, in inventory. It is ENGINE POLICY,
    // not an action field — exactly like the `fuelHoard` grant below — so the action shape
    // is byte-identical to before this slice and no caller can ask for a different
    // gift. The counts and the deterministic id scheme both live in sim/assets.js;
    // nothing is inlined here.
    const assets = starterAssetSpecs(action.guildId);
    // The pool each inline venture draws from, split by kind and consumed in order.
    const unclaimed = { miner: assets.filter((a) => a.kind === 'miner'), factory: assets.filter((a) => a.kind === 'factory') };

    // Two stamps per inline venture:
    //
    // 1. Its denormalised systemId, from its site (ruling B1, §15.2) — the pool key
    //    production deposits into. This mirrors what establishVenture does; without
    //    it an inline-founded mine would pool its goods under a `null` system
    //    instead of the one its node sits in. (The flat guild total is unaffected
    //    either way — guildTotals sums across pools — but the per-system breakdown,
    //    and any consumer keyed by system, must be right.)
    // 2. Its `assetId` — INLINE VENTURES OCCUPY TOO (§4, 30-08-26), taking a starter
    //    asset of their matching kind out of the very pool this founding grants
    //    (validateAction has already proved the pool is big enough). Deterministic
    //    by construction: the specs are minted in a fixed order and consumed in the
    //    founding's own venture order, so two runs of the same scenario attach the
    //    same machine to the same venture (invariant 9). Any `assetId` a caller put
    //    on an inline venture is OVERWRITTEN, not honoured: the pool is minted here,
    //    so a caller's id could only name a machine that does not exist.
    const ventures = (action.ventures || []).map((v) => {
      const site = v.systemId == null && v.siteId != null ? getSite(v.siteId) : null;
      return {
        ...v,
        ...(site ? { systemId: site.systemId } : {}),
        assetId: unclaimed[assetKindForVentureType(v.type)].shift().id,
      };
    });
    const guild = createGuild({
      id: action.guildId,
      name: action.name,
      isBot: action.isBot,
      credits: action.credits,
      fuelHoard: GUILD_STARTING_FUEL, // the starter floor -- see createFoundGuildAction's note
      influence: action.influence,
      incomeRate: action.incomeRate,
      homeSystemId: action.homeSystemId,
      homePlanetId,
      assets,
      ventures,
    });
    next.guilds.push(guild);
    next.claims.push({
      claimId: `claim_home_${action.guildId}`,
      ownerGuildId: action.guildId,
      landmarkId: action.homeSystemId,
      landmarkKind: 'system',
      claimedAtTick: next.tick,
      contested: false,
    });
    // The ledger FUNDS the starting credits: credits move Syndicate -> guild,
    // none are created. expectedCreditTotal is unchanged (guild +C, ledger -C
    // => net 0), so invariant 2 still holds. Founding does NOT grant the +20
    // claim bonus (setup, not a play action -- see createFoundGuildAction).
    next.syndicate.ledger -= action.credits;

    // FUEL-GENESIS, and the audit entry that makes it honest. Invariant 1 reads
    //   Σ guild.fuelHoard + reserve.reserveLevel + inTransit
    //     === audit.totalProduced - audit.totalConsumed
    // so a hoard that appears from nowhere must be recorded as PRODUCED, or the
    // left side grows while the right side does not and the tripwire fires on
    // the very tick a guild is born. `totalProduced` is a monotonic counter, so
    // this only ever adds. (createState does the same sum for scenario guilds --
    // see sim/state.js's `totalProduced: sumFuelHoards(guilds) + reserveLevel`.)
    next.audit.totalProduced += GUILD_STARTING_FUEL;

    // THE BETWEEN-TICK SEAM, exactly as sellToSyndicate documents it below:
    // `state.galacticSupply` is a CACHE the tick refreshes once after its eight
    // steps, and the galactic-supply-consistency invariant compares that cache
    // against a live recompute. `POST /action` asserts every invariant right
    // after apply, with no tick in between, so founding a guild with a non-zero
    // hoard and leaving `fuel.guildHeld` stale would trip that check and return
    // a 500 instead of landing the founding. Refreshed through the same one
    // selector the tick uses -- not a second derivation.
    next.galacticSupply = computeGalacticSupply(next);
    return next;
  }
  if (action.type === 'establishVenture') {
    // Seat a new venture on the guild. No credits/fuel move (no site cost yet).
    // It starts producing on the NEXT production step: because intake runs before
    // the tick's steps, establishing + ticking in the same advance() call runs
    // its first batch immediately, exactly as an inline founding venture does.
    // A mining venture carries resourceType; a refining one carries recipeId
    // (createVenture defaults the unused one to null).
    const guild = findGuild(next, action.guildId);
    // Resolve the site once more (validateAction already proved it exists) to
    // stamp the venture's systemId — the pool key production uses (ruling B1,
    // §15.2). Denormalised from the site, guarded against it by invariants.js.
    const site = getSite(action.siteId);
    // OCCUPY, NOT CONSUME (design.md §4). Gate 2 already proved the NAMED asset is
    // owned by this guild, idle, and of the matching kind, so the apply simply points
    // the new venture at it — no re-derivation here, and no second opinion about
    // which machine was meant. The asset is NOT removed from `guild.assets`: it is
    // still owned, it is simply now referenced, and that reference is the whole of
    // what "deployed" means. Deploy is one-way in this slice — nothing returns an
    // asset to idle until cancel-licence exists (§4).
    guild.ventures.push(createVenture({
      id: action.ventureId,
      ownerGuildId: action.guildId,
      type: action.ventureType || 'mining',
      siteId: action.siteId,
      systemId: site ? site.systemId : null,
      assetId: action.assetId,
      resourceType: action.resourceType,
      recipeId: action.recipeId,
      productionRate: action.productionRate,
      // equityPct: the ONE licence term this slice lets the establish path set (§5's
      // equity lever, validated above). Absent ⇒ createVenture's 0, and the venture
      // carries no key at all. The rest of the terms — commitment %, the fee locked
      // at issuance, the renegotiation window — arrive with the real licence entity
      // (Slice 3b); they are not invented here.
      equityPct: action.equityPct,
      // syndicateCommitment is NOT taken from the action: it is engine-owned and
      // defaults to 0 (unlicensed) in createVenture. Every venture established
      // today is unlicensed, so the establish path never supplies it — the
      // reserved placeholder shape (design.md §15.4, §5) lands at 0.
    }));
    return next;
  }
  if (action.type === 'setProductionProfile') {
    // Merge the validated patch into the guild's profile via sim/profile.js — the
    // one file that owns the nested shape. This mutates OWNED state only; it moves
    // no credits/fuel and no tick step reads the profile yet (slice 2a-ii), so it
    // is a behavioural no-op on production. Sibling owned-state actions
    // (establishVenture) do NOT stamp a tick on the mutated entity — the profile
    // shape carries no updatedAtTick field (§15.4) — so, per §15.2's "match how
    // sibling actions handle it; if they don't stamp, don't invent it," this
    // doesn't either.
    const guild = findGuild(next, action.guildId);
    setEntry(guild, action.systemId, { goods: action.goods, throttles: action.throttles });
    return next;
  }
  if (action.type === 'setSyndicateCommitment') {
    // Write the venture's committed quantity — engine-owned state (§5/§15.4). Moves
    // no credits/fuel. It DELIBERATELY does not set committedFromTick — leaving it
    // absent keeps windowFraction at 1, so this scaffold commits for the whole window,
    // which is the behaviour its tests pin — and does not stamp updatedAtTick; the
    // sibling owned-state actions
    // (establishVenture, setProductionProfile) don't stamp the entity they mutate,
    // and §15.2 says match how the siblings handle it, don't invent a field.
    const guild = findGuild(next, action.guildId);
    const venture = guild.ventures.find((v) => v.id === action.ventureId);
    venture.syndicateCommitment = action.commitment;
    return next;
  }
  if (action.type === 'applyForLicence') {
    // Grant the licence: compute the terms ONCE, here, and store them. Everything this
    // reads is state-as-it-stands — the posted price at this tick, the venture's own
    // equity offer, its type's droidless baseline — so a licence signed at a different
    // moment is a different contract, which is exactly §5's "rewards reading the market
    // and timing your lock". Moves NO credits: 3b-iii debits the fee at a boundary.
    const guild = findGuild(next, action.guildId);
    const venture = guild.ventures.find((v) => v.id === action.ventureId);
    // The OUTPUT good — the price engine posts one for every processed good exactly as
    // it does for a raw one, so a factory's fee is priced off its own product, not its
    // inputs. `baselineOutputFor` is the single source for both halves of that (the good
    // and the droidless units/tick), for a mine and a factory alike — no number invented.
    const baseline = baselineOutputFor(venture);
    const good = baseline.good;
    const lockedPrice = postedPrice(next, good);
    // The window the terms are measured over: the engine-wide `state.windowN`, or the
    // flagged fallback the resolver itself uses when a scenario sets none — the same
    // number, read the same way, so the licence can never be priced over a different
    // window than the one its commitment accrues in.
    const windowN = next.windowN == null ? DEFAULT_WINDOW_N : next.windowN;
    const baselineUnitsPerTick = baseline.units;

    const { basicFee, discountedFee } = licenceFee({
      baselineUnitsPerTick,
      windowN,
      lockedPrice,
      committedOutputPct: action.committedOutputPct,
      equityPct: equityOf(venture),   // the term offered at establishment (Slice 3a)
    });

    venture.licence = {
      committedOutputPct: action.committedOutputPct,
      windowDays: action.windowDays,
      signedTick: next.tick,          // §15.2: every mutation records its tick
      lockedPrice,
      basicFee,
      discountedFee,
    };
    // The operative commitment: the share of BASELINE output promised over one window,
    // in whole units. This is the field the §5 accrual sums into `Q` and that 3a's sale
    // is paid on — so granting the licence is what switches the commitment sale on.
    venture.syndicateCommitment = commitmentUnitsFor(action.committedOutputPct, baselineUnitsPerTick, windowN);

    // The MID-WINDOW PRO-RATE (§5's join ruling, Option A; Slice 3b-ii). Stamping this
    // is what makes `windowFraction` (sim/windows.js) stop returning 1: a venture
    // licensed part-way through a window owes only the share of `Q` for the ticks it is
    // actually present, instead of a full window's target it had no chance to deliver.
    //
    // WHY `signedTick + 1` AND NOT `signedTick` — the off-by-one is load-bearing.
    // Intake runs BEFORE the tick (`advance` = intake → tick → assert), so a venture
    // licensed while `state.tick` is T is committed during intake but first produces —
    // and therefore first delivers — on the tick that yields state T+1. `windowFraction`
    // counts `present = windowStart + N − committedFromTick`, which is the number of
    // producing ticks from `committedFromTick` to the boundary INCLUSIVE. For that count
    // to equal the ticks the venture actually delivers in, the stamp must be its first
    // producing tick, which is `signedTick + 1`. Stamping `signedTick` would credit it
    // with one tick it was never able to produce in, and it would owe a unit it could
    // not deliver — the same unfairness in miniature that the pro-rate exists to fix.
    //
    // Only `applyForLicence` stamps it. An unlicensed venture, or one committed through
    // the `setSyndicateCommitment` dev scaffold, carries no `committedFromTick` at all,
    // so `windowFraction` returns 1 for it and its behaviour is exactly as before.
    venture.committedFromTick = venture.licence.signedTick + 1;
    return next;
  }

  if (action.type === 'sellToSyndicate') {
    // The Syndicate buys, at the POSTED price — the published, 2-tick-lagged value
    // the player is looking at (§5: "goods sold to the Syndicate execute at the
    // current price during the tick, end of"). No projection, no sliding.
    const guild = findGuild(next, action.guildId);
    const price = postedPrice(next, action.good);
    if (price == null) {
      // Validation already refused this, so reaching it means a state whose price
      // block was removed between validate and apply. Taking the goods anyway would
      // be a silent loss, so halt loudly — the same guard, and the same reason, as
      // applyProduction's Syndicate delivery (§15.5).
      throw new Error(`applyAction: guild ${guild.id} sold ${action.good} to the Syndicate at tick ${next.tick} but the good has no posted price — refusing to hand over goods for nothing`);
    }

    // Drain EXACTLY what the player specified, and nothing else: each named
    // system's pile drops by its own qty, and a system not named is untouched.
    // Sorted by systemId so the sequence of mutations is fixed (invariant 9).
    const allocations = [...action.allocations].sort((a, b) => (a.systemId < b.systemId ? -1 : a.systemId > b.systemId ? 1 : 0));
    let totalQty = 0;
    for (const alloc of allocations) {
      addStock(guild, alloc.systemId, action.good, -alloc.qty);
      totalQty += alloc.qty;
    }
    // The goods LEAVE THE ECONOMY here — absorbed into the Syndicate's
    // inexhaustible stock (§5). They are deposited nowhere, which is why nothing
    // above has a receiving side.

    // ROUNDED ONCE, ON THE TOTAL — decision #43 (`round(qty × price)`), the same
    // arithmetic `commitmentSale` uses. Rounding per system instead would pay a
    // different amount for the same goods depending on how the player split them.
    const credited = Math.round(totalQty * price);
    // Credit-conservation-clean, the mirror of paySyndicateFee: the ledger FUNDS
    // the payment, so nothing is minted and invariant 2 holds to the credit.
    guild.credits += credited;
    next.syndicate.ledger -= credited;

    // ── THE BETWEEN-TICK SEAM ────────────────────────────────────────────────
    // This is the first action that mutates a stockpile, and `POST /action`
    // asserts every invariant immediately after apply — with no tick in between.
    // `state.galacticSupply` is a CACHE the tick refreshes once after its eight
    // steps (tick.js), and the galactic-supply-consistency invariant compares that
    // cache against a live recompute. Draining a pile without refreshing it here
    // would leave the cache describing goods that no longer exist, and the sale
    // would trip the invariant instead of landing. Refreshed exactly as the tick
    // does it, through the same one selector — not a second derivation.
    next.galacticSupply = computeGalacticSupply(next);
    // NOTE on `audit`: totalProduced/totalConsumed are FUEL counters (invariant 1)
    // and fuel is never sold here, so there is nothing for this sale to keep exact
    // in them. expectedCreditTotal is unchanged too — the sale moves credits
    // between a guild and the ledger, it does not change how many exist.
    return next;
  }

  if (action.type === 'buyFromSyndicate') {
    // The BUY half of the Exchange (design.md §6). Two things happen here and
    // nothing else: the cash moves NOW, and a delivery is SCHEDULED. No goods are
    // deposited — that is stepArrivals' job, `arrivalTick` ticks from now.
    const guild = findGuild(next, action.guildId);
    const price = postedPrice(next, action.good);
    if (price == null) {
      // Validation refused this, so reaching it means the price block vanished
      // between validate and apply. Taking the money for goods with no price
      // would be a silent theft — halt, exactly as the sale's mirror guard does.
      throw new Error(`applyAction: guild ${guild.id} bought ${action.good} from the Syndicate at tick ${next.tick} but the good has no posted price — refusing to take credits for nothing`);
    }

    // ROUNDED ONCE, ON THE WHOLE ORDER — #43, and the identical arithmetic the
    // sale uses, so a good bought and immediately sold back at an unmoved price
    // costs exactly nothing. There is NO transport fee and NO spread (§5/§6).
    const cost = Math.round(action.qty * price);
    // The mirror of paySyndicateFee: credits leave the guild and the same integer
    // lands in the ledger, so invariant 2 holds to the credit by construction.
    guild.credits -= cost;
    next.syndicate.ledger += cost;

    // THE SCHEDULE. Nearest waystation → straight-line hex distance → an ABSOLUTE
    // arrival tick (§6 steps 1–2). Computed once, here, and never recomputed: a
    // delivery on an uncontested straight line needs no per-tick work until it
    // lands (§15.6's "pure schedule"), and an absolute tick is what lets a save
    // reloaded mid-flight land on the right tick with no special case.
    const { distance } = nearestWaystation(action.destinationSystemId);
    if (!Array.isArray(next.shipments)) next.shipments = [];
    next.shipments.push({
      ownerGuildId: action.guildId,
      // `cargo` carries the bought good and NOTHING else — in particular never a
      // `fuel` key, so invariant 1's fuel-in-transit sum reads 0 for a BUY
      // delivery (§6's fuel-invariant note). Fuel is refused up front anyway;
      // this is the shape making that structurally true rather than incidentally.
      cargo: { [action.good]: action.qty },
      destinationSystemId: action.destinationSystemId,
      arrivalTick: arrivalTickFor(next.tick, distance),
    });
    // NO origin, NO route, NO status (§6): nothing needs tracking between now and
    // arrival, and a field nobody reads is a fact with a second home waiting to
    // drift (invariant 5).
    //
    // NO galacticSupply REFRESH, unlike the sale: not one stockpile moved. The
    // goods are a scheduled deposit, not held inventory (which is also exactly
    // why losing them later imbalances nothing — §6), so the supply cache still
    // describes the galaxy correctly and the consistency invariant stays green
    // between ticks. `audit` is untouched for the same reasons the sale leaves it
    // alone: its counters are fuel, and this moves credits without changing how
    // many exist.
    return next;
  }

  if (action.type === 'setWindowN') {
    // Set the single engine-wide window length. Setup-only (validate refused it once
    // tick > 0), so this only ever writes tick-0 state. No guild is resolved — this
    // is the first state-scoped action.
    next.windowN = action.windowN;
    return next;
  }
  // Unreachable if validateAction() was checked first, since every accepted
  // type is handled above — fail loudly rather than silently no-op if not.
  throw new Error(`applyAction: unhandled action type: ${action.type}`);
}

// --- Intake -------------------------------------------------------------

// intake(state, actions) — the sequential validate-as-they-arrive pass.
// Processes `actions` IN ORDER, one at a time, against state-as-it-stands
// (i.e. reflecting every action already accepted earlier in this call).
// Never mutates the input state. Returns:
//   {
//     state:   the resulting state after every accepted action applied,
//     results: [{ action, accepted, reason? }, ...] one entry per input,
//               in the same order, so a caller can see exactly what happened
//               and why (reason is present only when accepted is false).
//   }
function intake(state, actions) {
  if (!state) throw new Error('intake: state is required');
  if (!Array.isArray(actions)) throw new Error('intake: actions must be an array');

  let working = state;
  const results = [];

  for (const action of actions) {
    const { valid, reason } = validateAction(working, action);
    if (valid) {
      working = applyAction(working, action);
      results.push({ action, accepted: true });
    } else {
      results.push({ action, accepted: false, reason });
    }
  }

  return { state: working, results };
}

module.exports = {
  createPaySyndicateFeeAction,
  createFoundGuildAction,
  createEstablishVentureAction,
  createSetProductionProfileAction,
  createSetSyndicateCommitmentAction,
  createApplyForLicenceAction,
  createSetWindowNAction,
  createSellToSyndicateAction,
  createBuyFromSyndicateAction,
  validateAction,
  applyAction,
  intake,
};
