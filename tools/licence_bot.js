'use strict';

// tools/licence_bot.js — the BOT driver: a "licence-first reactive allocator".
//
// A bot driver is a PURE function of (snapshot, config) -> { actions, reasonTag,
// sensed }. It is a PLAYER, not the engine (§18): it senses the same read-only
// snapshot a human would, decides its own moves, and submits them as ordinary
// validated `setProductionProfile` actions. It computes no engine number and
// mutates no state — it only reads the engine's own resolved telemetry (§5
// display rule) and reacts. Determinism falls out for free: same snapshot in,
// same actions out, no wall-clock, no randomness.
//
// THE STRATEGY (one committed good, one system):
//   1. SENSE the committed good's window telemetry (paced required-rate, delivered,
//      Q, ticks-remaining, projected send + status) and its fresh production and
//      full-tilt refinery demand.
//   2. GUARANTEE THE LICENCE ON PACE by LEANING ON the engine's self-correcting
//      paced send: it keeps the Syndicate fork PACED (never sets `syndicate`, so
//      the default paced required-rate stands) and ranks Syndicate FIRST in the
//      Gate-1 order. It does not fight the pace with per-tick send swings — the
//      engine's paced send already self-corrects; the bot just anchors on it.
//   3. FEED THE FACTORY the residual: it leaves `downstreamPct` at its 100 default
//      and ranks the factory (downstream) LAST, so the refinery gets whatever
//      titanium the paced licence draw and the reserve floor leave.
//   4. MANAGE RESERVE as a buffer: it ranks the reserve (stockpile) SECOND — an
//      active floor between the licence and the factory — and sets `reserveLevel`
//      to the genuine surplus only (min of a modest buffer and fresh − licence −
//      factory demand). When fresh is scarce the surplus is negative, so the floor
//      drops to 0: the reserve is RELEASED and the factory may draw the banked
//      titanium out of the one pot (§5 one-pot: consumers draw reserve0 + fresh),
//      so it never needlessly starves. Reserve can never feed the licence (the
//      Syndicate fork is FRESH-ONLY), so the buffer only ever protects the factory.
//   5. DETECT infeasibility: if the paced required-rate exceeds the fresh titanium
//      available, the mine structurally cannot meet Q; the bot records that in the
//      reasonTag and stays licence-first rather than thrashing.
//
// STABILITY: the bot emits an action only when its computed policy differs from
// what is already stored (read from the snapshot's sparse productionProfile), so a
// steady state produces NO action — the standing policy just runs.

const { createSetProductionProfileAction } = require('../sim/actions.js');

// Licence first, then the reserve floor, then the factory residual. Ranking the
// Syndicate fork FIRST is what puts the paced licence draw ahead of everything;
// ranking the reserve (stockpile) before downstream is what makes reserveLevel an
// ACTIVE floor the bot can raise to bank surplus or drop to feed the factory.
const LICENCE_FIRST_ORDER = Object.freeze(['syndicate', 'stockpile', 'downstream']);

function arraysEqual(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  return a.every((x, i) => x === b[i]);
}

// The guild's stored per-good policy in this system, sparse (absent fields mean
// their §15.4 defaults). Read straight from the snapshot — the bot never reaches
// into engine state, only the read-only view.
function storedGoodPolicy(snapshot, guildId, systemId, good) {
  const guild = (snapshot.guilds || []).find((g) => g.id === guildId);
  const profile = guild && guild.productionProfile;
  const entry = profile && profile[systemId] && profile[systemId].goods && profile[systemId].goods[good];
  return entry || {};
}

// The resolved production report for (guildId, systemId), from the snapshot's
// `production` block (engine truth — the SAME resolver the tick applies).
function findReport(snapshot, guildId, systemId) {
  const g = (snapshot.production || []).find((p) => p.guildId === guildId);
  if (!g) return null;
  return (g.systems || []).find((s) => s.systemId === systemId) || null;
}

// makeLicenceBot(config) -> a bot driver bot(snapshot).
//   config: { guildId, systemId, committedGood, reserveBuffer }
function makeLicenceBot(config) {
  const {
    guildId, systemId, committedGood, reserveBuffer = 0,
  } = config;

  return function bot(snapshot) {
    const report = findReport(snapshot, guildId, systemId);
    const goodEntry = report && report.goods && report.goods[committedGood];
    if (!goodEntry) {
      // Nothing produced/committed for the sensed good yet — hold, don't invent.
      return { actions: [], reasonTag: 'idle: no committed good sensed', sensed: null };
    }

    const fresh = goodEntry.fresh || 0;
    const factoryDemand = goodEntry.demand || 0; // Gate-2 naive full-tilt titanium demand
    const win = goodEntry.window || null; // present only for a committed good (Q > 0)
    const requiredRate = win ? win.requiredRate : 0; // the paced pace (float)
    const sendThisTick = win ? win.sendThisTick : 0; // the licence's actual whole-unit draw this tick
    const status = win ? win.status : 'unlicensed';

    // Surplus titanium above what the licence draws and the factory can use at
    // full tilt — the only titanium worth banking. Negative under the squeeze.
    const surplus = fresh - sendThisTick - factoryDemand;
    const desiredReserveLevel = Math.max(0, Math.min(reserveBuffer, surplus));

    // Structural infeasibility (§18 "handle it explicitly"): the licence is FRESH-
    // ONLY, so if the paced required-rate exceeds the fresh titanium the mine makes,
    // even sending ALL fresh cannot hold the pace — Q is structurally unreachable.
    const licenceAtRisk = win != null && requiredRate > fresh;

    // Compare the desired standing policy to what is already stored (sparse), and
    // patch only what differs — a steady state emits no action.
    const stored = storedGoodPolicy(snapshot, guildId, systemId, committedGood);
    const goodPatch = {};
    if (!arraysEqual(stored.order, LICENCE_FIRST_ORDER)) {
      goodPatch.order = [...LICENCE_FIRST_ORDER];
    }
    const storedReserve = stored.reserveLevel === undefined ? 0 : stored.reserveLevel;
    if (storedReserve !== desiredReserveLevel) {
      goodPatch.reserveLevel = desiredReserveLevel;
    }
    // NOTE: `downstreamPct` is left at its 100 default (feed the factory fully) and
    // `syndicate` is never set (so the paced required-rate stands) — the two "leave
    // it to the engine" halves of leaning on the self-correcting pace.

    const actions = [];
    if (Object.keys(goodPatch).length > 0) {
      actions.push(createSetProductionProfileAction({
        guildId, systemId, goods: { [committedGood]: goodPatch },
      }));
    }

    // A compact, human-readable reasoning tag (the trace's `botDecisions.reasonTag`).
    let reasonTag;
    if (licenceAtRisk) {
      reasonTag = `AT-RISK licence-first: pace ${requiredRate.toFixed(2)} > fresh ${fresh} `
        + `(mine cannot meet Q=${win.Q}); reserve→${desiredReserveLevel}, factory takes residual`;
    } else if (surplus > 0) {
      reasonTag = `relief: fresh ${fresh} ample (send ${sendThisTick} + demand ${factoryDemand}); `
        + `banking reserve→${desiredReserveLevel}, factory full`;
    } else {
      reasonTag = `squeeze: fresh ${fresh} tight (send ${sendThisTick} + demand ${factoryDemand}); `
        + `reserve released→0, factory takes residual`;
    }

    return {
      actions,
      reasonTag,
      // A small structured record of what the bot keyed on — aids run analysis and
      // makes the trace self-explaining without re-deriving anything.
      sensed: {
        good: committedGood,
        fresh,
        factoryDemand,
        sendThisTick,
        requiredRate,
        surplus,
        desiredReserveLevel,
        licenceStatus: status,
        licenceAtRisk,
      },
    };
  };
}

module.exports = { makeLicenceBot, LICENCE_FIRST_ORDER };
