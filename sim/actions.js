'use strict';

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
  validateAction,
  applyAction,
  intake,
};
