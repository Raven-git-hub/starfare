'use strict';

// starter-package.js — the HUMAN founding starter package (design.md §13 "The human founding
// starter package", RULED 04-10-26; numbers in docs/phase-1-tuning.md "Guild starts").
//
// A guild founded by a human (`isBot === false`) opens with more than the bare founding: a
// larger credit grant in place of the caller's `credits`, plus a small free fleet and one
// undeployed Outpost kit, all idle at its home system. A BOT founding gets none of it — it keeps
// the bare founding exactly as before. The `foundGuild` apply (sim/actions.js) reads this file;
// nothing else does.
//
// WHY A MODULE OF ITS OWN: a constant lives in the module that owns the rule it belongs to
// (sim/fuel.js's note). This rule is "what a human founding is granted", so it gets one small
// home and every number lives here ONCE. The starter MACHINES (15 miners + 10 factories) are a
// different, older rule that applies to every founding, and stay in sim/assets.js.
//
// Every number below is `[FIRST-CUT]` and was GIVEN by the human (the design room, 04-10-26).
// None is chosen in code.

const { HEAVY_TRANSPORT, LIGHT_TRANSPORT } = require('./vehicles.js');
const { ASSET_CONDITION_NEW } = require('./assets.js');

// The credits a HUMAN guild is founded with. It REPLACES the founding action's `credits` for a
// human; a bot still gets its `credits` (2,000 from tools/admin.js today). It is funded the way
// every founding grant is: DEBITED from the Syndicate ledger, so nothing is minted and invariant 2
// still nets to zero. The debit is just larger.
const STARTER_HUMAN_CREDITS = 8_000_000;

// The starter heavy's maintenanceCondition. NOT from the 04-10-26 ruling, which says nothing about
// condition. It is the figure docs/territory-model.md §7 already ruled for the founding heavy
// ("starting maintenanceCondition 0.5 — inert until the maintenance slice"), and phase-1-tuning.md
// §"Guild transports" repeats it. Condition is read by nothing yet except the client's % display,
// so this is cosmetic for now. It is on the decision checklist to confirm.
const STARTER_HEAVY_CONDITION = 0.5;

// The free craft, IN MINT ORDER: 1 heavy transport, then 3 light transports. Minting in this fixed
// order is what makes the ids deterministic (invariant 9): on a fresh guild the heavy is always
// `vehicle_<guild>_heavyTransport_01` and the lights `_02`, `_03`, `_04`. Written out one craft per
// line, not as counts, so the fleet can be read off at a glance.
const STARTER_HUMAN_FLEET = Object.freeze([
  Object.freeze({ class: HEAVY_TRANSPORT, condition: STARTER_HEAVY_CONDITION }),
  Object.freeze({ class: LIGHT_TRANSPORT, condition: ASSET_CONDITION_NEW }),
  Object.freeze({ class: LIGHT_TRANSPORT, condition: ASSET_CONDITION_NEW }),
  Object.freeze({ class: LIGHT_TRANSPORT, condition: ASSET_CONDITION_NEW }),
]);

// The free kits, in mint order: one undeployed Outpost kit, an idle asset in the guild's inventory.
// Only the heavy has the hold to carry it (sim/fuel.js ASSET_CARGO_VOLUME = HEAVY_HOLD), which is
// why the fleet above includes one.
const STARTER_HUMAN_KITS = Object.freeze(['outpost']);

// foundingCreditsFor(action) -> the credits a `foundGuild` action founds its guild with: the
// starter figure for a human, the action's own `credits` for a bot. The ONE place the choice is
// made, so the guild's credits and the ledger debit in the apply can never disagree (invariant 2).
// `!action.isBot` treats an absent `isBot` as human, exactly as createGuild defaults it to false.
function foundingCreditsFor(action) {
  return action.isBot ? action.credits : STARTER_HUMAN_CREDITS;
}

module.exports = {
  STARTER_HUMAN_CREDITS,
  STARTER_HEAVY_CONDITION,
  STARTER_HUMAN_FLEET,
  STARTER_HUMAN_KITS,
  foundingCreditsFor,
};
