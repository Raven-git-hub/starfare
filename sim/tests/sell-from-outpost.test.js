'use strict';

// sell-from-outpost.test.js — SELL from a node (docs/syndicate-orders.md §9.2; roadmap 2.2,
// trading to/from outposts, engine slice 1a). `sellToSyndicate` finalises the guild's held sell order
// from ONE origin node: a held system (`originSystemId`, unchanged) or one of the guild's OWN Outposts
// (`originOutpostId`, new). An Outpost sale reads and drains THAT Outpost's `stockpile`, and the fuel
// leg starts at the Outpost's own hex (§9: "compute it from the node's coords").
//
// The tripwires, one per ruling:
//   - an Outpost sale drains exactly its lines from the Outpost stockpile (omit-when-empty), credits
//     Σ round(qty × price) per line, burns the Outpost→waystation leg, and schedules NO shipment;
//   - the stock gate reads the OUTPOST's stockpile (never the system pool), reject-whole naming
//     every short line, with the draft untouched;
//   - the node-held gate: an Outpost the guild does not own, or one that is gone, is refused whole;
//   - exactly one origin;
//   - conservation (invariant 2) and galactic supply hold — the Outpost goods are counted once
//     in supply, so the sale sinks them once;
//   - the capacity gate and the §8.1 quote-lock are origin-agnostic;
//   - determinism (invariant 9) across save + journal replay;
//   - the SYSTEM origin is untouched: same leg (proved against the pre-§9 search for every seed
//     system), same action shape, same drain;
//   - the snapshot publishes each own Outpost's leg (`outpostFuelCost`, the `fuelCost` entry shape),
//     while `fuelCost` stays exactly the held systems.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const { join } = require('node:path');

const { createState } = require('../state.js');
const { tick } = require('../tick.js');
const { hashState } = require('../serialize.js');
const { checkInvariants } = require('../invariants.js');
const { computeGalacticSupply } = require('../supply.js');
const { getStock } = require('../stock.js');
const { buildSnapshot } = require('../snapshot.js');
const { heldSystemIds } = require('../claims.js');
const { saveState, appendJournal, loadOrInit } = require('../persist.js');
const { isHexInBounds, seedLandmarkAtHex, getOutposts } = require('../seed.js');
const {
  nearestWaystation, nearestWaystationToHex, systemHex, hexDistance, arrivalTickFor,
} = require('../transport.js');
const {
  routeFuelCost, routeFuelCostFromHex, routeFuelBurnByTier, routeFuelBurnByTierFromHex,
  fuelValue, volumeOf, haulerTierForSpace, HAULER_TIERS, HEAVY_HOLD, GUILD_STARTING_FUEL,
} = require('../fuel.js');
const { BUILDABLE_VEHICLE_KINDS, vehicleSpec } = require('../vehicles.js');
const { OUTPOST_DEPLOY_RANGE } = require('../outposts.js');
const { starterHomeAtDistance } = require('./waystation-fixtures.js');
const {
  createAddOrderLineAction, createSellToSyndicateAction, createRemoveOutpostAction,
  validateAction, applyAction, intake,
} = require('../actions.js');
const seed = require('../../data/seed.json');

// --- the fixture: real seed geometry, DERIVED (a regen carries the tests) ---------------------------

const HOME = starterHomeAtDistance(6);   // g1's home system — a real starter, 6 hexes from a waystation
const HOME_HEX = systemHex(HOME.id);

// Every free hex (in bounds, no seed landmark) within the deploy range of HOME, in a fixed scan order —
// the hexes a guild could really have planted an Outpost on.
function freeHexesNearHome() {
  const out = [];
  for (let dq = -OUTPOST_DEPLOY_RANGE; dq <= OUTPOST_DEPLOY_RANGE; dq += 1) {
    for (let dr = -OUTPOST_DEPLOY_RANGE; dr <= OUTPOST_DEPLOY_RANGE; dr += 1) {
      const hex = { q: HOME_HEX.q + dq, r: HOME_HEX.r + dr };
      if (hexDistance(hex, HOME_HEX) > OUTPOST_DEPLOY_RANGE) continue;
      if (!isHexInBounds(hex.q, hex.r) || seedLandmarkAtHex(hex.q, hex.r)) continue;
      out.push(hex);
    }
  }
  return out;
}
const FREE = freeHexesNearHome();
// OUT_HEX — g1's Outpost: the free hex FARTHEST from any waystation (first such, scan order), so its
// leg is unmistakably its own and longer than the home system's.
const OUT_HEX = FREE.reduce((best, hex) => (
  nearestWaystationToHex(hex).distance > nearestWaystationToHex(best).distance ? hex : best));
const others = FREE.filter((h) => h.q !== OUT_HEX.q || h.r !== OUT_HEX.r);
const RIVAL_HEX = others[0];   // g2's Outpost
const SECOND_HEX = others[1];  // g1's second Outpost (snapshot ordering test)

const T1 = 'titanium';        // volume 1
const T2 = 'battery_cells';   // volume 100
const PRICE_T1 = 12;
const PRICE_T2 = 7.25;        // fractional, so per-line rounding shows: round(50 × 7.25) = round(362.5) = 363

// The premise every fuel assertion below rests on: the Outpost's leg really is a different (longer)
// leg than its anchor system's. Asserted up front so a regen that broke it fails here, by name.
const ORDER_SPACE = 300 * volumeOf(T1) + 50 * volumeOf(T2); // the main test order's cargo space
const BURN_OUT = routeFuelCostFromHex(OUT_HEX, ORDER_SPACE).fuelBurn;
const BURN_HOME = routeFuelCost(HOME.id, ORDER_SPACE).fuelBurn;
assert.ok(BURN_OUT > BURN_HOME, `fixture premise: the Outpost leg (${BURN_OUT}) must burn more than the home leg (${BURN_HOME})`);

const claim = (guildId, systemId) => ({
  claimId: `claim_home_${guildId}`, ownerGuildId: guildId, landmarkId: systemId,
  landmarkKind: 'system', claimedAtTick: 0, contested: false,
});

// outpostState(...) -> an invariant-clean galaxy: guild g1 holds HOME (and may hold stock in its pool
// there) and owns Outpost `outpost_g1_01` on OUT_HEX; rival guild g2 owns `outpost_g2_01` on RIVAL_HEX.
// Ledger-funded so invariant 2 starts balanced; reserve-stocked so invariant 1 has fuel to conserve.
function outpostState({
  outpostStock = { [T1]: 900, [T2]: 50 },
  homeStock = { [T1]: 500 },
  rivalStock = { [T1]: 70 },
  fuelHoard = GUILD_STARTING_FUEL,
  credits = 100000,
  extraOutposts = [],
} = {}) {
  const outpost = (id, ownerGuildId, coords, stock) => ({
    id, ownerGuildId, anchorSystemId: HOME.id, coords: { ...coords }, createdAtTick: 0,
    ...(stock && Object.keys(stock).length ? { stockpile: { ...stock } } : {}),
  });
  const s = createState({
    guilds: [
      {
        id: 'g1', credits, fuelHoard, homeSystemId: HOME.id, homePlanetId: HOME.homePlanet,
        outpostSerial: 1 + extraOutposts.length,
        ...(Object.keys(homeStock).length ? { stockpiles: { [HOME.id]: { ...homeStock } } } : {}),
      },
      { id: 'g2', credits: 0, fuelHoard: 0, outpostSerial: 1 },
    ],
    outposts: [
      ...extraOutposts.map((o) => outpost(o.id, 'g1', o.coords, o.stock)),
      outpost('outpost_g1_01', 'g1', OUT_HEX, outpostStock),
      outpost('outpost_g2_01', 'g2', RIVAL_HEX, rivalStock),
    ],
    reserve: { reserveLevel: 30 },
    syndicate: { ledger: -credits },
    claims: [claim('g1', HOME.id)],
  });
  s.prices[T1].posted = PRICE_T1;
  s.prices[T2].posted = PRICE_T2;
  return s;
}

const accept = (state, action) => {
  const { valid, reason } = validateAction(state, action);
  assert.equal(valid, true, `expected accepted, got: ${reason}`);
  return applyAction(state, action);
};
const refuse = (state, action) => {
  const { valid, reason } = validateAction(state, action);
  assert.equal(valid, false, 'expected a refusal');
  return reason;
};

const addSell = (good, qty) => createAddOrderLineAction({ guildId: 'g1', side: 'sell', good, qty });
const buildSell = (state, lines) => lines.reduce((s, [good, qty]) => accept(s, addSell(good, qty)), state);
const sellFromOutpost = (originOutpostId) => createSellToSyndicateAction({ guildId: 'g1', originOutpostId });
const sellFromSystem = (originSystemId) => createSellToSyndicateAction({ guildId: 'g1', originSystemId });
const outpostOf = (s, id) => s.outposts.find((o) => o.id === id);
const MAIN_ORDER = [[T1, 300], [T2, 50]];

// Invariant 1 restated by hand, so a failure names the term rather than the rule.
function assertFuelBalances(state, where) {
  const hoards = state.guilds.reduce((sum, g) => sum + g.fuelHoard + (g.deuteriumFuel || 0), 0);
  const lhs = hoards + state.reserve.reserveLevel;
  const rhs = state.audit.totalProduced - state.audit.totalConsumed;
  assert.equal(lhs, rhs, `${where}: hoards ${hoards} + reserve ${state.reserve.reserveLevel} = ${lhs}, but produced − consumed = ${rhs}`);
}

// --- 1. the sale itself ---------------------------------------------------------------------------

test('an Outpost sale drains exactly its lines from the Outpost stockpile, pays Σ round(qty × price) per line, burns the Outpost leg, and ships nothing', () => {
  const before = buildSell(outpostState(), MAIN_ORDER);
  assert.deepEqual(checkInvariants(before, before.tick), [], 'the fixture opens invariant-clean');
  const after = accept(before, sellFromOutpost('outpost_g1_01'));
  const g = after.guilds[0];

  // The drain — from the OUTPOST's stockpile, by exactly the ordered quantities. battery_cells was sold
  // down to 0, so its key is GONE (omit-when-empty), not left as a 0.
  assert.deepEqual(outpostOf(after, 'outpost_g1_01').stockpile, { [T1]: 900 - 300 },
    'titanium down by 300; battery_cells sold to 0 and omitted');
  // Nothing else moved: the guild's own system pool, and the rival's Outpost, are untouched.
  assert.equal(getStock(g, HOME.id, T1), 500, 'the home system pool is not the origin — untouched');
  assert.deepEqual(outpostOf(after, 'outpost_g2_01'), outpostOf(before, 'outpost_g2_01'), 'the rival Outpost is untouched');

  // The proceeds — rounded PER LINE (§5), funded by the ledger (invariant 2 to the credit).
  const proceeds = Math.round(300 * PRICE_T1) + Math.round(50 * PRICE_T2);
  assert.equal(proceeds, 3600 + 363, 'the per-line rounding this fixture is built to show');
  assert.equal(g.credits, before.guilds[0].credits + proceeds);
  assert.equal(after.syndicate.ledger, before.syndicate.ledger - proceeds);

  // The burn — ONE leg, from the Outpost's OWN hex to its nearest waystation, at the order's tier.
  assert.equal(g.fuelHoard, before.guilds[0].fuelHoard - BURN_OUT, `the Outpost leg burns ${BURN_OUT}`);
  assert.equal(after.audit.totalConsumed, before.audit.totalConsumed + BURN_OUT, 'the burn is recorded');
  assert.notEqual(BURN_OUT, BURN_HOME, 'and it is NOT the anchor system\'s leg');

  // Immediate settlement — no shipment is scheduled (§5: "sold goods leave the moment you place them").
  assert.deepEqual(after.shipments, before.shipments, 'no shipment created');
  assert.equal(g.sellOrder, undefined, 'the held order is cleared on success');

  // Every invariant, at the between-tick instant `POST /action` asserts at.
  assert.deepEqual(checkInvariants(after, after.tick), []);
});

test('selling an Outpost\'s whole stockpile removes the `stockpile` key — the row is exactly an empty Outpost', () => {
  const before = buildSell(outpostState({ outpostStock: { [T1]: 40 } }), [[T1, 40]]);
  const after = accept(before, sellFromOutpost('outpost_g1_01'));
  const row = outpostOf(after, 'outpost_g1_01');
  assert.equal('stockpile' in row, false, 'omit-when-empty: no `stockpile: {}` left behind');
  const { stockpile, ...withoutStock } = outpostOf(before, 'outpost_g1_01');
  assert.deepEqual(row, withoutStock, 'byte-for-byte the Outpost minus its goods');
  assert.deepEqual(checkInvariants(after, after.tick), []);
});

// --- 2. the gates ---------------------------------------------------------------------------------

test('the stock gate reads the OUTPOST\'s stockpile: reject-whole naming every short line, the system pool does not count, the draft untouched', () => {
  // The home pool holds plenty of both goods — but the origin is the Outpost, which holds 100
  // titanium and no battery_cells.
  const s = buildSell(
    outpostState({ outpostStock: { [T1]: 100 }, homeStock: { [T1]: 10000, [T2]: 10000 } }),
    [[T1, 150], [T2, 5]],
  );
  const reason = refuse(s, sellFromOutpost('outpost_g1_01'));
  assert.match(reason, /does not hold enough stock in outpost "outpost_g1_01"/);
  assert.match(reason, /titanium \(need 150, hold 100\)/);
  assert.match(reason, /battery_cells \(need 5, hold 0\)/);

  // A reject never reaches apply, so through the batch intake the whole state — draft, Outpost and
  // pool — is exactly as it was.
  const { state: after, results } = intake(s, [sellFromOutpost('outpost_g1_01')]);
  assert.equal(results[0].accepted, false);
  assert.equal(hashState(after), hashState(s), 'nothing moved');
  assert.deepEqual(after.guilds[0].sellOrder, s.guilds[0].sellOrder, 'the draft is untouched — trim and retry');
});

test('the node-held gate: an Outpost the guild does not own, or one that is gone, is refused whole', () => {
  const s = buildSell(outpostState(), [[T1, 10]]);

  // A rival's Outpost — stocked with the good, so the refusal is ownership, not stock.
  const rival = refuse(s, sellFromOutpost('outpost_g2_01'));
  assert.match(rival, /guild "g1" owns no outpost "outpost_g2_01" to sell from/);
  // An id that names no Outpost at all.
  assert.match(refuse(s, sellFromOutpost('outpost_g1_09')), /owns no outpost "outpost_g1_09"/);

  // Torn down between the popup opening and the confirm (§9.4) — the same refusal.
  const torn = accept(s, createRemoveOutpostAction({ guildId: 'g1', outpostId: 'outpost_g1_01' }));
  assert.match(refuse(torn, sellFromOutpost('outpost_g1_01')), /owns no outpost "outpost_g1_01"/);

  const { state: after } = intake(s, [sellFromOutpost('outpost_g2_01')]);
  assert.equal(hashState(after), hashState(s), 'the rival\'s stockpile and g1\'s draft are untouched');
});

test('the origin is EXACTLY ONE node — both, an empty id, or neither is refused; the creator enforces the same', () => {
  const s = buildSell(outpostState(), [[T1, 10]]);
  const both = { type: 'sellToSyndicate', guildId: 'g1', originSystemId: HOME.id, originOutpostId: 'outpost_g1_01' };
  assert.match(refuse(s, both), /ONE origin — give originSystemId or originOutpostId, not both/);
  assert.match(refuse(s, { type: 'sellToSyndicate', guildId: 'g1', originOutpostId: '' }), /originOutpostId must be a non-empty string/);
  // Neither: the system check's own refusal, word for word as before §9.
  assert.equal(refuse(s, { type: 'sellToSyndicate', guildId: 'g1' }), 'originSystemId must be a non-empty string');

  assert.throws(() => createSellToSyndicateAction({ guildId: 'g1', originSystemId: HOME.id, originOutpostId: 'outpost_g1_01' }), /exactly one/);
  assert.throws(() => createSellToSyndicateAction({ guildId: 'g1' }), /exactly one/);
  // The Outpost form carries only its own field.
  assert.deepEqual(sellFromOutpost('outpost_g1_01'), { type: 'sellToSyndicate', guildId: 'g1', originOutpostId: 'outpost_g1_01' });
});

test('the fuel gate prices the OUTPOST\'s leg: fuel enough for the home leg is not enough for the farther Outpost', () => {
  // Fuel for the home system's leg, one short of the Outpost's.
  const s = outpostState({ fuelHoard: BURN_OUT - 1, homeStock: { [T1]: 900, [T2]: 50 } });
  assert.ok(BURN_OUT - 1 >= BURN_HOME, 'premise: the hoard covers the home leg');
  const withOrder = buildSell(s, MAIN_ORDER);

  const reason = refuse(withOrder, sellFromOutpost('outpost_g1_01'));
  assert.match(reason, new RegExp(`cannot burn ${BURN_OUT} shipping this sell order from "outpost_g1_01"`));
  // The SAME order from the home system flies the shorter leg, and goes.
  const fromHome = accept(withOrder, sellFromSystem(HOME.id));
  assert.equal(fromHome.guilds[0].fuelHoard, BURN_OUT - 1 - BURN_HOME);
});

test('the capacity gate and the §8.1 quote-lock are origin-agnostic — unchanged for an Outpost origin', () => {
  // Over the heavy hold: the Outpost holds the stock (an Outpost's cap is 30 heavy holds), so the
  // refusal is the hauler's hold, with the split-the-order message.
  const big = buildSell(outpostState({ outpostStock: { [T1]: HEAVY_HOLD + 1 } }), [[T1, HEAVY_HOLD + 1]]);
  assert.match(refuse(big, sellFromOutpost('outpost_g1_01')), /exceeds the Syndicate heavy hold .* split the order/);

  // A quote issued in the future names no posted price — refused exactly as a system sale is.
  const s = buildSell(outpostState(), [[T1, 10]]);
  const future = createSellToSyndicateAction({ guildId: 'g1', originOutpostId: 'outpost_g1_01', issueTick: s.tick + 5 });
  assert.match(refuse(s, future), /in the future/);
});

// --- 3. conservation, supply, determinism ---------------------------------------------------------

test('conservation and galactic supply hold across an Outpost sale — the Outpost goods are counted once, sunk once', () => {
  const before = buildSell(outpostState(), MAIN_ORDER);
  // Before: titanium supply = home pool 500 + g1's Outpost 900 + the rival's Outpost 70.
  assert.equal(before.galacticSupply.resources[T1], 500 + 900 + 70, 'Outpost stockpiles are in supply');
  assert.equal(before.galacticSupply.resources[T2], 50);

  const after = accept(before, sellFromOutpost('outpost_g1_01'));
  // Supply drops by EXACTLY the sold quantities — not twice, not zero.
  assert.equal(after.galacticSupply.resources[T1], before.galacticSupply.resources[T1] - 300);
  assert.equal(after.galacticSupply.resources[T2], before.galacticSupply.resources[T2] - 50);
  assert.deepEqual(after.galacticSupply, computeGalacticSupply(after), 'galactic-supply-consistency, live');

  // Invariant 2: credits move guild ↔ ledger, the total is unchanged.
  const total = (s) => s.guilds.reduce((sum, g) => sum + g.credits, 0) + s.syndicate.ledger;
  assert.equal(total(after), total(before));
  assertFuelBalances(after, 'after an Outpost sale');
  assert.deepEqual(checkInvariants(after, after.tick), []);

  // And the tick that follows stays green (the cache the next tick re-derives agrees).
  const ticked = tick(after, []);
  assert.deepEqual(checkInvariants(ticked, ticked.tick), []);
});

test('determinism (invariant 9): the same Outpost sale is identical run twice, and across save + journal replay', (t) => {
  const start = outpostState();
  const actions = [addSell(T1, 300), addSell(T2, 50), sellFromOutpost('outpost_g1_01')];

  const runA = intake(start, actions).state;
  const runB = intake(start, actions).state;
  assert.equal(hashState(runA), hashState(runB), 'two runs, one hash');

  // The server's write-ahead protocol: save, then journal each action BEFORE applying it; recover from
  // disk and compare.
  const dir = fs.mkdtempSync(join(os.tmpdir(), 'starfare-outpost-sell-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  saveState(start, dir);
  let live = start;
  for (const a of actions) {
    appendJournal(live.tick, a, dir);
    live = accept(live, a);
  }
  const recovered = loadOrInit(dir, () => { throw new Error('the save must be found'); });
  assert.equal(hashState(recovered), hashState(live), 'save + replay recovers the same world');
  assert.equal(hashState(tick(recovered, [])), hashState(tick(live, [])), 'and it ticks on identically');
});

// --- 4. the SYSTEM origin is untouched ------------------------------------------------------------

// legacyNearestWaystation(systemId) — the pre-§9 `nearestWaystation` body, copied here verbatim so the
// new delegating form is checked against the OLD search, not merely against itself.
function legacyNearestWaystation(destinationSystemId) {
  const system = seed.systems.find((sys) => sys.id === destinationSystemId);
  if (!system || !system.coords) return null;
  let best = null;
  for (const outpost of getOutposts()) {
    if (!outpost.coords) continue;
    const distance = hexDistance(outpost.coords, system.coords);
    if (best === null || distance < best.distance) best = { outpost, distance };
  }
  return best;
}

test('the system leg is byte-identical to the pre-§9 search, for every seed system and every tier', () => {
  // A space at each tier boundary (and one below each), so every rate and the ceil are exercised.
  const spaces = [1, ...HAULER_TIERS.flatMap((tier) => [tier.hold - 1, tier.hold])];
  for (const sys of seed.systems) {
    const legacy = legacyNearestWaystation(sys.id);
    assert.deepEqual(nearestWaystation(sys.id), legacy, `${sys.id}: same waystation, same distance`);
    assert.deepEqual(nearestWaystationToHex(systemHex(sys.id)), legacy, `${sys.id}: the hex form agrees`);
    assert.deepEqual(routeFuelBurnByTier(sys.id), routeFuelBurnByTierFromHex(systemHex(sys.id)), `${sys.id} byTier`);
    for (const space of spaces) {
      const expected = Math.ceil(legacy.distance * HAULER_TIERS.find((t) => t.tier === haulerTierForSpace(space)).rate);
      assert.equal(routeFuelCost(sys.id, space).fuelBurn, expected, `${sys.id} @ ${space}`);
      assert.deepEqual(routeFuelCostFromHex(systemHex(sys.id), space), routeFuelCost(sys.id, space), `${sys.id} @ ${space} hex form`);
    }
  }
  // The no-route answers are unchanged too: an unknown system, or no hex at all.
  assert.equal(nearestWaystation('sys_nope'), null);
  assert.equal(nearestWaystationToHex(null), null);
  assert.deepEqual(routeFuelCostFromHex(null, 1), { fuelBurn: 0 });
  assert.throws(() => routeFuelCostFromHex(OUT_HEX, undefined), /space is required/);
});

test('a system sale beside a stocked Outpost drains only the system pool, on the system leg, with the pre-§9 action shape', () => {
  const action = sellFromSystem(HOME.id);
  assert.deepEqual(Object.keys(action), ['type', 'guildId', 'originSystemId'], 'the action shape is unchanged');

  const before = buildSell(outpostState({ homeStock: { [T1]: 500 } }), [[T1, 200]]);
  const after = accept(before, action);
  assert.equal(getStock(after.guilds[0], HOME.id, T1), 300, 'the system pool drained');
  assert.deepEqual(after.outposts, before.outposts, 'every Outpost untouched');
  assert.equal(after.guilds[0].fuelHoard, before.guilds[0].fuelHoard - routeFuelCost(HOME.id, 200).fuelBurn, 'the system leg');
  // A system sale still reads the system pool only: an Outpost full of the good does not cover it.
  const short = buildSell(outpostState({ homeStock: { [T1]: 5 } }), [[T1, 200]]);
  assert.match(refuse(short, action), new RegExp(`does not hold enough stock in system "${HOME.id}" .*titanium \\(need 200, hold 5\\)`));
});

// --- 5. the snapshot ------------------------------------------------------------------------------

test('the snapshot publishes each own Outpost\'s leg in `outpostFuelCost`, the `fuelCost` entry shape, while `fuelCost` stays exactly the held systems', () => {
  // A second g1 Outpost listed FIRST in state, so the sorted keys prove the ordering.
  const s = outpostState({ extraOutposts: [{ id: 'outpost_g1_02', coords: SECOND_HEX }] });
  const before = hashState(s);
  const snap = buildSnapshot(s);
  const g1 = snap.guilds.find((g) => g.id === 'g1');
  const g2 = snap.guilds.find((g) => g.id === 'g2');

  // `fuelCost` is EXACTLY the held systems — no Outpost key leaks in (the live client reads its keys
  // as the held-system list for the BUY / SELL target dropdowns).
  assert.deepEqual(Object.keys(g1.fuelCost), heldSystemIds(s, 'g1'));
  assert.deepEqual(Object.keys(g1.outpostFuelCost), ['outpost_g1_01', 'outpost_g1_02'], 'own Outposts only, sorted');
  assert.deepEqual(Object.keys(g2.outpostFuelCost), ['outpost_g2_01'], 'each guild sees its own');

  // The SAME entry shape as a system's, key for key and in the same order.
  const systemEntry = g1.fuelCost[HOME.id];
  for (const [id, hex] of [['outpost_g1_01', OUT_HEX], ['outpost_g1_02', SECOND_HEX]]) {
    const entry = g1.outpostFuelCost[id];
    assert.deepEqual(Object.keys(entry), Object.keys(systemEntry), `${id}: same keys as a system entry`);
    // Measured from the Outpost's OWN hex, through the engine's own functions.
    const near = nearestWaystationToHex(hex);
    const byTier = routeFuelBurnByTierFromHex(hex);
    assert.deepEqual(entry, {
      fuelBurn: byTier.light,
      creditCost: fuelValue(byTier.light, s.reserve.fuelPrice),
      travelTicks: arrivalTickFor(0, near.distance),
      vehicleTravelTicks: Object.fromEntries(
        BUILDABLE_VEHICLE_KINDS.map((cls) => [cls, Math.ceil(near.distance * vehicleSpec(cls).speed)])),
      fuelBurnByTier: byTier,
      creditCostByTier: Object.fromEntries(Object.entries(byTier).map(([tier, b]) => [tier, fuelValue(b, s.reserve.fuelPrice)])),
    }, `${id}: the leg from its own hex`);
  }

  // The anti-drift guarantee: what the snapshot quotes for the order's tier is what the sale burns.
  const tier = haulerTierForSpace(ORDER_SPACE);
  assert.equal(g1.outpostFuelCost.outpost_g1_01.fuelBurnByTier[tier], BURN_OUT);
  const sold = accept(buildSell(s, MAIN_ORDER), sellFromOutpost('outpost_g1_01'));
  assert.equal(s.guilds[0].fuelHoard - sold.guilds[0].fuelHoard, g1.outpostFuelCost.outpost_g1_01.fuelBurnByTier[tier]);

  // Derived telemetry: building it changes nothing, and no schema bump.
  assert.equal(hashState(s), before, 'building the snapshot changes no engine state');
  assert.equal(snap.schemaVersion, 7, 'additive field, no schema bump');
});

test('a guild with no Outpost gets no `outpostFuelCost` key — the row is exactly as before', () => {
  const s = createState({
    guilds: [{ id: 'g1', credits: 0, fuelHoard: 0, homeSystemId: HOME.id, homePlanetId: HOME.homePlanet }],
    reserve: { reserveLevel: 0 },
    syndicate: { ledger: 0 },
    claims: [claim('g1', HOME.id)],
  });
  const g1 = buildSnapshot(s).guilds[0];
  assert.equal('outpostFuelCost' in g1, false, 'omit-when-empty');
  assert.deepEqual(Object.keys(g1.fuelCost), [HOME.id]);
});
