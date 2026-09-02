'use strict';

// Tests sim/snapshot.js — the developer state inspector's data source.
//
// The point of these tests is ONE tripwire: the snapshot must never disagree
// with the engine's own selectors. If buildSnapshot ever reports a total the
// live state doesn't actually hold, the inspector would quietly lie to the
// human about the economy — so we pin every number in the snapshot to
// computeGalacticSupply / computeOccupancy / getSite and fail loudly on drift.
//
// Uses real seed ids: pl_00001_n02 is a titanium node (same node the demo and
// the occupancy tests seat a mine on).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { HOME_SYSTEM, HOME_PLANET } = require('./home-anchor.js');

const { createState } = require('../state.js');
const { computeGalacticSupply } = require('../supply.js');
const { computeOccupancy } = require('../occupancy.js');
const { getSite } = require('../seed.js');
const { buildSnapshot, SNAPSHOT_SCHEMA } = require('../snapshot.js');
const { guildTotals } = require('../stock.js');
const { PRICED_GOODS } = require('../prices.js');
const { FUEL_GOOD, TIER3_GOODS } = require('../resources.js');
const { baselineUnitsForGood } = require('../baseline.js');
const { hashState } = require('../serialize.js');

// A state with two guilds, real stockpiles, fuel in both the reserve and a
// guild hoard, and one seated titanium mine — enough to exercise every branch.
function sampleState() {
  return createState({
    guilds: [
      {
        id: 'player-guild',
        name: 'Player Guild',
        credits: 120,
        fuelHoard: 4,
        influence: 100,
        homeSystemId: HOME_SYSTEM,
        homePlanetId: HOME_PLANET,
        stockpiles: { [HOME_SYSTEM]: { titanium: 15, lead: 3 } },
        ventures: [
          { id: 'mine_1', ownerGuildId: 'player-guild', type: 'mining', siteId: 'pl_00001_n02', resourceType: 'titanium', productionRate: 5 },
        ],
      },
      { id: 'bot_a', name: 'Bot A', isBot: true, credits: 80, fuelHoard: 1, stockpiles: { sysB: { titanium: 5 } } },
    ],
    reserve: { reserveLevel: 30 },
    syndicate: { ledger: -200 },
    claims: [
      { claimId: 'claim_citadel', ownerGuildId: 'syndicate', landmarkId: 'citadel', landmarkKind: 'citadel', claimedAtTick: 0, contested: false },
      { claimId: 'claim_home_player-guild', ownerGuildId: 'player-guild', landmarkId: HOME_SYSTEM, landmarkKind: 'system', claimedAtTick: 0, contested: false },
    ],
  });
}

test('snapshot header echoes schema, tick, and Syndicate ledger', () => {
  const s = sampleState();
  const snap = buildSnapshot(s);
  assert.equal(snap.schemaVersion, SNAPSHOT_SCHEMA);
  assert.equal(snap.tick, s.tick);
  assert.equal(snap.syndicate.ledger, s.syndicate.ledger);
});

test('galactic resource totals equal computeGalacticSupply exactly', () => {
  const s = sampleState();
  const snap = buildSnapshot(s);
  assert.deepEqual(snap.galacticSupply.resources, computeGalacticSupply(s).resources);
});

test('each good total equals the sum of that good across guild stockpiles', () => {
  // The drift tripwire spelled out: the snapshot cannot report a total the
  // guilds do not actually hold between them.
  const s = sampleState();
  const snap = buildSnapshot(s);
  for (const good of Object.keys(snap.galacticSupply.resources)) {
    const summed = s.guilds.reduce((n, g) => n + (guildTotals(g)[good] || 0), 0);
    assert.equal(snap.galacticSupply.resources[good], summed, `total for ${good} drifted`);
  }
});

test('fuel is reported specially: reserve, guildHeld, and their sum', () => {
  const s = sampleState();
  const snap = buildSnapshot(s);
  const supply = computeGalacticSupply(s);
  assert.equal(snap.galacticSupply.fuel.reserve, supply.fuel.reserve); // 30
  assert.equal(snap.galacticSupply.fuel.guildHeld, supply.fuel.guildHeld); // 4 + 1
  assert.equal(
    snap.galacticSupply.fuel.total,
    supply.fuel.reserve + supply.fuel.guildHeld,
  );
});

test('occupancy map equals computeOccupancy', () => {
  const s = sampleState();
  assert.deepEqual(buildSnapshot(s).occupancy, computeOccupancy(s));
});

test('each seated venture carries its seed site resolved by getSite', () => {
  const s = sampleState();
  const snap = buildSnapshot(s);
  const v = snap.ventures.find((x) => x.id === 'mine_1');
  const site = getSite('pl_00001_n02');
  assert.equal(v.siteId, 'pl_00001_n02');
  assert.equal(v.site.kind, site.kind); // 'resource'
  assert.equal(v.site.planetId, site.planetId); // pl_00001
  assert.equal(v.site.resourceType, site.resourceType); // titanium
});

test('a seated venture carries its site\'s FRIENDLY NAME, derived from the seed', () => {
  // The console shows this instead of `pl_00001_n02` (28-08-26). It is the seed's own
  // derivation, copied through — the browser is not allowed to build it (§5's display rule).
  const s = sampleState();
  const snap = buildSnapshot(s);
  const v = snap.ventures.find((x) => x.id === 'mine_1');
  assert.equal(v.site.name, getSite('pl_00001_n02').name);
  assert.match(v.site.name, /^\S+ [IVX]+ · Node 2$/, 'system, Roman planet ordinal, node');
});

test('the pre-game tick 0 shows a blank calendar label, not `00-1:1439`', () => {
  // A galaxy created and not yet ticked is a state an operator really does look at.
  // `day`/`minute` stay the exact arithmetic beside it; only the LABEL is blanked.
  const snap = buildSnapshot(createState({ guilds: [], reserve: { reserveLevel: 0 }, syndicate: { ledger: 0 } }));
  assert.equal(snap.tick, 0);
  assert.equal(snap.calendar.label, '—');
  assert.equal(snap.calendar.day, -1, 'the arithmetic is untouched — only the display is guarded');
});

test('guild breakdown copies the shown fields and does not alias live state', () => {
  const s = sampleState();
  const snap = buildSnapshot(s);
  const p = snap.guilds.find((g) => g.id === 'player-guild');
  assert.equal(p.credits, 120);
  assert.equal(p.fuelHoard, 4);
  assert.equal(p.influence, 100);
  assert.equal(p.homeSystemId, HOME_SYSTEM);
  assert.equal(p.homePlanetId, HOME_PLANET);
  assert.deepEqual(p.stockpiles, { titanium: 15, lead: 3 });
  // Mutating the snapshot must not reach back into the state's stockpiles.
  p.stockpiles.titanium = 999;
  assert.equal(guildTotals(s.guilds.find((g) => g.id === 'player-guild')).titanium, 15);
});

test('guild carries a per-system stockpile breakdown (ruling B1), beside the flat total', () => {
  // The Production view needs a system's OWN holdings, so the snapshot exposes
  // the nested pools (systemId -> good -> int) as well as the flat guild total.
  const s = sampleState();
  const snap = buildSnapshot(s);
  const p = snap.guilds.find((g) => g.id === 'player-guild');
  assert.deepEqual(p.stockpilesBySystem, { [HOME_SYSTEM]: { titanium: 15, lead: 3 } });
  // The flat total is still the SUM across systems, unchanged for existing readers.
  assert.deepEqual(p.stockpiles, guildTotals(s.guilds.find((g) => g.id === 'player-guild')));
  const bot = snap.guilds.find((g) => g.id === 'bot_a');
  assert.deepEqual(bot.stockpilesBySystem, { sysB: { titanium: 5 } });
  // A deep-enough copy: mutating the snapshot must not reach into live state.
  p.stockpilesBySystem[HOME_SYSTEM].titanium = 999;
  assert.equal(guildTotals(s.guilds.find((g) => g.id === 'player-guild')).titanium, 15);
});

test('each venture carries its systemId and the reserved syndicateCommitment (0/unlicensed)', () => {
  const s = sampleState();
  const snap = buildSnapshot(s);
  const v = snap.ventures.find((x) => x.id === 'mine_1');
  // systemId is exposed top-level so the Production view can group by system;
  // here it resolves to the seated site's system.
  assert.equal(v.systemId, getSite('pl_00001_n02').systemId);
  // The placeholder is present and 0 for every venture today — no licence exists.
  assert.equal(v.syndicateCommitment, 0);
  for (const anyV of snap.ventures) {
    assert.equal(anyV.syndicateCommitment, 0, 'every venture is unlicensed (0) today');
  }
});

test('claims carry their seed landmark resolved, in order', () => {
  const s = sampleState();
  const snap = buildSnapshot(s);
  assert.equal(snap.claims.length, 2);
  const home = snap.claims.find((c) => c.claimId === 'claim_home_player-guild');
  assert.equal(home.ownerGuildId, 'player-guild');
  assert.equal(home.landmarkId, HOME_SYSTEM);
  assert.equal(home.landmarkKind, 'system');
  assert.ok(home.landmark, 'the home system landmark must resolve');
  assert.equal(home.landmark.kind, 'system');
  const citadel = snap.claims.find((c) => c.claimId === 'claim_citadel');
  assert.equal(citadel.landmark.kind, 'citadel');
});

test('a claim pointing at a missing landmark resolves to null, not a throw', () => {
  const s = createState({
    guilds: [],
    reserve: { reserveLevel: 0 },
    syndicate: { ledger: 0 },
    claims: [
      { claimId: 'c_bad', ownerGuildId: 'syndicate', landmarkId: 'sys_99999', landmarkKind: 'system', claimedAtTick: 0, contested: false },
    ],
  });
  const snap = buildSnapshot(s);
  assert.equal(snap.claims[0].landmark, null);
});

test('an unseated venture resolves to a null site rather than throwing', () => {
  const s = createState({
    guilds: [
      { id: 'g1', credits: 0, fuelHoard: 0, ventures: [
        { id: 'm1', ownerGuildId: 'g1', type: 'mining', resourceType: 'titanium', productionRate: 5 },
      ] },
    ],
    reserve: { reserveLevel: 0 },
    syndicate: { ledger: 0 },
  });
  const v = buildSnapshot(s).ventures.find((x) => x.id === 'm1');
  assert.equal(v.siteId, null);
  assert.equal(v.site, null);
});

// --- schema 7: the §5 Syndicate windowed-accrual telemetry (Slice B-i) ----------

test('snapshot schema is 7', () => {
  assert.equal(SNAPSHOT_SCHEMA, 7);
  assert.equal(buildSnapshot(sampleState()).schemaVersion, 7);
});

test('a committed good surfaces §5 windowed-accrual telemetry in the production block (Slice B-i)', () => {
  // A committed titanium mine (Q=8 over N=4 ⇒ paced 2/tick). After a tick, the snapshot
  // must carry, on that good's production entry, a `window` object with the §5 telemetry
  // — %-achieved, delivered, required-rate, ticks-remaining, resolved send-this-tick,
  // status. It PREVIEWS the next producing tick (delivered 4, the running total after it).
  const { tick } = require('../tick.js');
  let s = createState({
    guilds: [{ id: 'g1', credits: 0, fuelHoard: 0, ventures: [
      { id: 't', ownerGuildId: 'g1', type: 'mining', systemId: 'sysA', resourceType: 'titanium', productionRate: 10, syndicateCommitment: 8 },
    ] }],
    reserve: { reserveLevel: 0 },
    syndicate: { ledger: 0 },
    windowN: 4,
  });
  s = tick(s); // producing tick 1: delivered 2
  const snap = buildSnapshot(s);
  const win = snap.production[0].systems[0].goods.titanium.window;
  assert.equal(win.Q, 8);
  assert.equal(win.sendThisTick, 2, 'the resolved paced send (previewing producing tick 2)');
  assert.equal(win.delivered, 4, 'delivered running total after the previewed tick (2 + 2)');
  assert.equal(win.pctAchieved, 50, '4 of Q 8');
  assert.equal(win.ticksRemaining, 3);
  assert.equal(typeof win.requiredRate, 'number');
  assert.equal(win.status, 'accruing');
});

test('a guild carries its stored productionProfile SPARSE — a set entry present, an unset one absent', () => {
  // A single system with an explicitly-set silica downstream cap and an r_a throttle;
  // copper and r_b are NOT named. The snapshot must echo exactly what is stored
  // (defaults NOT filled in) so slice 2b-ii's controls can tell set from defaulted.
  const s = createState({
    guilds: [{
      id: 'g1', credits: 0, fuelHoard: 0,
      productionProfile: { sysA: {
        goods: { silica: { downstreamPct: 50 } },
        throttles: { r_a: 100 },
      } },
      ventures: [
        { id: 'r_a', ownerGuildId: 'g1', type: 'refining', systemId: 'sysA', recipeId: 'conductive_material', productionRate: 10 },
      ],
    }],
    reserve: { reserveLevel: 0 },
    syndicate: { ledger: 0 },
  });
  const g = buildSnapshot(s).guilds.find((x) => x.id === 'g1');
  // Exactly the stored sparse shape — silica present, copper absent; r_a present, r_b absent.
  assert.deepEqual(g.productionProfile, { sysA: { goods: { silica: { downstreamPct: 50 } }, throttles: { r_a: 100 } } });
  // A deep-enough clone: mutating the snapshot must not reach into engine state.
  g.productionProfile.sysA.throttles.r_a = 999;
  assert.equal(s.guilds[0].productionProfile.sysA.throttles.r_a, 100);
});

test('a guild with no profile carries an empty {} (all-default), not undefined', () => {
  const g = buildSnapshot(sampleState()).guilds.find((x) => x.id === 'player-guild');
  assert.deepEqual(g.productionProfile, {});
});

test('the production block carries the resolved per-good and per-line numbers', () => {
  // fresh silica 10 feeding two consumers (demand 20) under a 30% downstream cap:
  // supplied floor(20*30/100)=6, no stockpile to draw, FCFS gives r_a 6 / r_b 0 —
  // the SAME resolution the tick applies (shared-resolver equality is pinned in
  // production.test.js). r_a runs at a continuous rate 6 (all other inputs plentiful).
  const mine = (id, good, rate) => ({ id, ownerGuildId: 'g1', type: 'mining', systemId: 'sysA', resourceType: good, productionRate: rate });
  const refinery = (id, recipeId, rate) => ({ id, ownerGuildId: 'g1', type: 'refining', systemId: 'sysA', recipeId, productionRate: rate });
  const s = createState({
    guilds: [{
      id: 'g1', credits: 0, fuelHoard: 0,
      productionProfile: { sysA: { goods: { silica: { downstreamPct: 30 } } } },
      ventures: [
        mine('cu', 'copper', 20), mine('si', 'silica', 10),
        mine('ag', 'silver', 20), mine('pd', 'palladium', 20),
        refinery('r_a', 'conductive_material', 10),
        refinery('r_b', 'silicon_wafer', 10),
      ],
    }],
    reserve: { reserveLevel: 0 },
    syndicate: { ledger: 0 },
  });
  const snap = buildSnapshot(s);
  const guildProd = snap.production.find((p) => p.guildId === 'g1');
  const sysReport = guildProd.systems.find((r) => r.systemId === 'sysA');
  assert.equal(sysReport.goods.silica.fresh, 10);
  assert.equal(sysReport.goods.silica.demand, 20);
  assert.equal(sysReport.goods.silica.supplied, 6);
  const la = sysReport.lines.find((l) => l.good === 'silica' && l.ventureId === 'r_a');
  assert.equal(la.alloc, 6);
  assert.equal(sysReport.refineries.find((r) => r.ventureId === 'r_a').rate, 6);
  assert.equal(sysReport.refineries.find((r) => r.ventureId === 'r_b').rate, 0);
});


// --- feeQuote: the per-good BASIC licence fee, in credits -------------------------
//
// The shape half of the guarantee. The equality that makes the number TRUSTWORTHY —
// `feeQuote[G]` is exactly what `applyForLicence` locks for a venture producing G — is
// pinned in licence-fee.test.js, beside the fee math it must not drift from.

test('feeQuote keys are exactly the priced goods that something can produce', () => {
  const quote = buildSnapshot(sampleState()).feeQuote;
  // Today that is EVERY priced good: `BASELINE_KEYS`' drift guard already requires an
  // entry per raw resource and per recipe, so nothing priced is unproducible. The
  // omission rule is asserted below on the cases that DO lack a baseline.
  assert.deepEqual(Object.keys(quote), [...PRICED_GOODS],
    'one row per priced good, in the module’s sorted order (invariant 9)');
  for (const [good, fee] of Object.entries(quote)) {
    assert.ok(Number.isInteger(fee) && fee > 0, `${good}: integer credits (§15.2), got ${fee}`);
  }
});

test('nothing unproducible or unpriced is quoted — fuel and the Tier-3 placeholders are absent', () => {
  const quote = buildSnapshot(sampleState()).feeQuote;
  // Fuel is never priced (§8) and no venture outputs it, so it has no licence to quote.
  assert.equal(FUEL_GOOD in quote, false);
  assert.equal(baselineUnitsForGood(FUEL_GOOD), null);
  // The Tier-3 catalog entries carry no recipe and no price — a fee quoted for them would
  // be a number invented for a good nothing can make.
  for (const good of TIER3_GOODS) {
    assert.equal(good in quote, false, `${good} has no recipe yet`);
    assert.equal(baselineUnitsForGood(good), null);
  }
});

test('a good with no price row is OMITTED, not quoted at zero', () => {
  // A hand-built state whose price block lost a row (a fee of 0 there would read as "this
  // licence is free" — a silent lie, which §15.5 ranks worse than an absent field).
  const s = sampleState();
  delete s.prices.gold;
  const quote = buildSnapshot(s).feeQuote;
  assert.equal('gold' in quote, false);
  assert.ok(quote.titanium > 0, 'and every other good still quotes');
});

test('feeQuote is a pure read — it mutates nothing and serialises deterministically', () => {
  const s = sampleState();
  const before = hashState(s);
  const a = JSON.stringify(buildSnapshot(s).feeQuote);
  const b = JSON.stringify(buildSnapshot(s).feeQuote);
  assert.equal(hashState(s), before, 'building a snapshot changes no engine state');
  assert.equal(a, b, 'same state, byte-identical bytes');
});
