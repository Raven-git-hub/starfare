'use strict';

const { createGuild } = require('./state.js');
const { isStarterSystem, getTerranHomeworld } = require('./seed.js');

// actions.js — action constructors, and the validate-as-they-arrive intake
// discipline (design.md §15.6). This is the guard against the game's own
// named failure mode: "a guild with 100 credits gets three 'spend 80' orders
// all approved" if you validate a batch against one stale snapshot. The fix
// is sequential: validate each action against state-as-it-stands — start-of-
// batch PLUS every action already accepted earlier in this same batch — and
// apply it immediately if it passes. Contested claims resolve first-valid-
// wins under the same discipline (not exercised yet: no claims exist).
//
// SCOPE, deliberately thin: exactly ONE concrete action type —
// `paySyndicateFee` — a guild paying credits into the Syndicate ledger. It's
// grounded in fields that already exist (guild.credits, syndicate.ledger)
// and satisfies invariant 2 on its own (credits move, none are minted or
// destroyed), so it needs no economy.js/territory.js to mean something.
// Every OTHER action type design.md eventually needs (placing an order,
// setting a toll, casting a vote, claiming territory) waits for the module
// that would actually give it an effect — inventing them now would mean
// guessing at economy.js's shape before economy.js exists.

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

// --- Validation -------------------------------------------------------

function findGuild(state, guildId) {
  return state.guilds.find((g) => g.id === guildId);
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
      ventures: action.ventures,
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
  validateAction,
  applyAction,
  intake,
};
