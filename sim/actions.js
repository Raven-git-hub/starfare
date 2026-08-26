'use strict';

const { createGuild, createVenture } = require('./state.js');
const { isStarterSystem, getTerranHomeworld, getSite } = require('./seed.js');
const { getRecipe } = require('./recipes.js');
const {
  EQUITY_CEILING, isValidEquityPct, COMMITMENT_FLOOR, WINDOW_DAYS_MIN, WINDOW_DAYS_MAX,
  isValidCommitmentPct, isValidWindowDays, licenceFee, commitmentUnitsFor, equityOf,
} = require('./licence.js');
const { baselineOutputFor } = require('./baseline.js');
const { postedPrice } = require('./prices.js');
const { FIRST_CUT_WINDOW_N } = require('./windows.js');
const { isStockpileGood, isFuel } = require('./resources.js');
const { setEntry } = require('./profile.js');

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
//                         nothing is minted, and it seats + claims the home.
//   - establishVenture  — seat a NEW mining venture on a real seed node so it
//                         produces on the next tick (occupancy-guarded).
//   - setProductionProfile — store a guild's per-system Gate-1/Gate-3 policy.
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
// so nothing is minted and invariant 2 holds. Starting fuelHoard is always 0:
// every decided roster starts at 0 (docs/phase-1-tuning.md), and minting fuel
// into a hoard would need a fuel-genesis rule we have not decided -- so this
// action does not offer a non-zero starting hoard at all.
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
// request is refused cleanly rather than applied-then-halted. `productionRate` is
// REQUIRED and operator-supplied — a testbed dial, since only Titanium's mining
// rate is ruled; the rest (and refinery throughput) are undecided. Establishing
// a venture moves no credits or fuel (no licence/site cost yet).
function createEstablishVentureAction({
  guildId, ventureId, type = 'mining', siteId, resourceType, recipeId, productionRate, equityPct,
}) {
  if (guildId === undefined) throw new Error('createEstablishVentureAction: guildId is required');
  if (ventureId === undefined) throw new Error('createEstablishVentureAction: ventureId is required');
  if (siteId === undefined) throw new Error('createEstablishVentureAction: siteId is required');
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
    type: 'establishVenture', guildId, ventureId, ventureType: type, siteId, resourceType, recipeId, productionRate,
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
// integer ≥ 0; 0 clears back to unlicensed. It does NOT set committedFromTick (so
// windowFraction stays 1 and the deferred mid-window pro-rate tripwire stays green)
// and moves no credits/fuel.
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
    // FAIL LOUD, do not accept a silent no-op: the resolver sums commitment over
    // MINES only (§5 — `v.resourceType && v.syndicateCommitment`), so a non-zero
    // commitment on a refinery/typeless venture would never contribute to any Q.
    // Refuse it rather than store an inert number. commitment === 0 is always
    // allowed (it clears to unlicensed, meaningful on any venture).
    if (action.commitment > 0 && !venture.resourceType) {
      return { valid: false, reason: `venture ${JSON.stringify(action.ventureId)} has no resourceType — commitment is summed over mines only, so a non-zero commitment here would be silently inert` };
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
    // MINES ONLY, for a mechanical reason and not a design one: the §5 window accrual
    // sums the aggregate target `Q` over ventures with a `resourceType` (production.js),
    // so a factory's commitment would never accrue, never be delivered, and never be
    // judged — it would be a licence that silently could not be met. Licensing a
    // recipe venture needs the accrual extended first (deferred, flagged in the build
    // note). Refuse it loudly rather than sell terms that cannot be honoured.
    if (!venture.resourceType) {
      return { valid: false, reason: `venture ${JSON.stringify(action.ventureId)} is not a mining venture — the §5 window accrual sums commitment over mines only, so a factory licence could never be delivered or judged (deferred, Slice 3b+)` };
    }
    // Fuel is a Syndicate MONOPOLY with no guild licence to price (§8, §5 "Fuel is
    // excluded"). `deuterium_fuel` is not minable so no node can produce it, but the
    // exclusion is stated here rather than left to be implied elsewhere.
    if (isFuel(venture.resourceType)) {
      return { valid: false, reason: `${JSON.stringify(venture.resourceType)} is Syndicate-regulated — fuel carries no venture licence (§8)` };
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
    if (postedPrice(state, venture.resourceType) == null) {
      return { valid: false, reason: `${JSON.stringify(venture.resourceType)} has no posted price to lock the fee against` };
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
    // Stamp each inline venture's denormalised systemId from its site (ruling B1,
    // §15.2) — the pool key production deposits into. This mirrors what
    // establishVenture does; without it an inline-founded mine would pool its
    // goods under a `null` system instead of the one its node sits in. (The flat
    // guild total is unaffected either way — guildTotals sums across pools — but
    // the per-system breakdown, and any consumer keyed by system, must be right.)
    const ventures = (action.ventures || []).map((v) => {
      if (v.systemId != null || v.siteId == null) return v;
      const site = getSite(v.siteId);
      return site ? { ...v, systemId: site.systemId } : v;
    });
    const guild = createGuild({
      id: action.guildId,
      name: action.name,
      isBot: action.isBot,
      credits: action.credits,
      fuelHoard: 0, // always 0 -- see createFoundGuildAction's note
      influence: action.influence,
      incomeRate: action.incomeRate,
      homeSystemId: action.homeSystemId,
      homePlanetId,
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
    guild.ventures.push(createVenture({
      id: action.ventureId,
      ownerGuildId: action.guildId,
      type: action.ventureType || 'mining',
      siteId: action.siteId,
      systemId: site ? site.systemId : null,
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
    // no credits/fuel. It DELIBERATELY does not set committedFromTick (leaving it
    // absent keeps windowFraction == 1, the deferred mid-window pro-rate staying
    // green) and does not stamp updatedAtTick — the sibling owned-state actions
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
    // and timing your lock". Moves NO credits: 3b-ii debits the fee at a boundary.
    const guild = findGuild(next, action.guildId);
    const venture = guild.ventures.find((v) => v.id === action.ventureId);
    const good = venture.resourceType;
    const lockedPrice = postedPrice(next, good);
    // The window the terms are measured over: the engine-wide `state.windowN`, or the
    // flagged fallback the resolver itself uses when a scenario sets none — the same
    // number, read the same way, so the licence can never be priced over a different
    // window than the one its commitment accrues in.
    const windowN = next.windowN == null ? FIRST_CUT_WINDOW_N : next.windowN;
    const baselineUnitsPerTick = baselineOutputFor(venture).units;

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
  validateAction,
  applyAction,
  intake,
};
