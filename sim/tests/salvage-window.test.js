'use strict';

// salvage-window.test.js — LOSING GROUND: THE SALVAGE WINDOW (design.md §2 / §19 #67, SETTLED 19-10-26; the rate RULED
// 31-10-26, docs/phase-1-tuning.md: 3 days = 4320 ticks per stranded asset, pooled per lost system, capped at 18 days =
// 25920 ticks, fixed at the stranding tick; sim/eviction.js). An eviction that strands anything opens ONE window for the
// lost system; a claim of the system closes it early (the plant); otherwise, on its deadline, whatever is still
// stranded there is DESTROYED and its owner told.
//
// The tripwires:
//   1. THE LENGTH: min(N × 4320, 25920) for N = 1, 3, 6 (the cap exactly) and 7 (capped); machines and kits count
//      alike; nothing stranded, no window.
//   2. THE PLAYED TIMELINE (real ticks, every invariant every tick): abandon → salvage one machine → re-claim (the
//      window closes) → abandon again (a FRESH window, counting only what was stranded — not the machine aboard) →
//      the deadline. The lapse fires ON the deadline and not a tick before; it destroys through deleteAsset (the
//      number is never reissued); the owner gets one notice; the machine aboard is untouched.
//   3. THE EARLY ENDS, from one tick before that deadline: everything salvaged (silent); the owner re-plants; a rival
//      claims — in each the window closes and ticking past the old deadline destroys nothing.
//   4. PARTIAL SALVAGE + KITS (real ticks): three stranded, one salvaged early — the deadline does not move, and at it
//      only the two still stranded (a factory and an Outpost kit) are destroyed.
//   5. DETERMINISM: one guild losing two systems on one tick — they lapse in systemId order whatever the map's key order.
//   6. THE SNAPSHOT: the owner sees `salvageWindows: { [systemId]: { deadlineTick } }`; a rival does not; it goes with
//      the window.
//   7. THE INVARIANTS BITE (checkSalvageWindows): each new rule red on a forced state, and the harness halts on it.
//   8. BYTE-IDENTITY + PERSISTENCE: a galaxy that evicts nothing (or strands nothing, or re-claims) carries no key; a
//      save reloaded mid-window lapses on the same tick to the same bytes; a createState hand-in is copied.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { hashState } = require('../serialize.js');
const { tick: tickOnce } = require('../tick.js'); // one bare tick (no invariant check) — the determinism test's tool
const { createState } = require('../state.js');
const { buildSnapshot } = require('../snapshot.js');
const { checkInvariants } = require('../invariants.js');
const { getSystem } = require('../seed.js');
const { assetNumberOf } = require('../assets.js');
const { HEAVY_TRANSPORT } = require('../vehicles.js');
const {
  SALVAGE_WINDOW_TICKS_PER_ASSET, SALVAGE_WINDOW_CAP_TICKS, salvageWindowTicks,
} = require('../eviction.js');
const { SALVAGE_WINDOW_LAPSED } = require('../events.js');
const {
  createGrantKitAction, createLoadAssetAction, createAbandonPrefectureAction, createSpawnVehicleAction,
} = require('../actions.js');
const P = require('./prefecture-fixtures.js');
const S = require('./sweep-script.js');

const { accept, ticks, HEAVY, RIVAL, TARGET, AT_TARGET, SLOT_A1 } = P;
const { guildOf, abandon, grantMachine, planted, rivalReady, rivalPlant } = S;

const TARGET_NAME = getSystem(TARGET).name;
const assetsOf = (s, guildId) => guildOf(s, guildId).assets || [];
const idsOf = (s, guildId) => assetsOf(s, guildId).map((a) => a.id);
const eventsOf = (s, guildId) => guildOf(s, guildId).events || [];
const lapseNotices = (s) => s.guilds.flatMap((g) => (g.events || []).filter((e) => e.type === SALVAGE_WINDOW_LAPSED));
const load = (vehicleId, assetId) => createLoadAssetAction({ guildId: 'g1', vehicleId, assetId });
const rules = (s) => checkInvariants(s, s.tick).map((v) => v.rule);

// strandIn(s, kinds) -> { s, ids }: g1 is granted one idle asset of each kind in TARGET (the operator levers), in
// order. 'outpost' is an Outpost kit; anything else a machine.
function strandIn(s, kinds) {
  const ids = [];
  for (const kind of kinds) {
    if (kind === 'outpost') {
      s = accept(s, createGrantKitAction({ guildId: 'g1', systemId: TARGET, kind: 'outpost' }));
      ids.push(assetsOf(s, 'g1').filter((a) => a.kind === 'outpost').slice(-1)[0].id);
    } else {
      let id;
      ({ s, id } = grantMachine(s, 'g1', kind, TARGET));
      ids.push(id);
    }
  }
  return { s, ids };
}

// evictedWith(kinds) -> planted() (g1 holds TARGET, its empty heavy berthed there), g1 given `kinds` in TARGET, then
// abandoned: every one of them stranded. `tick` is the eviction's tick.
function evictedWith(kinds) {
  const { s, ids } = strandIn(planted(), kinds);
  const after = accept(s, abandon());
  return { s: after, ids, tick: after.tick };
}

// ownReplant(s) -> g1 plants a fresh Prefecture in TARGET (it surveyed PLANET_A in planted()).
function ownReplant(s) {
  let kitId;
  ({ s, kitId } = P.grantPrefectureKit(s, 'g1', TARGET));
  return accept(s, P.plant('g1', kitId, SLOT_A1));
}

// --- 1. the length ---------------------------------------------------------------------------------------------------

test('THE LENGTH: the ruled constants, and min(N × 4320, 25920) — the cap is reached at 6 and bites from 7', () => {
  assert.equal(SALVAGE_WINDOW_TICKS_PER_ASSET, 4320, '3 days × 1,440 ticks (phase-1-tuning.md, RULED 31-10-26)');
  assert.equal(SALVAGE_WINDOW_CAP_TICKS, 25920, '18 days × 1,440 ticks');
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 8, 20].map(salvageWindowTicks),
    [4320, 8640, 12960, 17280, 21600, 25920, 25920, 25920, 25920]);
});

test('THE LENGTH, at the eviction: N = 1, 3 (machines and a kit alike), 6 (the cap exactly) and 7 (capped) — one record for the system, fixed at the eviction tick', () => {
  const cases = [
    [['miner'], 4320],
    [['miner', 'factory', 'outpost'], 12960],
    [['miner', 'miner', 'factory', 'factory', 'outpost', 'outpost'], 25920],
    [['miner', 'miner', 'miner', 'factory', 'factory', 'outpost', 'outpost'], 25920],
  ];
  for (const [kinds, length] of cases) {
    const { s, ids, tick } = evictedWith(kinds);
    assert.deepEqual(eventsOf(s, 'g1').slice(-1)[0].payload.strandedAssetIds, [...ids].sort(), `${kinds.length}: all stranded`);
    assert.deepEqual(s.salvageWindows, {
      [TARGET]: { ownerGuildId: 'g1', evictedAtTick: tick, deadlineTick: tick + length },
    }, `${kinds.length} stranded → a window of ${length} ticks`);
  }
});

test('NOTHING STRANDED, NO WINDOW: an abandon that leaves nothing behind opens none, and the state carries no key', () => {
  const s = accept(planted(), abandon());
  assert.deepEqual(eventsOf(s, 'g1').slice(-1)[0].payload.strandedAssetIds, []);
  assert.equal('salvageWindows' in s, false);
});

// --- 2. the played timeline ------------------------------------------------------------------------------------------

// replayed() -> the played timeline, built once (it ticks 4319 times). g1 is evicted from TARGET with a miner and a
// factory there (a window of 8640); it salvages the miner onto its heavy; it RE-CLAIMS TARGET (the window closes, the
// factory is recovered); and it ABANDONS again — now only the factory is stranded, since the miner is aboard. The
// fresh window is 4320. `preLapse` is that galaxy one tick before its deadline.
let replayedMemo = null;
function replayed() {
  if (replayedMemo) return replayedMemo;
  const first = evictedWith(['miner', 'factory']);
  const [miner, factory] = first.ids;
  let s = accept(first.s, load(HEAVY, miner));
  const afterLoad = s;
  s = ownReplant(s);
  const afterReplant = s;
  s = accept(s, createAbandonPrefectureAction({ guildId: 'g1', prefectureId: 'prefecture_g1_02' }));
  const afterSecond = s;
  const deadlineTick = s.tick + 4320;
  const preLapse = ticks(s, 4319);
  replayedMemo = { first, miner, factory, afterLoad, afterReplant, afterSecond, deadlineTick, preLapse };
  return replayedMemo;
}

test('A SALVAGE does not move the deadline; a RE-CLAIM closes the window; a RE-ABANDON opens a fresh one, counting only what was stranded — not the machine aboard', () => {
  const { first, miner, factory, afterLoad, afterReplant, afterSecond, deadlineTick } = replayed();
  assert.deepEqual(first.s.salvageWindows[TARGET].deadlineTick, first.tick + 8640, 'two stranded');
  assert.deepEqual(afterLoad.salvageWindows, first.s.salvageWindows, 'the salvage leaves the record exactly as it was');
  assert.equal('salvageWindows' in afterReplant, false, 'the claim closed it; the empty map is gone too');
  assert.equal(assetsOf(afterReplant, 'g1').find((a) => a.id === factory).stranded, undefined, 'the factory recovered');
  assert.deepEqual(eventsOf(afterSecond, 'g1').slice(-1)[0].payload.strandedAssetIds, [factory], 'only the factory');
  assert.deepEqual(afterSecond.salvageWindows, {
    [TARGET]: { ownerGuildId: 'g1', evictedAtTick: afterSecond.tick, deadlineTick },
  }, 'a fresh record at the new eviction tick, one asset long — no stale deadline from the first');
  const aboard = assetsOf(afterSecond, 'g1').find((a) => a.id === miner);
  assert.equal(aboard.stranded, undefined, 'the miner aboard was not stranded');
  assert.equal(guildOf(afterSecond, 'g1').vehicles.find((v) => v.id === HEAVY).carryingAssetId, miner);
});

test('THE LAPSE fires ON the deadline, not a tick before: the still-stranded factory is destroyed through deleteAsset (its number never reissued), the owner is told once, the window closes — and the miner aboard is untouched', () => {
  const { miner, factory, deadlineTick, preLapse } = replayed();
  assert.equal(preLapse.tick, deadlineTick - 1);
  assert.ok(idsOf(preLapse, 'g1').includes(factory), 'one tick before: still there');
  assert.deepEqual(assetsOf(preLapse, 'g1').find((a) => a.id === factory).stranded, { tick: deadlineTick - 4320 });
  assert.equal(preLapse.salvageWindows[TARGET].deadlineTick, deadlineTick);
  assert.equal('removedAssetHighWater' in guildOf(preLapse, 'g1'), false, 'nothing deleted yet');

  let s = ticks(preLapse, 1);
  assert.equal(s.tick, deadlineTick);
  assert.equal(idsOf(s, 'g1').includes(factory), false, 'on the deadline: destroyed');
  assert.ok(idsOf(s, 'g1').includes(miner), 'the machine aboard is not stranded, so not destroyed');
  assert.equal(guildOf(s, 'g1').vehicles.find((v) => v.id === HEAVY).carryingAssetId, miner);
  assert.equal('salvageWindows' in s, false, 'the window closed with its last record');
  assert.deepEqual(guildOf(s, 'g1').removedAssetHighWater, { factory: assetNumberOf(factory) }, 'deleteAsset recorded it');
  const notice = eventsOf(s, 'g1').slice(-1)[0];
  assert.deepEqual(notice, {
    id: guildOf(s, 'g1').eventSeq - 1, tick: deadlineTick, type: SALVAGE_WINDOW_LAPSED,
    payload: { systemId: TARGET, systemName: TARGET_NAME, destroyedAssetIds: [factory] },
  });
  assert.equal(lapseNotices(s).length, 1, 'one notice, to the owner alone');

  // The number is never reissued: g1's next factory numbers above the destroyed one.
  let next;
  ({ s, id: next } = grantMachine(s, 'g1', 'factory', P.HOME.id));
  assert.ok(assetNumberOf(next) > assetNumberOf(factory), `${next} after destroyed ${factory}`);
  // And the window is not re-armed: ticking on changes nothing more.
  const later = ticks(s, 5);
  assert.equal(lapseNotices(later).length, 1);
});

// --- 3. the early ends -----------------------------------------------------------------------------------------------

test('ALL SALVAGED before the deadline: the lapse finds nothing, writes nothing, and only closes the record', () => {
  const { factory, deadlineTick, preLapse } = replayed();
  // The first heavy holds the miner (one machine per hold), so a second heavy, spawned in TARGET, takes the factory.
  let s = accept(preLapse, createSpawnVehicleAction({ guildId: 'g1', class: HEAVY_TRANSPORT, location: AT_TARGET }));
  const second = guildOf(s, 'g1').vehicles.slice(-1)[0].id;
  s = accept(s, load(second, factory));
  assert.deepEqual(s.salvageWindows, preLapse.salvageWindows, 'the deadline did not move');
  const eventsBefore = structuredClone(eventsOf(s, 'g1'));
  s = ticks(s, 1);
  assert.equal(s.tick, deadlineTick);
  assert.equal('salvageWindows' in s, false, 'closed');
  assert.ok(idsOf(s, 'g1').includes(factory), 'safe aboard');
  assert.deepEqual(eventsOf(s, 'g1'), eventsBefore, 'silent');
  assert.equal('removedAssetHighWater' in guildOf(s, 'g1'), false, 'nothing destroyed');
});

test('THE OWNER RE-PLANTS on the last tick before the deadline: the window closes, and ticking past the old deadline destroys nothing', () => {
  const { factory, deadlineTick, preLapse } = replayed();
  let s = ownReplant(preLapse);
  assert.equal('salvageWindows' in s, false);
  s = ticks(s, 3);
  assert.ok(s.tick > deadlineTick);
  const f = assetsOf(s, 'g1').find((a) => a.id === factory);
  assert.ok(f && f.stranded === undefined, 'the factory is the owner\'s again, an ordinary idle machine');
  assert.equal(lapseNotices(s).length, 0);
});

test('A RIVAL CLAIMS on the last tick before the deadline: the sweep takes the factory, the window closes, and ticking past the old deadline destroys nothing', () => {
  const { factory, deadlineTick, preLapse } = replayed();
  let { s, rivalKit } = rivalReady(preLapse);
  s = accept(s, rivalPlant(rivalKit));
  assert.equal('salvageWindows' in s, false);
  assert.equal(idsOf(s, 'g1').includes(factory), false, 'swept from g1');
  const inherited = assetsOf(s, 'g2').filter((a) => a.systemId === TARGET);
  assert.equal(inherited.length, 1, 'g2 holds it now');
  s = ticks(s, 3);
  assert.ok(s.tick > deadlineTick);
  assert.deepEqual(assetsOf(s, 'g2').filter((a) => a.systemId === TARGET), inherited, 'the rival\'s machine survives the old deadline');
  assert.equal(lapseNotices(s).length, 0);
});

// --- 4. partial salvage + kits -------------------------------------------------------------------------------------

test('PARTIAL SALVAGE + KITS (real ticks): three stranded, the miner salvaged at once — the deadline holds at 3 × 4320, and on it the factory AND the Outpost kit are destroyed, the miner safe', () => {
  const { s: evicted, ids, tick } = evictedWith(['miner', 'factory', 'outpost']);
  const [miner, factory, kit] = ids;
  const kitSerial = guildOf(evicted, 'g1').kitAssetSerial;
  let s = accept(evicted, load(HEAVY, miner));
  assert.deepEqual(s.salvageWindows[TARGET], { ownerGuildId: 'g1', evictedAtTick: tick, deadlineTick: tick + 12960 },
    'salvaging one out does not shorten the rest');
  s = ticks(s, 12959);
  assert.deepEqual(assetsOf(s, 'g1').filter((a) => a.stranded).map((a) => a.id), [factory, kit], 'one tick before: both still there');
  s = ticks(s, 1);
  assert.equal(s.tick, tick + 12960);
  assert.equal(idsOf(s, 'g1').includes(factory) || idsOf(s, 'g1').includes(kit), false, 'both destroyed');
  assert.ok(idsOf(s, 'g1').includes(miner), 'the salvaged miner is safe');
  assert.deepEqual(eventsOf(s, 'g1').slice(-1)[0].payload.destroyedAssetIds, [factory, kit].sort());
  assert.deepEqual(guildOf(s, 'g1').removedAssetHighWater, { factory: assetNumberOf(factory) },
    'the factory\'s number recorded; a kit is never recorded there — it numbers from its own serial');
  assert.equal(guildOf(s, 'g1').kitAssetSerial, kitSerial, 'the kit serial never goes back, so the kit id is never reissued');
  assert.equal('salvageWindows' in s, false);
});

// --- 5. determinism --------------------------------------------------------------------------------------------------

// twoLapsing(order) -> a galaxy where g1 loses TWO systems' windows on the same next tick — the case where the order
// matters, since both notices go into one guild's log and take its next two ids. Built by hand (the fixtures play one
// eviction): g1's window in TARGET, played; and a second in RIVAL, made by hand — g1 granted a miner there, g2's
// home claim removed so the system is fallow, the miner flagged stranded and a window recorded. Both deadlines are set
// to the next tick (an invariant-clean shortcut past thousands of ticks). `order` is the map's key insertion order,
// which must not matter.
function twoLapsing(order) {
  const { s: evicted } = evictedWith(['miner', 'factory']);
  const { s: base, id: rivalMiner } = grantMachine(evicted, 'g1', 'miner', RIVAL);
  const s = structuredClone(base);
  s.claims = s.claims.filter((c) => !(c.ownerGuildId === 'g2' && c.landmarkId === RIVAL));
  assetsOf(s, 'g1').find((a) => a.id === rivalMiner).stranded = { tick: s.tick };
  const records = {
    [TARGET]: { ...s.salvageWindows[TARGET], deadlineTick: s.tick + 1 },
    [RIVAL]: { ownerGuildId: 'g1', evictedAtTick: s.tick, deadlineTick: s.tick + 1 },
  };
  s.salvageWindows = Object.fromEntries(order.map((systemId) => [systemId, records[systemId]]));
  return s;
}

test('DETERMINISM: one guild losing two systems on one tick — the lapses run in systemId order whatever the map\'s key order, so its two notices take the same ids and the bytes match', () => {
  const a = twoLapsing([TARGET, RIVAL]);
  const b = twoLapsing([RIVAL, TARGET]);
  // The hand-built galaxy breaks no rule except the one it means to (g2 no longer holds its own home).
  assert.deepEqual([...new Set(rules(a))], ['home-claim-exists'], 'only the hand-removed home claim is unusual');
  const ra = tickOnce(a);
  const rb = tickOnce(b);
  assert.equal(hashState(ra), hashState(rb), 'byte-identical');
  assert.equal(hashState(tickOnce(a)), hashState(ra), 'and the same on a second run');
  assert.equal('salvageWindows' in ra, false);
  assert.equal(assetsOf(ra, 'g1').filter((x) => x.stranded).length, 0, 'nothing left stranded in either system');
  const sorted = [TARGET, RIVAL].sort();
  assert.deepEqual(lapseNotices(ra).map((e) => e.payload.systemId), sorted, 'notices written in systemId order');
  assert.deepEqual(lapseNotices(ra).map((e) => e.payload.destroyedAssetIds.length),
    sorted.map((id) => (id === TARGET ? 2 : 1)));
});

// --- 6. the snapshot ---------------------------------------------------------------------------------------------------

test('THE SNAPSHOT: the owner\'s row carries salvageWindows { [systemId]: { deadlineTick } } and nothing else of the record; the rival sees none; it goes with the window', () => {
  const { s, tick } = evictedWith(['miner']);
  const own = buildSnapshot(s, 'g1').guilds.find((g) => g.id === 'g1');
  assert.deepEqual(own.salvageWindows, { [TARGET]: { deadlineTick: tick + 4320 } });
  const god = buildSnapshot(s).guilds.find((g) => g.id === 'g1');
  assert.deepEqual(god.salvageWindows, own.salvageWindows, 'the god\'s eye reads the same row');
  assert.equal('salvageWindows' in buildSnapshot(s).guilds.find((g) => g.id === 'g2'), false, 'g2 owns no window');
  const rivalView = buildSnapshot(s, 'g2');
  assert.equal(JSON.stringify(rivalView).includes('salvageWindows'), false, 'nowhere in the rival\'s view');
  assert.equal(JSON.stringify(rivalView).includes(String(tick + 4320)), false, 'nor the deadline under another name');
  const reclaimed = ownReplant(s);
  assert.equal('salvageWindows' in buildSnapshot(reclaimed, 'g1').guilds.find((g) => g.id === 'g1'), false);
});

// --- 7. the invariants bite ------------------------------------------------------------------------------------------

test('THE INVARIANTS BITE: each checkSalvageWindows rule is red on its forced state, and the harness halts on it', () => {
  const s = ticks(evictedWith(['miner']).s, 2); // two ticks on, so "now" and the eviction tick differ
  assert.deepEqual(rules(s), [], 'the real eviction is clean');
  const forced = (mutate) => { const c = structuredClone(s); mutate(c); return rules(c); };
  const W = (c) => c.salvageWindows[TARGET];

  // A stranded asset with no window over it — an eviction that forgot to open one, or a lapse that left one behind.
  assert.deepEqual(forced((c) => { delete c.salvageWindows; }), ['stranded-asset-has-a-salvage-window (design.md §19 #67)']);
  // A held system carrying a window — a claim that forgot to close it.
  assert.ok(forced((c) => { c.claims.push({ ...c.claims.find((x) => x.landmarkId === RIVAL), claimId: 'claim_x', landmarkId: TARGET }); })
    .includes('salvage-window-only-on-a-fallow-system (design.md §19 #67)'));
  // A window at or past its deadline — a lapse that did not fire.
  assert.deepEqual(forced((c) => { W(c).deadlineTick = c.tick; }), ['salvage-window-lapses-on-its-deadline (sim/eviction.js)']);
  // An empty map — the omit-when-empty discipline.
  assert.ok(forced((c) => { c.salvageWindows = {}; }).includes('salvage-windows-omitted-when-empty (invariant 9)'));
  // The record's shape, each defect alone.
  const shape = 'salvage-window-well-formed (sim/eviction.js)';
  for (const [label, mutate] of [
    ['deadline not after the eviction', (c) => { W(c).deadlineTick = W(c).evictedAtTick; }],
    ['a fractional deadline', (c) => { W(c).deadlineTick += 0.5; }],
    ['an eviction in the future', (c) => { W(c).evictedAtTick = c.tick + 1; W(c).deadlineTick = c.tick + 5000; }],
    ['a negative eviction tick', (c) => { W(c).evictedAtTick = -1; }],
    ['an unknown owner', (c) => { W(c).ownerGuildId = 'nobody'; }],
    ['an extra key', (c) => { W(c).strandCount = 1; }],
    ['a missing key', (c) => { delete W(c).evictedAtTick; }],
    ['not a record', (c) => { c.salvageWindows[TARGET] = 17; }],
    ['no such system', (c) => { c.salvageWindows.sys_nope = { ...W(c) }; }],
  ]) assert.ok(forced(mutate).includes(shape), label);

  // And the running loop halts on one, naming the tick.
  const broken = structuredClone(s);
  delete broken.salvageWindows;
  assert.throws(() => ticks(broken, 1), /Invariant violation at tick \d+[\s\S]*stranded-asset-has-a-salvage-window/);
});

// --- 8. byte-identity + persistence --------------------------------------------------------------------------------

test('BYTE-IDENTITY: a galaxy that never evicts, an owner\'s re-claim, and a rival\'s claim of an empty fallow system carry no salvageWindows key — in state or any view', () => {
  for (const [label, s] of [['planted', ticks(planted(), 5)], ['ownReclaim', S.ownReclaim()], ['emptyFallowClaim', S.emptyFallowClaim()]]) {
    assert.equal('salvageWindows' in s, false, `${label}: state`);
    for (const view of [buildSnapshot(s), buildSnapshot(s, 'g1'), buildSnapshot(s, 'g2')]) {
      assert.equal(JSON.stringify(view).includes('salvageWindows'), false, `${label}: snapshot`);
    }
  }
  // (Their full hashes are pinned against `main` in sweep.test.js "BYTE-IDENTITY"; every other golden in the suite is a
  // galaxy that never evicts, and passes unchanged.)
});

test('PERSISTENCE: a save reloaded one tick before the deadline lapses on the same tick to the same bytes; a createState hand-in is copied, and an empty one omitted', () => {
  const { preLapse } = replayed();
  const reloaded = JSON.parse(JSON.stringify(preLapse));
  assert.equal(hashState(ticks(reloaded, 1)), hashState(ticks(preLapse, 1)));

  const windows = { [TARGET]: { ownerGuildId: 'g1', evictedAtTick: 0, deadlineTick: 4320 } };
  const scenario = { guilds: [{ id: 'g1', credits: 0, fuelHoard: 0 }], reserve: { reserveLevel: 0 }, syndicate: { ledger: 0 } };
  const handed = createState({ ...scenario, salvageWindows: windows });
  assert.deepEqual(handed.salvageWindows, windows);
  handed.salvageWindows[TARGET].deadlineTick = 1;
  assert.equal(windows[TARGET].deadlineTick, 4320, 'no aliasing into the caller\'s object');
  assert.equal('salvageWindows' in createState({ ...scenario, salvageWindows: {} }), false);
  assert.equal('salvageWindows' in createState(scenario), false);
});
