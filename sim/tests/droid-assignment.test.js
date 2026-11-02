'use strict';

// droid-assignment.test.js — roadmap 2.6, droid engine slice 3: the SYNDICATE flat-tariff droid buy and
// ASSIGNMENT (docs/droids.md §1/§3/§4; the tariff 10,000 and the cap 20 from docs/phase-1-tuning.md §Droids).
//
// An assigned droid still does NOTHING to production — the boost, decay and maintenance are later slices.
// The tripwires:
//
//   1. THE ROW: an idle droid is slice 2's four fields; an assigned one adds assignedToVentureId + deployedAtTick.
//   2. NO-OP BYTE-IDENTICAL: a run that buys and assigns no droid hashes exactly as it did at b226b3a.
//   3. THE BUY: one idle Syndicate-source droid at the destination for exactly 10,000 cr, ledgered (invariant 2);
//      refused on insufficient credits (naming the shortfall) and on a system the guild does not hold.
//   4. ASSIGN / UNASSIGN flip the derived idle/deployed state and record their tick.
//   5. THE GATE: each refusal in order with its own reason; a Syndicate droid is refused on an unlicensed venture
//      (naming it) while a guild droid is allowed there; the 21st is refused (source-blind); cross-system refused.
//   6. THE LAPSE: a Syndicate droid on a venture whose licence then lapses keeps running — no halt, no eviction.
//   7. CLOSURE: a closed venture's droids return to idle in place (the applyVentureClosure seam).
//   8. THE INVARIANT: checkDroids bites on every bad assignment, and halts the tick loop naming the tick.
//   9. SNAPSHOT: the owner sees each droid's venture and each venture's complement; a rival sees neither.
//  10. DETERMINISM (invariant 9) and IDS NEVER REISSUED (§15.4), save/restore included.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createDroid } = require('../state.js');
const { hashState } = require('../serialize.js');
const { saveState, loadOrInit } = require('../persist.js');
const { buildSnapshot } = require('../snapshot.js');
const { fogForGuild } = require('../fog.js');
const { checkInvariants, checkDroids } = require('../invariants.js');
const { applyLapse } = require('../licence.js');
const { getStarterSystems } = require('../seed.js');
const {
  DROID, SYNDICATE_DROID_TARIFF, DROID_CAP, mintDroid, isDroidIdle, assignedDroidCount,
} = require('../droids.js');
const { SYNDICATE_SELLABLE_KINDS, priceAssetForPurchase } = require('../asset-recipes.js');
const {
  createBuyAssetFromSyndicateAction, createAssignDroidAction, createUnassignDroidAction, createRemoveVentureAction,
} = require('../actions.js');
const { HOME, RIVAL, kitGalaxy, accept, refuse, ticks, g1Of } = require('./installation-kit-fixtures.js');
const { noBuyNoAssignScript } = require('./droid-assign-noop-script.js');

// A second starter system g1 also holds, for the cross-system gate.
const OTHER = getStarterSystems().map((s) => s.id).find((id) => id !== HOME.id && id !== RIVAL);
const LICENSED = 'v_lic';
const UNLICENSED = 'v_unlic';
const FAR = 'v_far';
const RIVAL_VENTURE = 'v_rival';

// assignGalaxy({ credits }) -> the kit galaxy plus four bare ventures: a LICENSED and an UNLICENSED one in g1's
// HOME, one in OTHER (a second system g1 holds), and one of g2's. Bare (no site, no asset — the dockyard
// fixture's own unseated shape), so nothing produces and the tick leaves them alone. The licence carries the
// fields the licence invariants demand; its zero fees keep credits still, so every credit move below is the
// droid's. Every invariant is checked before the galaxy is handed back.
function assignGalaxy({ credits = 1_000_000 } = {}) {
  const s = kitGalaxy({ credits });
  const g1 = g1Of(s);
  const g2 = s.guilds.find((g) => g.id === 'g2');
  const bare = (id, owner, systemId, extra = {}) => ({ id, ownerGuildId: owner, type: 'refining', systemId, ...extra });
  g1.ventures.push(bare(LICENSED, 'g1', HOME.id, {
    licence: { committedOutputPct: 0, windowDays: 7, signedTick: 0, basicFee: 0, discountedFee: 0, lockedPrice: 1 },
  }));
  g1.ventures.push(bare(UNLICENSED, 'g1', HOME.id));
  g1.ventures.push(bare(FAR, 'g1', OTHER));
  g2.ventures = [bare(RIVAL_VENTURE, 'g2', RIVAL)];
  s.claims.push({
    claimId: `claim_g1_${OTHER}`, ownerGuildId: 'g1', landmarkId: OTHER, landmarkKind: 'system', claimedAtTick: 0, contested: false,
  });
  assert.deepEqual(checkInvariants(s, s.tick), [], 'the fixture itself is legal');
  return s;
}

const buy = (systemId = HOME.id, guildId = 'g1') => createBuyAssetFromSyndicateAction({
  guildId, assetKind: DROID, destinationSystemId: systemId,
});
const assign = (droidId, ventureId, guildId = 'g1') => createAssignDroidAction({ guildId, droidId, ventureId });
const unassignA = (droidId, guildId = 'g1') => createUnassignDroidAction({ guildId, droidId });
const droidsOf = (s) => g1Of(s).droids || [];
const droidOf = (s, id) => droidsOf(s).find((d) => d.id === id);
const D1 = 'asset_g1_droid_01';
const D2 = 'asset_g1_droid_02';

// withGuildDroid(s, systemId) -> a copy of `s` holding one more GUILD droid, minted through THE ONE droid mint
// (sim/droids.js) — what a finished dockyard build calls (slice 2 tests the build itself). Saves 361 ticks per
// droid where a test only needs a guild droid to exist.
function withGuildDroid(s, systemId = HOME.id) {
  const next = structuredClone(s);
  mintDroid(g1Of(next), 'guild', systemId);
  assert.deepEqual(checkInvariants(next, next.tick), []);
  return next;
}

// --- 1. the row ---------------------------------------------------------------------------------------------

test('createDroid: idle is exactly slice 2\'s four fields; assigned adds assignedToVentureId + deployedAtTick', () => {
  const idle = createDroid({ id: D1, systemId: 'sys_x', source: 'syndicate' });
  assert.deepEqual(idle, { id: D1, systemId: 'sys_x', source: 'syndicate', condition: 1 });
  assert.equal(isDroidIdle(idle), true);
  const busy = createDroid({ id: D1, systemId: 'sys_x', source: 'guild', assignedToVentureId: 'v', deployedAtTick: 7 });
  assert.deepEqual(busy, { id: D1, systemId: 'sys_x', source: 'guild', condition: 1, assignedToVentureId: 'v', deployedAtTick: 7 });
  assert.equal(isDroidIdle(busy), false);
});

// --- 2. no-op byte-identical --------------------------------------------------------------------------------

// RECORDED AT b226b3a (main, before this slice's code existed) by running droid-assign-noop-script.js there.
// A galaxy that builds a guild droid, buys a miner from the Syndicate and closes a venture — but buys and
// assigns no droid — must not move by a byte.
const NO_BUY_NO_ASSIGN_GOLDEN_B226B3A = '68e5bb474400953cde39cdcf02a592ec7a2ca9ec54b4e2b99c964150d6f57114';

test('no-op: a run that buys and assigns no droid is byte-identical to b226b3a', () => {
  const s = noBuyNoAssignScript();
  // The run really did walk the touched paths: a guild droid minted (and left idle), a miner delivered, the
  // dockyard venture closed.
  assert.deepEqual(droidsOf(s), [{ id: D1, systemId: HOME.id, source: 'guild', condition: 1 }]);
  assert.deepEqual(g1Of(s).assets.map((a) => a.id), ['asset_g1_miner_01']);
  assert.equal(g1Of(s).ventures.length, 0);
  assert.equal(hashState(s), NO_BUY_NO_ASSIGN_GOLDEN_B226B3A);
});

// --- 3. the Syndicate buy -----------------------------------------------------------------------------------

test('tariff: the droid is Syndicate-sellable at a FLAT 10,000, whatever the tick or the parts market', () => {
  assert.equal(SYNDICATE_DROID_TARIFF, 10_000);
  assert.ok(SYNDICATE_SELLABLE_KINDS.includes(DROID));
  const s = assignGalaxy();
  assert.equal(priceAssetForPurchase(s, DROID, s.tick), 10_000);
  assert.equal(priceAssetForPurchase(s, DROID, -99_999), 10_000, 'no quote ring is read — no null at an expired tick');
  const later = ticks(s, 50);
  assert.equal(priceAssetForPurchase(later, DROID, later.tick), 10_000);
});

test('buy: exactly ONE idle Syndicate droid at the destination for exactly 10,000, ledgered (invariant 2)', () => {
  const s = assignGalaxy({ credits: 25_000 });
  const before = { credits: g1Of(s).credits, ledger: s.syndicate.ledger, fuel: g1Of(s).fuelHoard, consumed: s.audit.totalConsumed };
  const after = accept(s, buy()); // accept() runs every invariant with no tick between (credit conservation too)
  assert.deepEqual(droidsOf(after), [{ id: D1, systemId: HOME.id, source: 'syndicate', condition: 1 }]);
  assert.equal(g1Of(after).credits, before.credits - 10_000);
  assert.equal(after.syndicate.ledger, before.ledger + 10_000);
  assert.equal(g1Of(after).credits + after.syndicate.ledger, before.credits + before.ledger, 'credits moved, none made');
  assert.equal(g1Of(after).droidSerial, 1);
  // Instant: no commission, no flight, no fuel, no asset.
  assert.equal(after.syndicateBuilds, undefined, 'no Syndicate commission was queued');
  assert.equal(g1Of(after).fuelHoard, before.fuel);
  assert.equal(after.audit.totalConsumed, before.consumed);
  assert.equal(g1Of(after).assets, undefined);
  assert.equal(g1Of(after).syndicateCommissionSerial, undefined);
  // And it survives ticking (every invariant, every tick).
  assert.deepEqual(droidsOf(ticks(after, 5)), droidsOf(after));
});

test('buy: refused on insufficient credits, naming the shortfall — and nothing moves', () => {
  const s = assignGalaxy({ credits: 9_999 });
  const reason = refuse(s, buy());
  assert.match(reason, /holds 9999 credits, cannot pay the Syndicate droid tariff of 10000 — short by 1/);
  // Exactly 10,000 is enough.
  const exact = accept(assignGalaxy({ credits: 10_000 }), buy());
  assert.equal(g1Of(exact).credits, 0);
});

test('buy: refused into a system the guild does not hold, or one not on the seed', () => {
  const s = assignGalaxy();
  assert.match(refuse(s, buy(RIVAL)), new RegExp(`does not hold system "${RIVAL}"`));
  assert.match(refuse(s, buy('sys_nope')), /is not a system on the seed/);
  // A system g1 does hold, away from home, is fine.
  assert.equal(droidsOf(accept(s, buy(OTHER)))[0].systemId, OTHER);
});

test('buy: the commissioned-asset quote does not list the droid (no build time, no delivery leg)', () => {
  const snap = buildSnapshot(assignGalaxy());
  assert.equal(DROID in snap.assetPurchaseQuote, false);
  assert.ok('miner' in snap.assetPurchaseQuote);
});

// --- 4. assign / unassign -----------------------------------------------------------------------------------

test('assign / unassign flip idle ↔ deployed and record their tick', () => {
  let s = accept(assignGalaxy(), buy());
  s = ticks(s, 7); // so the assign tick is not 0
  const assignTick = s.tick;
  s = accept(s, assign(D1, LICENSED));
  assert.deepEqual(droidOf(s, D1), {
    id: D1, systemId: HOME.id, source: 'syndicate', condition: 1, assignedToVentureId: LICENSED, deployedAtTick: assignTick,
  });
  assert.equal(isDroidIdle(droidOf(s, D1)), false);
  assert.equal(assignedDroidCount(g1Of(s), LICENSED), 1);

  s = ticks(s, 10);
  assert.equal(droidOf(s, D1).deployedAtTick, assignTick, 'the deploy tick is the assign tick, not re-stamped');

  s = accept(s, unassignA(D1));
  assert.deepEqual(droidOf(s, D1), { id: D1, systemId: HOME.id, source: 'syndicate', condition: 1 }, 'back to the idle row, in place');
  assert.equal(assignedDroidCount(g1Of(s), LICENSED), 0);

  // And it can be put to work again, re-stamped at the new tick.
  s = ticks(s, 3);
  s = accept(s, assign(D1, LICENSED));
  assert.equal(droidOf(s, D1).deployedAtTick, s.tick);
});

test('assign moves nothing but the droid: no credit, fuel, good, venture or asset field changes', () => {
  const s = accept(assignGalaxy(), buy());
  const after = accept(s, assign(D1, LICENSED));
  const strip = (st) => { const c = structuredClone(st); for (const g of c.guilds) delete g.droids; return c; };
  assert.deepEqual(strip(after), strip(s));
});

test('unassign refusals: not the guild\'s droid, or already idle', () => {
  const s = accept(assignGalaxy(), buy());
  assert.match(refuse(s, unassignA('asset_g1_droid_99')), /guild g1 owns no droid "asset_g1_droid_99"/);
  assert.match(refuse(s, unassignA(D1, 'g2')), /guild g2 owns no droid "asset_g1_droid_01"/);
  assert.match(refuse(s, unassignA(D1)), /droid asset_g1_droid_01 is idle — it is assigned to no venture/);
  assert.match(refuse(s, unassignA(D1, 'nobody')), /no guild with id "nobody"/);
});

// --- 5. the gate --------------------------------------------------------------------------------------------

test('gate: ownership — the guild must own both the droid and the venture', () => {
  const s = accept(assignGalaxy(), buy());
  assert.match(refuse(s, assign('asset_g1_droid_99', LICENSED)), /guild g1 owns no droid "asset_g1_droid_99"/);
  assert.match(refuse(s, assign(D1, LICENSED, 'g2')), /guild g2 owns no droid "asset_g1_droid_01"/, 'a rival cannot assign g1\'s droid');
  assert.match(refuse(s, assign(D1, RIVAL_VENTURE)), /guild g1 owns no venture "v_rival"/, 'nor can g1 staff a rival\'s venture');
  assert.match(refuse(s, assign(D1, 'v_nope')), /guild g1 owns no venture "v_nope"/);
});

test('gate: an assigned droid is refused, naming the venture holding it', () => {
  let s = withGuildDroid(assignGalaxy());
  s = accept(s, assign(D1, UNLICENSED));
  assert.match(refuse(s, assign(D1, LICENSED)), /droid asset_g1_droid_01 is already assigned to venture "v_unlic" — unassign it first/);
  assert.match(refuse(s, assign(D1, UNLICENSED)), /already assigned to venture "v_unlic"/, 'even to the same venture');
});

test('gate: same-system only — a cross-system assign is refused, naming both systems', () => {
  const s = withGuildDroid(assignGalaxy());
  const reason = refuse(s, assign(D1, FAR));
  assert.match(reason, new RegExp(`is in system "${HOME.id}", but venture v_far is in "${OTHER}"`));
  // The same droid in OTHER is fine there (a guild droid, an unlicensed venture).
  accept(withGuildDroid(assignGalaxy(), OTHER), assign(D1, FAR));
});

test('THE GATE: a Syndicate droid is refused on an UNLICENSED venture, naming it — a GUILD droid is allowed there', () => {
  let s = accept(assignGalaxy(), buy()); // D1 — Syndicate
  s = withGuildDroid(s); // D2 — guild
  assert.equal(droidOf(s, D1).source, 'syndicate');
  assert.equal(droidOf(s, D2).source, 'guild');

  const reason = refuse(s, assign(D1, UNLICENSED));
  assert.match(reason, /droid asset_g1_droid_01 is a Syndicate droid and venture v_unlic is unlicensed/);
  assert.match(reason, /only to a licensed venture/);

  s = accept(s, assign(D2, UNLICENSED)); // the guild droid goes anywhere
  s = accept(s, assign(D1, LICENSED)); // the Syndicate droid goes to the licensed one
  assert.equal(droidOf(s, D1).assignedToVentureId, LICENSED);
  assert.equal(droidOf(s, D2).assignedToVentureId, UNLICENSED);
});

test('gate: a guild droid may staff a LICENSED venture too', () => {
  const s = accept(withGuildDroid(assignGalaxy()), assign(D1, LICENSED));
  assert.equal(droidOf(s, D1).assignedToVentureId, LICENSED);
});

test('THE CAP: 20 droids fill a venture, the 21st is refused — source-blind', () => {
  assert.equal(DROID_CAP, 20);
  let s = assignGalaxy({ credits: 20 * SYNDICATE_DROID_TARIFF });
  for (let i = 0; i < 10; i += 1) s = accept(s, buy()); // 10 Syndicate droids
  for (let i = 0; i < 11; i += 1) s = withGuildDroid(s); // 11 guild droids
  const ids = droidsOf(s).map((d) => d.id);
  assert.equal(ids.length, 21);
  for (const id of ids.slice(0, 20)) s = accept(s, assign(id, LICENSED));
  assert.equal(assignedDroidCount(g1Of(s), LICENSED), 20);
  const reason = refuse(s, assign(ids[20], LICENSED));
  assert.match(reason, /venture v_lic already holds 20 droids, the cap of 20 — unassign one first/);
  // The cap is per venture: the 21st still goes to another.
  s = accept(s, assign(ids[20], UNLICENSED));
  // Free a slot and the full venture takes one again.
  s = accept(s, unassignA(ids[0]));
  s = accept(s, unassignA(ids[20]));
  s = accept(s, assign(ids[20], LICENSED));
  assert.equal(assignedDroidCount(g1Of(s), LICENSED), 20);
  ticks(s, 3); // a full complement is legal under every invariant
});

test('gate order: ownership, then idle, then system, then licence, then cap', () => {
  // A Syndicate droid in OTHER, already assigned, aimed at the unlicensed HOME venture: "assigned" is reported
  // first, not the system or the licence.
  let s = accept(assignGalaxy(), buy(OTHER));
  s.guilds[0].ventures.find((v) => v.id === FAR).licence = { ...g1Of(s).ventures.find((v) => v.id === LICENSED).licence };
  s = accept(s, assign(D1, FAR));
  assert.match(refuse(s, assign(D1, UNLICENSED)), /already assigned/);
  s = accept(s, unassignA(D1));
  // Idle now: cross-system is reported before the licence.
  assert.match(refuse(s, assign(D1, UNLICENSED)), /a droid is assigned only within its own system/);
});

// --- 6. the licence lapse -----------------------------------------------------------------------------------

test('THE LAPSE: a Syndicate droid on a venture whose licence then lapses keeps running — no halt, no eviction', () => {
  let s = accept(assignGalaxy(), buy());
  s = accept(s, buy());
  s = accept(s, assign(D1, LICENSED));
  const deployedAt = droidOf(s, D1).deployedAtTick;

  // The ONE lapse effect (sim/licence.js applyLapse — what both a reject and a timed-out renegotiation run).
  const lapsed = structuredClone(s);
  const venture = g1Of(lapsed).ventures.find((v) => v.id === LICENSED);
  applyLapse(g1Of(lapsed), venture, 'timeout', lapsed.tick);
  assert.equal(venture.licence, undefined, 'the venture really is unlicensed now');
  assert.deepEqual(checkInvariants(lapsed, lapsed.tick), [], 'a Syndicate droid on a lapsed venture is LEGAL');

  // Run on: every invariant, every tick — and the droid stays exactly where it was.
  const later = ticks(lapsed, 200);
  assert.equal(droidOf(later, D1).assignedToVentureId, LICENSED, 'not evicted');
  assert.equal(droidOf(later, D1).deployedAtTick, deployedAt, 'not re-stamped');

  // What the lapse DOES change: no MORE Syndicate droids go there …
  assert.match(refuse(later, assign(D2, LICENSED)), /is a Syndicate droid and venture v_lic is unlicensed/);
  // … while the one already there can still be taken off (and then not put back).
  const off = accept(later, unassignA(D1));
  assert.match(refuse(off, assign(D1, LICENSED)), /is unlicensed/);
});

// --- 7. closure releases droids -----------------------------------------------------------------------------

test('closure: a closed venture\'s droids return to idle, where they stand — and nothing halts', () => {
  let s = accept(assignGalaxy(), buy());
  s = withGuildDroid(s);
  s = accept(s, assign(D1, LICENSED));
  s = accept(s, assign(D2, UNLICENSED));
  // The operator lever runs the shared applyVentureClosure (teardown, forced closure and eviction use it too).
  // (The UNLICENSED one is closed: closing the fixture's site-less licensed venture would write a node lockout
  // with no node, which the lockout invariant rightly refuses — a fixture limit, not a droid question.)
  s = accept(s, createRemoveVentureAction({ guildId: 'g1', ventureId: UNLICENSED }));
  assert.equal(g1Of(s).ventures.some((v) => v.id === UNLICENSED), false);
  assert.deepEqual(droidOf(s, D2), { id: D2, systemId: HOME.id, source: 'guild', condition: 1 }, 'released, in place');
  assert.equal(droidOf(s, D1).assignedToVentureId, LICENSED, 'another venture\'s droid is untouched');
  ticks(s, 5);
});

// --- 8. the invariant ---------------------------------------------------------------------------------------

test('checkDroids bites on every bad assignment, naming the guild and the value', () => {
  let base = accept(assignGalaxy(), buy());
  base = accept(base, assign(D1, LICENSED));
  const broken = (mutate) => {
    const s = structuredClone(base);
    mutate(droidOf(s, D1), s);
    return checkDroids(s);
  };
  const rules = (v) => v.map((x) => x.rule);

  assert.deepEqual(checkDroids(base), []);
  assert.deepEqual(rules(broken((d) => { delete d.deployedAtTick; })), ['droid-assignment-paired']);
  assert.deepEqual(rules(broken((d) => { delete d.assignedToVentureId; })), ['droid-assignment-paired']);
  assert.deepEqual(rules(broken((d, s) => { d.deployedAtTick = s.tick + 1; })), ['droid-assignment-paired'], 'a future deploy tick');
  assert.deepEqual(rules(broken((d) => { d.deployedAtTick = 1.5; })), ['droid-assignment-paired']);
  const gone = broken((d) => { d.assignedToVentureId = 'v_gone'; });
  assert.deepEqual(rules(gone), ['droid-venture-exists']);
  assert.equal(gone[0].where, 'guild:g1.droid:asset_g1_droid_01.assignedToVentureId');
  assert.deepEqual(gone[0].detail, { assignedToVentureId: 'v_gone', owner: 'g1' });
  assert.deepEqual(rules(broken((d) => { d.assignedToVentureId = RIVAL_VENTURE; })), ['droid-venture-exists'], 'a rival\'s venture');
  const moved = broken((d) => { d.systemId = OTHER; });
  assert.deepEqual(rules(moved), ['droid-venture-same-system']);
  assert.deepEqual(moved[0].detail, { droidSystemId: OTHER, ventureId: LICENSED, ventureSystemId: HOME.id });

  // The cap, forced past by hand (the gate would never let it happen).
  const over = structuredClone(base);
  for (let i = 0; i < DROID_CAP; i += 1) {
    const d = mintDroid(g1Of(over), 'guild', HOME.id);
    d.assignedToVentureId = LICENSED;
    d.deployedAtTick = over.tick;
  }
  const capV = checkDroids(over);
  assert.deepEqual(rules(capV), ['droid-venture-cap']);
  assert.deepEqual(capV[0].detail, { assigned: 21, cap: 20 });
  assert.equal(capV[0].where, 'guild:g1.venture:v_lic');
});

test('checkDroids runs inside the tick loop: a droid left on a vanished venture halts, naming the tick', () => {
  let s = accept(assignGalaxy(), buy());
  s = accept(s, assign(D1, LICENSED));
  // Splice the venture out WITHOUT the closure — the bug releaseDroidsFrom exists to prevent.
  const g = g1Of(s);
  g.ventures.splice(g.ventures.findIndex((v) => v.id === LICENSED), 1);
  assert.throws(() => ticks(s, 1), (err) => /droid-venture-exists/.test(err.message) && /tick/.test(err.message));
});

// --- 9. snapshot --------------------------------------------------------------------------------------------

test('snapshot: the owner sees each droid\'s venture and each venture\'s complement; idle omits both; a rival sees neither', () => {
  let s = accept(assignGalaxy(), buy());
  s = withGuildDroid(s);
  s = withGuildDroid(s);
  const idleRow = buildSnapshot(s).guilds.find((g) => g.id === 'g1');
  assert.deepEqual(idleRow.droids.map((d) => Object.keys(d)), [
    ['id', 'systemId', 'source', 'condition'], ['id', 'systemId', 'source', 'condition'], ['id', 'systemId', 'source', 'condition'],
  ], 'an idle row is slice 2\'s shape');
  assert.equal('droidComplement' in idleRow, false, 'no complement while nothing is assigned');

  s = accept(s, assign('asset_g1_droid_03', LICENSED));
  s = accept(s, assign(D1, LICENSED));
  s = accept(s, assign(D2, UNLICENSED));
  const snap = buildSnapshot(s);
  const row = snap.guilds.find((g) => g.id === 'g1');
  assert.deepEqual(row.droids, [
    { id: D1, systemId: HOME.id, source: 'syndicate', condition: 1, assignedToVentureId: LICENSED },
    { id: D2, systemId: HOME.id, source: 'guild', condition: 1, assignedToVentureId: UNLICENSED },
    { id: 'asset_g1_droid_03', systemId: HOME.id, source: 'guild', condition: 1, assignedToVentureId: LICENSED },
  ]);
  assert.deepEqual(row.droidComplement, { [LICENSED]: [D1, 'asset_g1_droid_03'], [UNLICENSED]: [D2] });
  row.droidComplement[LICENSED].push('mutated');
  assert.equal(assignedDroidCount(g1Of(s), LICENSED), 2, 'the snapshot never aliases engine state');
  assert.equal('droidComplement' in snap.guilds.find((g) => g.id === 'g2'), false);

  const rivalView = fogForGuild(buildSnapshot(s), s, 'g2');
  const g1Seen = rivalView.guilds.find((g) => g.id === 'g1');
  assert.equal('droids' in g1Seen, false, 'a rival never sees g1\'s droids');
  assert.equal('droidComplement' in g1Seen, false, 'nor their complement');
  assert.doesNotMatch(JSON.stringify(rivalView), /asset_g1_droid_/, 'no droid id leaks anywhere in the rival view');
});

// --- 10. determinism and ids --------------------------------------------------------------------------------

function assignScript() {
  let s = assignGalaxy();
  s = accept(s, buy());
  s = withGuildDroid(s);
  s = withGuildDroid(s, OTHER); // a guild droid: FAR is unlicensed
  s = accept(s, assign(D1, LICENSED));
  s = ticks(s, 30);
  s = accept(s, assign(D2, UNLICENSED));
  const mid = ticks(s, 30);
  let end = accept(mid, unassignA(D1));
  end = accept(end, assign('asset_g1_droid_03', FAR));
  return { mid, end: ticks(end, 40) };
}

test('determinism (invariant 9): two runs are byte-identical', () => {
  const a = assignScript();
  const b = assignScript();
  assert.equal(hashState(a.end), hashState(b.end));
  assert.equal(hashState(a.mid), hashState(b.mid));
});

test('ids: both sources number off the one droidSerial, and an id is never reissued', () => {
  let s = withGuildDroid(assignGalaxy()); // 01 guild
  s = accept(s, buy()); // 02 Syndicate
  assert.deepEqual(droidsOf(s).map((d) => [d.id, d.source]), [[D1, 'guild'], [D2, 'syndicate']]);
  // Drop 02 from the collection (as end-of-life will); the next buy takes 03, never 02 again.
  g1Of(s).droids.pop();
  s = accept(s, buy());
  assert.deepEqual(droidsOf(s).map((d) => d.id), [D1, 'asset_g1_droid_03']);
  assert.equal(g1Of(s).droidSerial, 3);
});

test('determinism: a save with droids assigned restores byte-identically and runs on identically', () => {
  const { mid } = assignScript();
  assert.equal(droidOf(mid, D1).assignedToVentureId, LICENSED);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'starfare-droid-assign-'));
  try {
    saveState(mid, dir);
    const restored = loadOrInit(dir, () => { throw new Error('expected the saved state to load'); });
    assert.equal(hashState(restored), hashState(mid));
    assert.deepEqual(droidsOf(restored), droidsOf(mid), 'assignments survive a restore');
    assert.equal(hashState(ticks(restored, 50)), hashState(ticks(mid, 50)));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
