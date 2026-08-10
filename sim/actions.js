'use strict';

const { createGuild, createVenture } = require('./state.js');
const { isStarterSystem, getTerranHomeworld, getSite } = require('./seed.js');
const { getRecipe } = require('./recipes.js');
const { isStockpileGood } = require('./resources.js');
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
  guildId, ventureId, type = 'mining', siteId, resourceType, recipeId, productionRate,
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
  return { type: 'establishVenture', guildId, ventureId, ventureType: type, siteId, resourceType, recipeId, productionRate };
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
        // Each field is validated only WHERE PRESENT — a partial patch (e.g. just
        // downstreamPct) is legal and merges over the good's stored entry (§15.4).
        if (policy.order !== undefined && !isValidOrder(policy.order)) {
          return { valid: false, reason: `order for good ${JSON.stringify(good)} must be a permutation of ["syndicate","downstream","stockpile"]` };
        }
        if (policy.downstreamPct !== undefined && !isIntInRange(policy.downstreamPct, 0, 100)) {
          return { valid: false, reason: `downstreamPct for good ${JSON.stringify(good)} must be an integer 0..100 (§15.2)` };
        }
        // reserveLevel (§5 one-pot distribution, Slice A): the quantity the Reserve
        // claimant holds back at its priority slot — an integer ≥ 0. Replaces the
        // old stockpile {mode,value} fork amount and the separate reserveFloor.
        if (policy.reserveLevel !== undefined
            && (typeof policy.reserveLevel !== 'number' || !Number.isInteger(policy.reserveLevel) || policy.reserveLevel < 0)) {
          return { valid: false, reason: `reserveLevel for good ${JSON.stringify(good)} must be a non-negative integer (§15.2)` };
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
  validateAction,
  applyAction,
  intake,
};
