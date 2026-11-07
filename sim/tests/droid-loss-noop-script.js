'use strict';

// droid-loss-noop-script.js — two runs whose hashes were RECORDED AT 1cfea14 (the branch base, before the "droids and
// losing a system" slice, docs/droids.md §14) and are pinned in droid-system-loss.test.js. The slice touches three
// places: evictSystem (it now destroys the guild's droids in the lost system), the droid-batch arrival (a batch bound
// for a system no longer held is forfeit) and checkDroids (three new halts). Where none of those has anything to do,
// the galaxy must serialize byte for byte as before:
//   - heldLanding(): a Syndicate batch of 5 lands in a system the buyer still HOLDS (the arrival's normal path), with
//     guild droids granted beside it, run past the landing (tick 900) — no system is ever lost;
//   - droidlessLoss(): g1 holds TARGET, keeps droids at HOME only, strands a miner in TARGET and abandons it — a
//     system IS lost, but no droid stood in it and no batch was bound for it, so the system_lost payload carries no
//     droid field and nothing else moves.
// Every invariant is asserted after every action (accept) and every tick (ticks → advance).
//
// Uses only engine API that existed at 1cfea14, so the same file ran there to record the hashes.

const {
  createBuyDroidBatchAction, createGrantDroidAction, createGrantAssetAction, createAbandonPrefectureAction,
} = require('../actions.js');
const P = require('./prefecture-fixtures.js');

const { HOME, TARGET, PLANET_A, SLOT_A1, accept, ticks } = P;

function heldLanding() {
  let s = P.kitGalaxy({ credits: 1_000_000, fuelHoard: 1_000 });
  s = accept(s, createGrantDroidAction({ systemId: HOME.id, source: 'guild', count: 2 }));
  s = accept(s, createBuyDroidBatchAction({ guildId: 'g1', batch: 5, destinationSystemId: HOME.id }));
  return ticks(s, 1000); // the HOME leg lands it at tick 900
}

function droidlessLoss() {
  let { s, kitId } = P.ferried({ credits: 1_000_000 });
  s = P.survey(s, 'g1', PLANET_A);
  s = accept(s, P.plant('g1', kitId, SLOT_A1));
  s = accept(s, createGrantDroidAction({ systemId: HOME.id, source: 'syndicate', count: 3 }));
  s = accept(s, createGrantAssetAction({ guildId: 'g1', kind: 'miner', systemId: TARGET }));
  s = ticks(s, 10);
  s = accept(s, createAbandonPrefectureAction({ guildId: 'g1', prefectureId: 'prefecture_g1_01' }));
  return ticks(s, 20);
}

module.exports = { heldLanding, droidlessLoss };
