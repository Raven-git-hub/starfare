'use strict';

// outpost-teardown.test.js — the Outpost RECLAIM, engine slice (roadmap 2.2 Outpost teardown / redeploy;
// the spec is docs/outpost-teardown.md, the notice is docs/event-log.md §12). The action under test:
//   - reclaimOutpost { guildId, outpostId } — pack a deployed Outpost back into an `outpost_kit` aboard the
//     ONE empty heavy parked on its hex, instantly, and write one `outpost_packed` notice.
//
// The tripwires, one per ruling:
//   - HAPPY PATH: the row goes (and `state.outposts` with it when it was the last); the heavy holds exactly
//     `{ outpost_kit: 1 }`, idle, on the same bare hex, tick-stamped; no serial moves and no asset appears;
//   - SAME STATE AS loadKit: a heavy packed at an Outpost and a heavy loaded at a system are the same craft
//     (the shared `stowKit` helper's tripwire);
//   - EVERY REFUSAL, separately, with its reason — and a refused reclaim leaves the state byte-identical;
//     the refusals fire in the doc's §2 order;
//   - CONSERVATION / NEUTRALITY: Galactic Supply, credits, fuel, GP, the mean line and the fuel
//     entitlement are all unchanged by a reclaim;
//   - NO-OP: a refused reclaim is byte-identical to none, and a galaxy that never reclaims carries no new key;
//   - ROUND TRIP: deploy → reclaim → fly → deploy again, for real, every invariant holding on every tick, and
//     the new Outpost takes a NEW id (`_02`) — the old one is never reused;
//   - THE NOTICE: exactly one self-contained `outpost_packed` row per reclaim, born unread, riding the
//     existing log, snapshot and retention machinery unchanged; a refusal writes nothing;
//   - FAILURE MODES (§5): a second reclaim in the same tick is refused; an in-flight Syndicate buy bound for
//     the reclaimed Outpost is turned back by the existing path; a craft's location can never name a guild
//     Outpost, so nothing dangles;
//   - DETERMINISM (invariant 9): run twice, saved and restored, and journal-replayed — byte-identical.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createState } = require('../state.js');
const { tick } = require('../tick.js');
const { advance } = require('../run.js');
const { hashState } = require('../serialize.js');
const { saveState, appendJournal, loadOrInit } = require('../persist.js');
const { buildSnapshot } = require('../snapshot.js');
const { checkInvariants } = require('../invariants.js');
const { computeGalacticSupply } = require('../supply.js');
const { createZeroState } = require('../scenarios/zero-state.js');
const { dayOf } = require('../calendar.js');
const { DEFAULT_WINDOW_N } = require('../windows.js');
const { OUTPOST_PACKED, DELIVERY_TURNED_BACK, isEventLive, RETENTION_UNREAD_TICKS } = require('../events.js');
const { OUTPOST_KIT } = require('../resources.js');
const { hexDistance } = require('../transport.js');
const { getSystem, isHexInBounds, seedLandmarkAtHex } = require('../seed.js');
const { GUILD_STARTING_FUEL } = require('../fuel.js');
const { guildPoints } = require('../points.js');
const { expectedReputation, issuanceModifier } = require('../meanline.js');
const { grantFor } = require('../issuance.js');
const {
  HEAVY_TRANSPORT, MEDIUM_TRANSPORT, LIGHT_TRANSPORT, SPYCRAFT, resolveVehicleLocation,
} = require('../vehicles.js');
const { starterHomeAtDistance } = require('./waystation-fixtures.js');
const { HOME_SYSTEM } = require('./home-anchor.js');
const { kitAboard, placeCraft, kitCount } = require('./kit-fixtures.js');
const {
  validateAction, applyAction, intake,
  createReclaimOutpostAction, createRemoveOutpostAction, createSpawnOutpostAction, createSpawnVehicleAction,
  createGrantKitAction, createLoadKitAction, createDeployAssetAction, createDispatchRouteWithActionsAction,
  createDispatchVehicleAction, createTransferCargoAction, createFoundGuildAction,
  createAddOrderLineAction, createBuyFromSyndicateAction, createAcknowledgeEventAction,
} = require('../actions.js');

// --- fixtures ------------------------------------------------------------------------------------------

const HOME = starterHomeAtDistance(6); // a real starter system g1 holds
const AT_HOME = { landmarkKind: 'system', landmarkId: HOME.id };
const HOME_HEX = getSystem(HOME.id).coords;

// freeHexAtDistance(d, from, skip) -> the first in-bounds hex EXACTLY `d` from `from` holding no seed
// landmark, in a fixed scan order (`skip` asks for a later one). Derived from the seed, so a regen carries
// the tests instead of breaking them (the deploy-asset.test.js helper).
function freeHexAtDistance(d, from = HOME_HEX, skip = 0) {
  let seen = 0;
  for (let q = from.q - d; q <= from.q + d; q += 1) {
    for (let r = from.r - d; r <= from.r + d; r += 1) {
      if (hexDistance({ q, r }, from) !== d || !isHexInBounds(q, r) || seedLandmarkAtHex(q, r)) continue;
      if (seen === skip) return { q, r };
      seen += 1;
    }
  }
  throw new Error(`no free hex at distance ${d} from ${JSON.stringify(from)} on this seed`);
}

const OUT_HEX = freeHexAtDistance(2);          // where g1's Outpost stands
const SECOND_HEX = freeHexAtDistance(2, HOME_HEX, 1); // a second Outpost's hex (g1's or the rival's)
const NEXT_HEX = freeHexAtDistance(3);         // a different legal hex in deploy range — the redeploy target
const OUTPOST_01 = 'outpost_g1_01';
const OUTPOST_02 = 'outpost_g1_02';
const HEAVY_01 = 'vehicle_g1_heavyTransport_01';

const claimOf = (guildId, systemId, n) => ({
  claimId: `claim_${guildId}_${n}`, ownerGuildId: guildId, landmarkId: systemId, landmarkKind: 'system',
  claimedAtTick: 0, contested: false,
});

const accept = (state, action) => {
  const { valid, reason } = validateAction(state, action);
  assert.equal(valid, true, `expected accepted, got: ${reason}`);
  return applyAction(state, action);
};

// refuseUnchanged(state, action) -> the refusal reason, having proved the refusal changed NOTHING: the
// state intake hands back serializes byte-identically to the one it was given, and validate did not
// mutate its input either.
function refuseUnchanged(state, action) {
  const before = JSON.stringify(state);
  const { state: after, results } = intake(state, [action]);
  assert.equal(results[0].accepted, false, 'expected refused');
  assert.equal(JSON.stringify(after), before, 'a refused reclaim leaves the state byte-identical');
  assert.equal(JSON.stringify(state), before, 'and validating it mutated nothing');
  return results[0].reason;
}

// packState({ craft, ... }) -> g1 HOLDS its home and owns one Outpost (`outpost_g1_01`) on OUT_HEX, with an
// idle craft of each class in `craft` spawned PARKED on that hex (a bare-hex location — how a craft sits at
// an Outpost). g2 is a rival that holds nothing. The ledger balances the credits, so the state opens clean.
function packState({ craft = [HEAVY_TRANSPORT], credits = 0, fuelHoard = 0, reserveLevel = 0 } = {}) {
  let s = createState({
    guilds: [
      { id: 'g1', credits, fuelHoard, homeSystemId: HOME.id, homePlanetId: HOME.homePlanet },
      { id: 'g2', credits: 0, fuelHoard: 0 },
    ],
    reserve: { reserveLevel },
    syndicate: { ledger: -credits },
    claims: [claimOf('g1', HOME.id, 'home')],
  });
  s = accept(s, createSpawnOutpostAction({ guildId: 'g1', anchorSystemId: HOME.id, coords: OUT_HEX }));
  for (const vehicleClass of craft) {
    s = accept(s, createSpawnVehicleAction({ guildId: 'g1', class: vehicleClass, location: OUT_HEX }));
  }
  return s;
}

const guildOf = (s, id = 'g1') => s.guilds.find((g) => g.id === id);
const craftOf = (s, i = 0) => guildOf(s).vehicles[i];
const outpostOf = (s, id = OUTPOST_01) => (s.outposts || []).find((o) => o.id === id);
const reclaim = (over = {}) => createReclaimOutpostAction({ guildId: 'g1', outpostId: OUTPOST_01, ...over });
const eventsOf = (s, type) => (guildOf(s).events || []).filter((e) => e.type === type);

// The payload the reclaim must write — spelled out field by field from docs/event-log.md §12.
const expectedPayload = ({ outpostId = OUTPOST_01, hex = OUT_HEX, craftId = HEAVY_01, systemId = HOME.id } = {}) => ({
  outpostId,
  anchorSystemId: systemId,
  anchorSystemName: getSystem(systemId).name,
  hex: { q: hex.q, r: hex.r },
  craftId,
  craftClass: HEAVY_TRANSPORT,
});

// --- 1. the action ---------------------------------------------------------------------------------------

test('constructor: the action shape, and a missing required field throws rather than building a half action', () => {
  assert.deepEqual(reclaim(), { type: 'reclaimOutpost', guildId: 'g1', outpostId: OUTPOST_01 });
  assert.throws(() => createReclaimOutpostAction({ outpostId: OUTPOST_01 }), /createReclaimOutpostAction: guildId is required/);
  assert.throws(() => createReclaimOutpostAction({ guildId: 'g1' }), /createReclaimOutpostAction: outpostId is required/);
});

// --- 2. the happy path -----------------------------------------------------------------------------------

test('happy path: the Outpost row goes, and the parked heavy holds exactly one outpost_kit, idle on the same bare hex', () => {
  let before = packState();
  // A few ticks first, so the craft's stamp is a tick of its own, not the tick it was spawned on.
  for (let i = 0; i < 3; i += 1) before = tick(before, []);
  assert.equal(craftOf(before).updatedAtTick, null, 'premise: a fresh craft has never been mutated');
  const s = accept(before, reclaim());

  assert.equal(outpostOf(s), undefined, 'the Outpost row is gone');
  assert.equal('outposts' in s, false, 'it was the last, so the key goes (omit-when-empty, as removeOutpost)');
  const craft = craftOf(s);
  assert.deepEqual(craft.cargo, { [OUTPOST_KIT]: 1 }, 'exactly one kit, and nothing else');
  assert.equal(craft.status, 'idle');
  assert.deepEqual(craft.location, OUT_HEX, 'the same hex — now a bare one');
  assert.equal(resolveVehicleLocation(craft.location).form, 'hex');
  assert.equal(craft.updatedAtTick, s.tick, 'every mutation records its tick (§15.2)');
  assert.equal(s.tick, 3);
  assert.equal(buildSnapshot(s).guilds[0].vehicles[0].used, craft.capacity, 'the kit alone fills the heavy hold');

  const g = guildOf(s);
  assert.equal(g.outpostSerial, 1, 'the Outpost serial does not move — the id is never reissued');
  assert.equal('kitAssetSerial' in g, false, 'no kit asset is minted, so the kit serial is never created');
  assert.equal('assets' in g, false, 'and no asset appears in the inventory');
  assert.deepEqual(kitCount(s, 'g1'), { idle: 0, aboard: 1, total: 1 }, 'one kit, aboard');
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

test('happy path: with other Outposts standing, only the named one goes and state.outposts stays', () => {
  let s = packState();
  s = accept(s, createSpawnOutpostAction({ guildId: 'g1', anchorSystemId: HOME.id, coords: SECOND_HEX }));
  s = accept(s, createSpawnOutpostAction({ guildId: 'g2', anchorSystemId: HOME.id, coords: NEXT_HEX }));
  const before = structuredClone(s.outposts.filter((o) => o.id !== OUTPOST_01));
  s = accept(s, reclaim());
  assert.deepEqual(s.outposts, before, 'the other two are untouched, in order');
  assert.equal(guildOf(s).outpostSerial, 2);
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

test('same state as loadKit: a heavy packed at an Outpost is the very craft a heavy loaded at a system is', () => {
  // Via loadKit: a kit granted at home and loaded onto a heavy berthed there (kit-fixtures.js).
  let viaLoad = createState({
    guilds: [{ id: 'g1', credits: 0, fuelHoard: 0, homeSystemId: HOME.id, homePlanetId: HOME.homePlanet }],
    reserve: { reserveLevel: 0 }, syndicate: { ledger: 0 }, claims: [claimOf('g1', HOME.id, 'home')],
  });
  viaLoad = accept(viaLoad, createSpawnVehicleAction({ guildId: 'g1', class: HEAVY_TRANSPORT, location: AT_HOME }));
  viaLoad = kitAboard(viaLoad, 'g1', HEAVY_01);
  // Via the reclaim.
  const viaReclaim = accept(packState(), reclaim());

  // The craft differ only in WHERE they sit. Everything else — cargo, status, flags, tick stamp, and even
  // the order of the keys — is the same, because both went through stowKit.
  const strip = (craft) => { const c = structuredClone(craft); delete c.location; return c; };
  const a = strip(craftOf(viaLoad));
  const b = strip(craftOf(viaReclaim));
  assert.deepEqual(b, a);
  assert.equal(JSON.stringify(b), JSON.stringify(a), 'byte-identical, key order included');
  for (const flag of ['route', 'trip', 'laneEnded', 'deployFailed']) {
    assert.equal(flag in b, false, `no ${flag} on a packed heavy`);
  }
});

test('stale flags: a deployFailed or laneEnded on the heavy rides out exactly as a load leaves it', () => {
  // docs/outpost-teardown.md §5: left as kitIntoHold leaves them; the next dispatch clears them.
  const s = packState();
  craftOf(s).laneEnded = { reason: 'target-gone', tick: 0 };
  craftOf(s).deployFailed = { reason: 'occupied', tick: 0 };
  const after = accept(s, reclaim());
  assert.deepEqual(craftOf(after).laneEnded, { reason: 'target-gone', tick: 0 });
  assert.deepEqual(craftOf(after).deployFailed, { reason: 'occupied', tick: 0 });
  assert.deepEqual(checkInvariants(after, after.tick), []);
});

// --- 3. every refusal, separately, with its reason -------------------------------------------------------

test('refused: an unknown guild', () => {
  const s = packState();
  assert.equal(refuseUnchanged(s, reclaim({ guildId: 'nobody' })), 'no guild with id "nobody"');
});

test('refused: an unknown Outpost, and someone else\'s Outpost', () => {
  let s = packState();
  assert.equal(refuseUnchanged(s, reclaim({ outpostId: 'outpost_g1_09' })), 'guild "g1" owns no outpost "outpost_g1_09"');
  // g2's Outpost, with a g2 heavy parked on it: g1 cannot pack it up.
  s = accept(s, createSpawnOutpostAction({ guildId: 'g2', anchorSystemId: HOME.id, coords: SECOND_HEX }));
  s = accept(s, createSpawnVehicleAction({ guildId: 'g2', class: HEAVY_TRANSPORT, location: SECOND_HEX }));
  assert.equal(refuseUnchanged(s, reclaim({ outpostId: 'outpost_g2_01' })), 'guild "g1" owns no outpost "outpost_g2_01"');
  // …and g2 cannot pack up g1's.
  assert.equal(refuseUnchanged(s, reclaim({ guildId: 'g2' })), 'guild "g2" owns no outpost "outpost_g1_01"');
});

test('refused: goods in the stockpile — a reclaim destroys nothing', () => {
  const s = packState();
  outpostOf(s).stockpile = { titanium: 5 };
  s.galacticSupply = computeGalacticSupply(s);
  assert.equal(refuseUnchanged(s, reclaim()),
    'Outpost "outpost_g1_01" still holds goods ({"titanium":5}) — empty its stockpile first (sell from it, or load the goods out); only an empty Outpost packs into a kit');
});

test('refused: a craft queued to dock, and a craft mid-transfer in a dock slot', () => {
  // The parked heavy itself issues a dock manifest (a load of whatever is there — none is, so it would
  // move nothing): it is QUEUED until the dock step promotes it, then LOADING in a slot for its turnaround.
  let s = packState();
  s = accept(s, createTransferCargoAction({ guildId: 'g1', vehicleId: HEAVY_01, manifest: [{ dir: 'load', good: 'titanium', max: true }] }));
  assert.equal(outpostOf(s).queue.length, 1, 'premise: queued');
  assert.equal(refuseUnchanged(s, reclaim()),
    'vehicle "vehicle_g1_heavyTransport_01" is queued to dock at Outpost "outpost_g1_01" — let its transfer run, or re-dispatch it to cancel; an Outpost packs up only when nothing is docked');
  s = tick(s, []);
  assert.equal(outpostOf(s).slots.length, 1, 'premise: promoted into a slot');
  assert.equal(craftOf(s).status, 'loading');
  assert.equal(refuseUnchanged(s, reclaim()),
    'vehicle "vehicle_g1_heavyTransport_01" is mid-transfer in a dock slot at Outpost "outpost_g1_01" — wait for its turnaround to finish; an Outpost packs up only when nothing is docked');
});

test('refused: no craft parked — and a craft at home, a craft in flight, or a RIVAL\'s craft on the hex does not count', () => {
  const noCraft = 'no craft of guild "g1" is parked on Outpost "outpost_g1_01" (hex { q: ' + OUT_HEX.q + ', r: ' + OUT_HEX.r
    + ' }) — park an empty heavy transport on this Outpost first; the Outpost is packed into its hold';
  let s = packState({ craft: [] });
  assert.equal(refuseUnchanged(s, reclaim()), noCraft);
  // A heavy berthed at home is not parked here.
  s = accept(s, createSpawnVehicleAction({ guildId: 'g1', class: HEAVY_TRANSPORT, location: AT_HOME }));
  assert.equal(refuseUnchanged(s, reclaim()), noCraft);
  // In flight TO the Outpost — it has no location yet, so it is not parked anywhere.
  s.guilds[0].fuelHoard = 10_000;
  s = accept(s, createDispatchVehicleAction({ guildId: 'g1', vehicleId: HEAVY_01, waypoints: [OUT_HEX] }));
  assert.equal(craftOf(s).status, 'inTransit', 'premise: flying');
  assert.equal(refuseUnchanged(s, reclaim()), noCraft);
  // A rival's heavy sitting on the hex is a territory-era case: only the guild's own craft count.
  let rival = packState({ craft: [] });
  rival = accept(rival, createSpawnVehicleAction({ guildId: 'g2', class: HEAVY_TRANSPORT, location: OUT_HEX }));
  assert.equal(refuseUnchanged(rival, reclaim()), noCraft);
});

test('refused: more than one craft parked — even two heavies; the engine never picks', () => {
  const two = packState({ craft: [HEAVY_TRANSPORT, HEAVY_TRANSPORT] });
  assert.equal(refuseUnchanged(two, reclaim()),
    '2 craft are parked on Outpost "outpost_g1_01" ("vehicle_g1_heavyTransport_01", "vehicle_g1_heavyTransport_02") — exactly one, an empty heavy transport, may be parked there to pack it up; move the others off first');
  const mixed = packState({ craft: [HEAVY_TRANSPORT, LIGHT_TRANSPORT, SPYCRAFT] });
  assert.match(refuseUnchanged(mixed, reclaim()), /^3 craft are parked on Outpost "outpost_g1_01"/);
});

test('refused: the one parked craft is not a heavy — a light, a medium or a spycraft', () => {
  for (const vehicleClass of [LIGHT_TRANSPORT, MEDIUM_TRANSPORT, SPYCRAFT]) {
    const s = packState({ craft: [vehicleClass] });
    assert.equal(refuseUnchanged(s, reclaim()),
      `vehicle "${craftOf(s).id}" parked on Outpost "outpost_g1_01" is a ${vehicleClass} — a packed Outpost fills a whole heavy hold, so only a heavy transport can carry it; park an empty heavy here instead`);
  }
});

test('refused: the heavy is not idle', () => {
  // Hand-set, as the loadKit gate tests do: the dock check above already catches a real loading craft, so
  // this is the gate's own guard against a craft that reads as parked but is not idle.
  for (const status of ['inTransit', 'loading']) {
    const s = packState();
    craftOf(s).status = status;
    assert.equal(refuseUnchanged(s, reclaim()),
      `vehicle "vehicle_g1_heavyTransport_01" is not idle (status "${status}") — an Outpost packs into an idle heavy only`);
  }
});

test('refused: the heavy is running a lane', () => {
  // An idle craft holding a route is a lane WAITING at its stop (the kit-asset.test.js shape).
  const s = packState();
  craftOf(s).route = { waypoints: [{ anchor: AT_HOME }, { anchor: OUT_HEX }], cursor: 1, mode: 'continuous', lapsDone: 1, waiting: { reason: 'fuel', sinceTick: 0 } };
  assert.equal(refuseUnchanged(s, reclaim()),
    'vehicle "vehicle_g1_heavyTransport_01" is running a lane — a packed kit never rides one; stop the lane or re-dispatch the craft first (transport-model.md §11.10)');
});

test('refused: the heavy\'s hold is not empty — goods, or a kit already', () => {
  const ore = packState();
  craftOf(ore).cargo = { titanium: 3 };
  ore.galacticSupply = computeGalacticSupply(ore);
  assert.equal(refuseUnchanged(ore, reclaim()),
    'vehicle "vehicle_g1_heavyTransport_01" has cargo aboard ({"titanium":3}) — unload it first; a packed Outpost needs an EMPTY heavy hold');
  // A heavy already laden with a kit cannot take a second: one reclaim per empty heavy.
  const laden = packState();
  craftOf(laden).cargo = { [OUTPOST_KIT]: 1 };
  assert.match(refuseUnchanged(laden, reclaim()), /has cargo aboard \({"outpost_kit":1}\)/);
});

test('the refusals fire in the doc\'s order (outpost-teardown.md §2): peel one off, the next one shows', () => {
  // One state that fails four rules at once: goods in the stockpile, a second craft parked, a non-empty
  // hold on the heavy. Each fix uncovers exactly the next refusal, and the last fix lets it through.
  const s = packState({ craft: [HEAVY_TRANSPORT, LIGHT_TRANSPORT] });
  outpostOf(s).stockpile = { titanium: 5 };
  craftOf(s).cargo = { titanium: 1 };
  s.galacticSupply = computeGalacticSupply(s);
  assert.match(refuseUnchanged(s, reclaim({ guildId: 'nobody' })), /^no guild/, '1. the guild');
  assert.match(refuseUnchanged(s, reclaim({ outpostId: 'nope' })), /owns no outpost/, '2. the Outpost');
  assert.match(refuseUnchanged(s, reclaim()), /still holds goods/, '3. the stockpile');
  delete outpostOf(s).stockpile;
  assert.match(refuseUnchanged(s, reclaim()), /^2 craft are parked/, '5. one craft parked');
  guildOf(s).vehicles.pop();
  assert.match(refuseUnchanged(s, reclaim()), /has cargo aboard/, '7. the hold');
  delete craftOf(s).cargo;
  s.galacticSupply = computeGalacticSupply(s);
  accept(s, reclaim());
  // The docked check sits between the two: after the stockpile, before the parked count. A queued heavy
  // beside a second craft, with goods in the stockpile, shows the goods first, then the queue.
  let docked = packState({ craft: [HEAVY_TRANSPORT, LIGHT_TRANSPORT] });
  docked = accept(docked, createTransferCargoAction({ guildId: 'g1', vehicleId: HEAVY_01, manifest: [{ dir: 'load', good: 'titanium', max: true }] }));
  outpostOf(docked).stockpile = { titanium: 5 };
  docked.galacticSupply = computeGalacticSupply(docked);
  assert.match(refuseUnchanged(docked, reclaim()), /still holds goods/, '3. the stockpile, before the dock');
  delete outpostOf(docked).stockpile;
  docked.galacticSupply = computeGalacticSupply(docked);
  assert.match(refuseUnchanged(docked, reclaim()), /is queued to dock/, '4. nothing docked, before the parked count');
});

// --- 4. conservation and neutrality -----------------------------------------------------------------------

test('conservation / neutrality: Galactic Supply, credits, fuel, GP, the mean line and the fuel entitlement are unchanged', () => {
  // A REAL founded human guild (its home held, its starter heavy and kit — design.md §13), so GP, the mean
  // line and the entitlement are live, non-zero numbers. The kit is loaded onto the starter heavy and
  // deployed on a bare hex near home (placed there — the flight is the round-trip test's), so the heavy is
  // parked on its own Outpost; then the reclaim.
  const G = 'player-guild';
  let s = advance(createZeroState(), [createFoundGuildAction({ guildId: G, credits: 120, influence: 100, homeSystemId: HOME_SYSTEM })]).state;
  const heavy = `vehicle_${G}_heavyTransport_01`;
  const hex = freeHexAtDistance(2, getSystem(HOME_SYSTEM).coords);
  s = accept(s, createLoadKitAction({ guildId: G, vehicleId: heavy, assetId: `asset_${G}_outpost_01` }));
  s = placeCraft(s, G, heavy, hex);
  s = accept(s, createDeployAssetAction({ guildId: G, vehicleId: heavy }));
  const before = s;
  const after = accept(before, createReclaimOutpostAction({ guildId: G, outpostId: `outpost_${G}_01` }));

  const gb = before.guilds.find((g) => g.id === G);
  const ga = after.guilds.find((g) => g.id === G);
  // Goods: the cache is unchanged AND still equals the live sum (the between-action seam).
  assert.deepEqual(after.galacticSupply, before.galacticSupply, 'Galactic Supply cache unchanged');
  assert.deepEqual(computeGalacticSupply(after), computeGalacticSupply(before), 'and the live sum');
  assert.deepEqual(computeGalacticSupply(after), after.galacticSupply);
  // Credits and fuel (invariants 1 and 2): nothing moves, anywhere.
  assert.equal(ga.credits, gb.credits);
  assert.equal(after.syndicate.ledger, before.syndicate.ledger);
  assert.equal(ga.fuelHoard, gb.fuelHoard);
  assert.deepEqual(after.reserve, before.reserve);
  assert.deepEqual(after.audit, before.audit);
  // Game Points, the mean line and the fuel entitlement — the engine's own functions, and the same numbers
  // as the snapshot publishes them. An Outpost figures in none of them, and nor does a kit.
  assert.ok(guildPoints(before, gb) > 0, 'premise: a live GP figure');
  assert.equal(guildPoints(after, ga), guildPoints(before, gb), 'GP unchanged');
  assert.equal(expectedReputation(after, ga), expectedReputation(before, gb), 'the mean line unchanged');
  assert.equal(issuanceModifier(after, ga), issuanceModifier(before, gb), 'the issuance modifier unchanged');
  assert.equal(grantFor(after, ga), grantFor(before, gb), 'the fuel entitlement unchanged');
  assert.equal(ga.guildReputation, gb.guildReputation, 'RP unchanged');
  const row = (st) => buildSnapshot(st).guilds.find((g) => g.id === G);
  for (const field of ['guildPoints', 'expectedReputation', 'issuanceModifier', 'predictedGrant', 'guildReputation', 'credits', 'fuelHoard']) {
    assert.deepEqual(row(after)[field], row(before)[field], `snapshot ${field} unchanged`);
  }
  assert.deepEqual(checkInvariants(after, after.tick), []);
  // And it ticks on clean.
  let t = after;
  for (let i = 0; i < 5; i += 1) t = advance(t, []).state;
});

// --- 5. the no-op proof ------------------------------------------------------------------------------------

test('no-op: a refused reclaim is byte-identical to never issuing one, and a galaxy that never reclaims carries no new key', () => {
  // A deploy-and-tick run with NO reclaim, against the same run with a refused reclaim in the window: same bytes.
  const run = (extra) => {
    let s = packState({ craft: [LIGHT_TRANSPORT] }); // a light: every reclaim of it is refused
    for (let i = 0; i < 5; i += 1) s = advance(s, i === 2 ? extra : []).state;
    return s;
  };
  const without = run([]);
  const withRefused = run([reclaim(), reclaim({ outpostId: 'nope' })]);
  assert.equal(hashState(withRefused), hashState(without));
  // Nothing new appears on a guild or a craft that never reclaims: no notice log, and the craft and the
  // Outpost carry exactly the keys they always have.
  assert.equal('events' in guildOf(without), false);
  assert.equal('eventSeq' in guildOf(without), false);
  assert.deepEqual(Object.keys(craftOf(without)).sort(),
    ['capacity', 'class', 'defenseRating', 'fuelCostToRun', 'id', 'location', 'maintenanceCondition', 'ownerGuildId', 'speed', 'status', 'updatedAtTick']);
  assert.deepEqual(Object.keys(outpostOf(without)).sort(),
    ['anchorSystemId', 'capacity', 'coords', 'createdAtTick', 'dockCapacity', 'id', 'ownerGuildId']);
});

// --- 6. the round trip, for real ---------------------------------------------------------------------------

// flyAndTick(state) -> the state once every g1 craft is idle again, ticked through advance() so EVERY
// invariant is asserted on EVERY tick (it throws with the tick number on any violation).
function flyAndTick(s) {
  for (let i = 0; i < 20_000; i += 1) {
    if (guildOf(s).vehicles.every((v) => v.status === 'idle')) return s;
    s = advance(s, []).state;
  }
  throw new Error('a craft never landed');
}
const deployTo = (target) => createDispatchRouteWithActionsAction({
  guildId: 'g1', vehicleId: HEAVY_01, waypoints: [{ anchor: target, action: { type: 'deploy', kind: 'outpost' } }],
});

test('round trip: deploy → reclaim → fly → deploy again, for real — a NEW Outpost id, the old one never reused', () => {
  // 1. The existing flow: a kit granted and loaded at home, flown out and deployed on arrival.
  let s = createState({
    guilds: [{ id: 'g1', credits: 0, fuelHoard: 10_000, homeSystemId: HOME.id, homePlanetId: HOME.homePlanet }],
    reserve: { reserveLevel: 0 }, syndicate: { ledger: 0 }, claims: [claimOf('g1', HOME.id, 'home')],
  });
  s = accept(s, createSpawnVehicleAction({ guildId: 'g1', class: HEAVY_TRANSPORT, location: AT_HOME }));
  s = kitAboard(s, 'g1', HEAVY_01);
  s = accept(s, deployTo(OUT_HEX));
  s = flyAndTick(s);
  assert.deepEqual(s.outposts.map((o) => [o.id, o.coords]), [[OUTPOST_01, OUT_HEX]], 'deployed on arrival');
  assert.deepEqual(craftOf(s).location, OUT_HEX, 'and the heavy sits parked on it');
  assert.equal(craftOf(s).cargo, undefined);

  // 2. The reclaim: the heavy is laden again, idle on the bare hex.
  s = accept(s, reclaim());
  assert.deepEqual(checkInvariants(s, s.tick), [], 'every invariant holds between ticks');
  assert.equal('outposts' in s, false);
  assert.deepEqual(craftOf(s).cargo, { [OUTPOST_KIT]: 1 });
  assert.equal(craftOf(s).status, 'idle');
  assert.deepEqual(craftOf(s).location, OUT_HEX);
  assert.equal(guildOf(s).kitAssetSerial, 1, 'only the original grant ever touched the kit serial');

  // 3. Re-dispatched through the existing flow to a DIFFERENT legal hex, and deployed on arrival.
  s = accept(s, deployTo(NEXT_HEX));
  s = flyAndTick(s);
  assert.deepEqual(s.outposts.map((o) => [o.id, o.coords, o.anchorSystemId]), [[OUTPOST_02, NEXT_HEX, HOME.id]],
    'a new Outpost with a NEW id — `_02`');
  assert.equal(guildOf(s).outpostSerial, 2);
  assert.equal(craftOf(s).cargo, undefined, 'the kit was consumed');
  assert.deepEqual(kitCount(s, 'g1'), { idle: 0, aboard: 0, total: 0 });
  // The old id is never reissued: a third Outpost takes `_03`.
  s = accept(s, createSpawnOutpostAction({ guildId: 'g1', anchorSystemId: HOME.id, coords: OUT_HEX }));
  assert.deepEqual(s.outposts.map((o) => o.id), [OUTPOST_02, 'outpost_g1_03']);
  // The trip wrote exactly one notice: the reclaim's (both deploys succeeded, so no deploy_failed).
  assert.deepEqual(guildOf(s).events.map((e) => e.type), [OUTPOST_PACKED]);
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

// --- 7. the outpost_packed notice --------------------------------------------------------------------------

test('notice: a reclaim writes exactly one outpost_packed row, born unread, with the §12 payload and nothing else', () => {
  let before = packState();
  for (let i = 0; i < 4; i += 1) before = tick(before, []);
  const s = accept(before, reclaim());
  const g = guildOf(s);
  assert.equal(g.events.length, 1, 'exactly one notice');
  assert.equal(g.eventSeq, 1, 'one id taken from the guild counter');
  assert.deepEqual(g.events[0], {
    id: 0,
    tick: s.tick,
    type: OUTPOST_PACKED,
    payload: expectedPayload(),
  }, 'born unread (no readTick), on the tick the action landed, with the §12 payload');
  assert.notEqual(g.events[0].payload.anchorSystemName, HOME.id, 'the anchor is named by its SEED name');
  // `hex` is a copy, not an alias of any state: not the craft's location object, and editing the craft
  // does not reach the notice.
  const row = g.events[0];
  assert.notEqual(row.payload.hex, craftOf(s).location);
  craftOf(s).location.q += 1;
  assert.deepEqual(row.payload.hex, { q: OUT_HEX.q, r: OUT_HEX.r });
  // The rival is told nothing.
  assert.equal('events' in guildOf(s, 'g2'), false);
});

test('notice: the row passes the event-log invariant, and a forged type next to it still trips it', () => {
  const s = accept(packState(), reclaim());
  assert.deepEqual(checkInvariants(s, s.tick), [], 'outpost_packed is in the vocabulary checkEventLog reads');
  const forged = structuredClone(s);
  guildOf(forged).events.push({ id: 1, tick: forged.tick, type: 'outpost_unpacked', payload: {} });
  const rules = checkInvariants(forged, forged.tick).map((v) => v.rule);
  assert.deepEqual(rules, ['event-type-in-vocabulary (docs/event-log.md §2)'], 'only the forged row trips');
});

test('notice: it surfaces in the snapshot with whenDay (no unlockDay), unread in attention.notices, and ages out as any notice', () => {
  let s = accept(packState(), reclaim());
  const stored = guildOf(s).events[0];
  const snap = buildSnapshot(s);
  const windowN = s.windowN == null ? DEFAULT_WINDOW_N : s.windowN;
  const anchor = s.dayAnchorTick == null ? 0 : s.dayAnchorTick;
  assert.deepEqual(snap.guilds.find((g) => g.id === 'g1').events, [{ ...stored, whenDay: dayOf(stored.tick, windowN, anchor) }],
    'the stored row verbatim plus the derived whenDay — no new snapshot field');
  assert.deepEqual(snap.attention.notices, [{ guildId: 'g1', id: 0, tick: stored.tick, type: OUTPOST_PACKED, payload: stored.payload }]);
  // Acknowledge and retention are the existing ones, unchanged.
  ({ state: s } = intake(s, [createAcknowledgeEventAction({ guildId: 'g1', eventId: 0 })]));
  assert.equal(guildOf(s).events[0].readTick, s.tick);
  assert.deepEqual(buildSnapshot(s).attention.notices, [], 'read — no longer counted unread');
  assert.ok(isEventLive(stored, stored.tick + RETENTION_UNREAD_TICKS) && !isEventLive(stored, stored.tick + RETENTION_UNREAD_TICKS + 1));
});

test('notice: a REFUSED reclaim writes nothing', () => {
  const s = packState({ craft: [LIGHT_TRANSPORT] });
  const { state } = intake(s, [reclaim()]);
  assert.equal('events' in guildOf(state), false);
  assert.equal('eventSeq' in guildOf(state), false);
});

test('notice: two reclaims of two Outposts write two rows, with ascending ids', () => {
  let s = packState();
  s = accept(s, createSpawnOutpostAction({ guildId: 'g1', anchorSystemId: HOME.id, coords: SECOND_HEX }));
  s = accept(s, createSpawnVehicleAction({ guildId: 'g1', class: HEAVY_TRANSPORT, location: SECOND_HEX }));
  s = accept(s, reclaim({ outpostId: OUTPOST_02 }));
  s = accept(s, reclaim());
  const rows = guildOf(s).events;
  assert.deepEqual(rows.map((e) => [e.id, e.payload.outpostId, e.payload.craftId]), [
    [0, OUTPOST_02, 'vehicle_g1_heavyTransport_02'],
    [1, OUTPOST_01, HEAVY_01],
  ]);
  assert.deepEqual(rows[0].payload, expectedPayload({ outpostId: OUTPOST_02, hex: SECOND_HEX, craftId: 'vehicle_g1_heavyTransport_02' }));
  assert.equal('outposts' in s, false);
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

test('notice: self-contained — it reads the same after the Outpost is gone and the heavy has flown off', () => {
  let s = accept(packState({ fuelHoard: 10_000 }), reclaim());
  const written = structuredClone(guildOf(s).events[0]);
  // The heavy is sent home; its location, status and stamp all change while it flies, and again on landing.
  s = accept(s, createDispatchVehicleAction({ guildId: 'g1', vehicleId: HEAVY_01, waypoints: [AT_HOME] }));
  assert.equal(craftOf(s).status, 'inTransit');
  assert.deepEqual(guildOf(s).events[0], written);
  s = flyAndTick(s);
  assert.deepEqual(craftOf(s).location, AT_HOME);
  assert.deepEqual(guildOf(s).events[0], written, 'the notice still names where the Outpost stood, and which heavy took it');
});

// --- 8. the failure modes (outpost-teardown.md §5) ---------------------------------------------------------

test('a second reclaim in the same tick is refused — the first removed the Outpost; nothing double-mints', () => {
  const { state, results } = intake(packState(), [reclaim(), reclaim()]);
  assert.equal(results[0].accepted, true);
  assert.equal(results[1].accepted, false);
  assert.equal(results[1].reason, 'guild "g1" owns no outpost "outpost_g1_01"');
  assert.deepEqual(craftOf(state).cargo, { [OUTPOST_KIT]: 1 }, 'still exactly one kit');
  assert.equal(guildOf(state).events.length, 1, 'and exactly one notice');
});

test('an in-flight Syndicate buy bound for the reclaimed Outpost is turned back on arrival by the existing path', () => {
  // The buy-to-outpost.test.js idiom: a held order bought into the Outpost, landed by jumping to the eve
  // of its arrival. The reclaim adds no handling of its own: the arrival finds the Outpost gone.
  let s = packState({ credits: 1_000_000, fuelHoard: GUILD_STARTING_FUEL, reserveLevel: 30 });
  s.prices.titanium.posted = 12;
  s = accept(s, createAddOrderLineAction({ guildId: 'g1', side: 'buy', good: 'titanium', qty: 300 }));
  s = accept(s, createBuyFromSyndicateAction({ guildId: 'g1', destinationOutpostId: OUTPOST_01 }));
  assert.equal(s.shipments.length, 1, 'premise: one delivery in flight to the Outpost');
  s = accept(s, reclaim());
  const last = s.shipments[0].arrivalTick;
  const landed = tick({ ...s, tick: last - 1 }, []);
  assert.deepEqual(checkInvariants(landed, landed.tick), [], 'every invariant holds on the arrival tick');
  assert.deepEqual(landed.shipments, []);
  assert.equal('outposts' in landed, false, 'nothing was re-created');
  assert.deepEqual(craftOf(landed).cargo, { [OUTPOST_KIT]: 1 }, 'the packed heavy is untouched');
  assert.deepEqual(eventsOf(landed, DELIVERY_TURNED_BACK).map((e) => e.payload), [{
    guildId: 'g1', outpostId: OUTPOST_01, cargo: { titanium: 300 }, units: 300, space: 300, cause: 'outpost-gone',
  }]);
  assert.deepEqual(guildOf(landed).events.map((e) => e.type), [OUTPOST_PACKED, DELIVERY_TURNED_BACK]);
});

test('location: a craft\'s location can never name a guild Outpost — so the reclaim leaves nothing dangling', () => {
  // A landmark ref resolves only a seed system or a Syndicate waystation (getLandmark); a guild Outpost's id
  // is not a seed landmark, so naming one is not a valid location and every gate that takes one refuses it.
  const s = packState();
  const naming = { landmarkKind: 'outpost', landmarkId: OUTPOST_01 };
  assert.equal(resolveVehicleLocation(naming), null);
  assert.match(validateAction(s, createSpawnVehicleAction({ guildId: 'g1', class: HEAVY_TRANSPORT, location: naming })).reason, /location must be exactly one of/);
  assert.equal(validateAction({ ...s, guilds: s.guilds.map((g) => ({ ...g, fuelHoard: 10_000 })) },
    createDispatchVehicleAction({ guildId: 'g1', vehicleId: HEAVY_01, waypoints: [naming] })).valid, false);
  // So a craft parked at an Outpost is always on a bare hex, and stays on it, valid, after the reclaim.
  assert.deepEqual(craftOf(s).location, OUT_HEX);
  const after = accept(s, reclaim());
  assert.deepEqual(craftOf(after).location, OUT_HEX);
  assert.equal(resolveVehicleLocation(craftOf(after).location).form, 'hex');
});

test('removeOutpost is unchanged beside it: the destroy still evicts and sinks, writes no notice', () => {
  // The two actions are separate; a teardown of the same state is the old plain delete — no kit, no notice.
  const s = accept(packState(), createRemoveOutpostAction({ guildId: 'g1', outpostId: OUTPOST_01 }));
  assert.equal('outposts' in s, false);
  assert.equal(craftOf(s).cargo, undefined, 'the heavy stays empty — removeOutpost destroys, it does not pack');
  assert.equal('events' in guildOf(s), false);
});

// --- 9. determinism (invariant 9) --------------------------------------------------------------------------

test('determinism: the reclaim, run twice, is byte-identical', () => {
  const run = () => {
    let s = packState();
    s = tick(s, []);
    return accept(s, reclaim());
  };
  assert.equal(hashState(run()), hashState(run()));
});

test('save / restore and journal replay: a state saved after a reclaim restores byte-identically, and replaying the journal reproduces it', () => {
  // The spawns and the reclaim, journalled against a SAVED empty-galaxy start, as the server journals them.
  const start = createState({
    guilds: [
      { id: 'g1', credits: 0, fuelHoard: 0, homeSystemId: HOME.id, homePlanetId: HOME.homePlanet },
      { id: 'g2', credits: 0, fuelHoard: 0 },
    ],
    reserve: { reserveLevel: 0 }, syndicate: { ledger: 0 }, claims: [claimOf('g1', HOME.id, 'home')],
  });
  const actions = [
    createSpawnOutpostAction({ guildId: 'g1', anchorSystemId: HOME.id, coords: OUT_HEX }),
    createSpawnVehicleAction({ guildId: 'g1', class: HEAVY_TRANSPORT, location: OUT_HEX }),
    reclaim(),
  ];
  let direct = start;
  for (const a of actions) direct = accept(direct, a);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'starfare-reclaim-'));
  try {
    saveState(start, dir);
    for (const a of actions) appendJournal(start.tick, a, dir);
    const replayed = loadOrInit(dir, () => { throw new Error('expected the saved state to load'); });
    assert.equal(hashState(replayed), hashState(direct), 'replaying the journal reproduces the reclaim');
    assert.deepEqual(craftOf(replayed).cargo, { [OUTPOST_KIT]: 1 });
    assert.equal(guildOf(replayed).events[0].type, OUTPOST_PACKED);
    // A state SAVED after the reclaim (no journal) restores to the same bytes.
    saveState(direct, dir);
    fs.rmSync(path.join(dir, 'journal.jsonl'), { force: true });
    assert.equal(hashState(loadOrInit(dir, () => { throw new Error('expected a load'); })), hashState(direct));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
