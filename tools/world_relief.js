'use strict';

// tools/world_relief.js — the WORLD driver for the supply-relief scenario.
//
// A world driver is a scheduled-events function: a PURE function of
// (snapshot, producingTick) that returns the actions the WORLD (not the guild)
// submits for that tick, plus a plain-language record of what it did. It is the
// harness's model of "things that happen TO the guild" — here, exactly one
// event: a supply RELIEF at a chosen tick.
//
// At tick T it emits a createEstablishVentureAction for a SECOND titanium mine on
// another valid titanium node in the SAME system as the committed mine. Because
// resources are system-scoped (ruling B1, §15.2), the new mine's output pools
// with the first, so the titanium available to the licence + the refinery jumps
// — the squeeze eases. Establishing a mining venture makes it produce on the very
// tick it lands (intake runs before the tick), so the relief takes effect at T.
//
// DETERMINISM: the fire condition is `producingTick === atTick`, pure arithmetic
// on the tick the recorder passes — no wall-clock, no randomness, no internal
// mutable state — so a run reproduces byte-for-byte. It fires exactly once.

const { createEstablishVentureAction } = require('../sim/actions.js');

// makeReliefWorld(config) -> a world driver worldDriver(snapshot, producingTick).
//   config: { atTick, guildId, ventureId, siteId, resourceType, productionRate }
// Returns { actions, events }:
//   actions: the actions to submit this tick (empty except at `atTick`).
//   events:  a list of { tick, kind, detail } describing what the world did, for
//            the trace's `worldEvents` field (so a reader sees the perturbation).
function makeReliefWorld(config) {
  const {
    atTick, guildId, ventureId, siteId, resourceType, productionRate,
  } = config;

  return function worldDriver(_snapshot, producingTick) {
    if (producingTick !== atTick) return { actions: [], events: [] };

    const action = createEstablishVentureAction({
      guildId, ventureId, type: 'mining', siteId, resourceType, productionRate,
    });
    return {
      actions: [action],
      events: [{
        tick: producingTick,
        kind: 'supply_relief',
        detail: {
          establishedVenture: ventureId,
          siteId,
          resourceType,
          productionRate,
          note: `second ${resourceType} mine established — output pools with the committed mine (ruling B1)`,
        },
      }],
    };
  };
}

module.exports = { makeReliefWorld };
