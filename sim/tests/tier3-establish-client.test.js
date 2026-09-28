'use strict';

// tier3-establish-client.test.js — the Tier-3 fork of the Establish-Venture popup (Tier-3 economy,
// client slice; docs/tier3-timed-production.md "As built — the client").
//
// The popup must offer a Tier-3 licence as `x` WHOLE units of the venture's weekly output `y`, on a
// fixed one-week term, and send `applyForLicence { committedUnits: x }` (Slice 3c's shape). It may
// compute no game number itself (design.md §5's display rule), and before this slice nothing it
// read said which goods are timed, or what `y` and `floor(y)` are. So the snapshot gained ONE
// additive, derived field, `tier3Contract`: per timed good, `{ weeklyOutput, committedUnitsCeiling,
// termDays }`. These tests pin that field to the engine functions it must agree with:
//   1. it lists exactly the timed goods, and its `y`, `floor(y)` and term are the ones the signing
//      itself uses — a licence at `x = floor(y)` is accepted and stores `x / y`, one more is refused;
//   2. its term in days is the one the renegotiation schedule counts a signed licence in, at the
//      ruled day and at a 60-tick day;
//   3. it is omitted where no Tier-3 licence can be signed (a day that does not divide the week);
//   4. it is derived only — building a snapshot moves no state byte, and it is deterministic;
//   5. END TO END over HTTP, on the real seeded galaxy: the exact actions the popup posts for a
//      Tier-3 deploy are ACCEPTED, and the old Tier-1/2 shape the popup used to send is REFUSED.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { createState } = require('../state.js');
const { intake, validateAction, createApplyForLicenceAction } = require('../actions.js');
const { hashState } = require('../serialize.js');
const { buildSnapshot } = require('../snapshot.js');
const { ticksPerUnitFor } = require('../baseline.js');
const { TIER3_GOODS, PROCESSED_GOODS, RAW_RESOURCES } = require('../resources.js');
const { renegotiationScheduleFor } = require('../licence.js');
const { dayOf } = require('../calendar.js');
const { makeServer } = require('../server.js');
const { HOME_SYSTEM, HOME_SLOT } = require('./home-anchor.js');

const SYS = 'sysA';
const WEEK = 10080;   // docs/tier3-timed-production.md: "exactly one 7-day window (10,080 ticks)"
const DAY = 1440;     // docs/cycle-and-calendar.md: the ruled day

// The timed goods, and `y` typed from the doc's formula `y = 10,080 ÷ TICKS_PER_UNIT` (not read
// off the snapshot code under test).
const TIMED = TIER3_GOODS.filter((g) => ticksPerUnitFor(g) !== null);
const yOf = (good) => WEEK / ticksPerUnitFor(good);

const factory = (id, ownerGuildId, recipeId) => ({
  id, ownerGuildId, type: 'refining', systemId: SYS, recipeId, productionRate: 5,
});
function galaxy(ventures, extra = {}) {
  return createState({
    guilds: [{ id: 'g1', credits: 0, fuelHoard: 0, stockpiles: { [SYS]: {} }, ventures }],
    reserve: { reserveLevel: 0 }, syndicate: { ledger: 0 }, ...extra,
  });
}
const units = (ventureId, committedUnits) => createApplyForLicenceAction({ guildId: 'g1', ventureId, committedUnits });
const ventureOf = (s, id) => s.guilds[0].ventures.find((v) => v.id === id);

// --- 1. the published contract IS the signing's ----------------------------------------------------

test('HEADLINE: tier3Contract lists exactly the timed goods, and its y, floor(y) and term are the ones a signature uses', () => {
  const s = galaxy(TIMED.map((good) => factory(`f_${good}`, 'g1', good)));
  const snap = buildSnapshot(s);
  assert.deepEqual(Object.keys(snap.tier3Contract).sort(), [...TIMED].sort(), 'the timed goods, and only them');
  assert.equal(TIMED.length, 21);

  for (const good of TIMED) {
    const t = snap.tier3Contract[good];
    const y = yOf(good);
    assert.deepEqual(t, { weeklyOutput: y, committedUnitsCeiling: Math.floor(y), termDays: 7 }, good);

    // The most the popup's slider offers is accepted, and stores the exact ratio x / y …
    const most = validateAction(s, units(`f_${good}`, t.committedUnitsCeiling));
    assert.deepEqual(most, { valid: true }, `${good}: x = floor(y) is legal`);
    // … one more is refused, naming the same bound the popup was given.
    const over = validateAction(s, units(`f_${good}`, t.committedUnitsCeiling + 1));
    assert.equal(over.valid, false, `${good}: x = floor(y) + 1 is refused`);
    assert.match(over.reason, new RegExp(`an integer from 0 to ${t.committedUnitsCeiling} `));
  }

  // Sign every good at its ceiling: the ratio stored is the published x ÷ the published y, to the
  // bit, and the basic fee locked is the fee the snapshot quoted beside it.
  const signed = intake(s, TIMED.map((good) => units(`f_${good}`, snap.tier3Contract[good].committedUnitsCeiling)));
  for (const r of signed.results) assert.equal(r.accepted, true, r.reason);
  for (const good of TIMED) {
    const t = snap.tier3Contract[good];
    const lic = ventureOf(signed.state, `f_${good}`).licence;
    assert.equal(lic.committedOutputPct, t.committedUnitsCeiling / t.weeklyOutput, `${good}: stored x / y`);
    assert.equal(lic.basicFee, snap.feeQuote[good], `${good}: the fee quoted is the fee locked`);
  }

  // Worked by hand: a fast y and the three slow specialists. Since the 28-09-26 retime every y is
  // whole, so floor(y) = y (they were 3.5 / 3.5 / 2.33, with ceilings 3 / 3 / 2).
  assert.deepEqual(snap.tier3Contract.fuel_tank, { weeklyOutput: 672, committedUnitsCeiling: 672, termDays: 7 });
  assert.deepEqual(snap.tier3Contract.heavy_reactor_engine, { weeklyOutput: 4, committedUnitsCeiling: 4, termDays: 7 });
  assert.deepEqual(snap.tier3Contract.stealth_module, { weeklyOutput: 3, committedUnitsCeiling: 3, termDays: 7 });
  assert.deepEqual(snap.tier3Contract.deep_scan_mast, { weeklyOutput: 2, committedUnitsCeiling: 2, termDays: 7 });
});

test('no Tier-1/2 good and none of the four unclassified modules is listed — they keep the Tier-1/2 licence', () => {
  const t = buildSnapshot(galaxy([])).tier3Contract;
  for (const good of [...RAW_RESOURCES, ...PROCESSED_GOODS]) assert.equal(t[good], undefined, good);
  const unclassified = TIER3_GOODS.filter((g) => ticksPerUnitFor(g) === null);
  assert.deepEqual([...unclassified].sort(), ['claim_beacon', 'drive_module', 'droid_components', 'habitation_module']);
  for (const good of unclassified) assert.equal(t[good], undefined, `${good} has no timer`);
});

// --- 2. the term in days is the schedule's own --------------------------------------------------

test('termDays is the term the renegotiation schedule counts a signed Tier-3 licence in — at the ruled day and at a 60-tick day', () => {
  for (const [N, expectedDays] of [[DAY, 7], [60, 168]]) {
    let s = galaxy([factory('h', 'g1', 'heavy_reactor_engine'), factory('f', 'g1', 'fuel_tank')], { windowN: N });
    const before = buildSnapshot(s).tier3Contract;
    assert.equal(before.fuel_tank.termDays, expectedDays, `N = ${N}: ${WEEK} ÷ ${N}`);
    const out = intake(s, [units('h', 3), units('f', 100)]);
    for (const r of out.results) assert.equal(r.accepted, true, r.reason);
    s = out.state;
    const rows = buildSnapshot(s).ventures;
    for (const id of ['h', 'f']) {
      const v = ventureOf(s, id);
      const good = v.recipeId;
      const sched = renegotiationScheduleFor(v, N, 0);
      assert.equal(dayOf(sched.windowEndTick, N, 0) - dayOf(v.licence.signedTick, N, 0), before[good].termDays,
        `N = ${N}, ${good}: the schedule's term, in days`);
      assert.equal(rows.find((r) => r.id === id).contractWindow.cyclesRemaining, before[good].termDays,
        `N = ${N}, ${good}: the Venture Management window at signing`);
    }
  }
});

// --- 3. omitted where no Tier-3 licence can be signed -------------------------------------------

test('a galaxy whose day does not divide the week publishes no Tier-3 contract — it could never sign one', () => {
  const s = galaxy([factory('f', 'g1', 'fuel_tank')], { windowN: 50 });
  const snap = buildSnapshot(s);
  assert.deepEqual(snap.tier3Contract, {});
  assert.equal(snap.feeQuote.fuel_tank, undefined, 'and no fee quote, for the same reason');
  assert.equal(typeof snap.feeQuote.titanium, 'number', 'a Tier-1/2 quote is unaffected');
  assert.equal(validateAction(s, units('f', 1)).valid, false, 'the engine refuses the licence there too');
});

// --- 4. derived only -----------------------------------------------------------------------------

test('tier3Contract is derived on read: building a snapshot moves no state byte, and two builds agree', () => {
  const s = galaxy(TIMED.map((good) => factory(`f_${good}`, 'g1', good)));
  const hash = hashState(s);
  const a = buildSnapshot(s).tier3Contract;
  const b = buildSnapshot(s).tier3Contract;
  assert.equal(hashState(s), hash, 'no stored byte moved');
  assert.equal(JSON.stringify(a), JSON.stringify(b), 'the same bytes, in the same order');
  assert.equal(JSON.stringify(s).includes('tier3Contract'), false, 'nothing serialized');
});

// --- 5. END TO END: the popup's own actions, over HTTP, on the real seeded galaxy ---------------

let server;
let base;
before(async () => {
  server = makeServer();
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  if (server.closeAllConnections) server.closeAllConnections();
  server.close();
});
async function post(path, body) {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

// The two objects the popup builds for a licensed factory deploy (client/game.html `doDeploy`):
// `establishVenture` with the picked asset, the recipe and the equity — no productionRate — then
// the licence. The Tier-3 licence carries `committedUnits` and nothing else.
function establishFor(ventureId, recipeId) {
  return {
    type: 'establishVenture', guildId: 'player-guild', ventureId, siteId: HOME_SLOT,
    assetId: 'asset_player-guild_factory_01', ventureType: 'refining', recipeId, equityPct: 0.2,
  };
}

test('END TO END: the popup\'s Tier-3 deploy — establishVenture, then applyForLicence { committedUnits } — is ACCEPTED; the old %/term shape is REFUSED', async () => {
  await post('/reset');
  const founded = await post('/action', { type: 'foundGuild', guildId: 'player-guild', credits: 120, influence: 100, homeSystemId: HOME_SYSTEM });
  assert.equal(founded.accepted, true, founded.reason);

  // The OLD shape — what the popup sent for every factory before this slice — on a heavy engine.
  const ventureId = `player-guild_${HOME_SLOT}`;
  const est = await post('/action', establishFor(ventureId, 'heavy_reactor_engine'));
  assert.equal(est.accepted, true, est.reason);
  const contract = est.snapshot.tier3Contract.heavy_reactor_engine;
  assert.deepEqual(contract, { weeklyOutput: 4, committedUnitsCeiling: 4, termDays: 7 });
  const old = await post('/action', { type: 'applyForLicence', guildId: 'player-guild', ventureId, committedOutputPct: 0.5, windowDays: 14 });
  assert.equal(old.accepted, false, 'the Tier-1/2 shape is refused for a timed good');
  assert.match(old.reason, /its licence commits whole units, not a percentage: send committedUnits, an integer from 0 to 4 \(the floor of its weekly output y = 4\)/);

  // The NEW shape, at the slider's most: x = floor(y) = 4 (a full commitment since the retime).
  const lic = await post('/action', { type: 'applyForLicence', guildId: 'player-guild', ventureId, committedUnits: contract.committedUnitsCeiling });
  assert.equal(lic.accepted, true, lic.reason);
  const row = lic.snapshot.ventures.find((v) => v.id === ventureId);
  assert.equal(row.syndicateCommitment, 4, 'x stored');
  assert.equal(row.licence.committedOutputPct, 1, 'x / y stored, exact: 4 of 4');
  assert.equal(row.licence.windowDays, 1, 'one week, written by the engine');
  assert.equal(row.licence.basicFee, est.snapshot.feeQuote.heavy_reactor_engine, 'the fee the popup quoted');
  assert.equal(row.contractWindow.cyclesRemaining, contract.termDays, 'renegotiable in the term the popup showed');
  assert.equal(row.equityPct, 0.2, 'equity rode on the establish, as for Tier 1/2');
});
