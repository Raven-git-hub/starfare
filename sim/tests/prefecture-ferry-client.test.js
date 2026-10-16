'use strict';

// prefecture-ferry-client.test.js — the CLIENT half of the Prefecture kit's FERRY (roadmap 2.5, the Prefecture / claims
// slice, client PR B1; docs/territory-model.md §4 "The ferry — the unheld-system unload exception").
//
// The engine half is engine PR 1 (prefecture-ferry.test.js): `loadKit` → a route ending `{ type: 'unload' }` → the kit
// lands in the target system's idle list, and `unloadKitCheck` lets a Prefecture kit — only it — drop into a system
// NOBODY holds, never a rival's. This PR lets a player do that from the page. The tripwires:
//   1. THE GATE: the planner's unload gate (unloadRefusal) relaxes for a GROUND kit exactly as the engine relaxes
//      unloadKitCheck — checked against the engine itself, kind by kind and target by target, on a real galaxy — and
//      every other kit keeps the held-system gate.
//   2. THE PLANNER: __planFerry opens UNLOAD MODE for a kit still in inventory; __planKitRoute reads the kind off the
//      kit aboard; the deploy map is NEVER opened for a ground kit (it throws, loudly); Finalise hands a ferry back to
//      the kit's popup, a kit already aboard to the Dispatch popup, and a rival-held end to nobody.
//   3. THE POPUP: an idle Prefecture kit's row reads Ferry; its popup lists only its system's idle, empty heavies,
//      plans on unload mode (not the deploy map), and commits in the ruled order — loadKit, then the unload dispatch,
//      and nothing more when the load is refused. A space kit's popup is unchanged.
//
// The client has no DOM test harness, so — as deploy-failed-notice-client.test.js does — this cuts the page's OWN code
// out of game.html and runs it in a node:vm sandbox on stubs. The live page is driven headless (the PR's proof).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { validateAction, createGrantKitAction, createLoadKitAction } = require('../actions.js');
const { DEPLOYABLE_KITS } = require('../resources.js');
const { buildSnapshot } = require('../snapshot.js');
const P = require('./prefecture-fixtures.js');

const html = fs.readFileSync(path.join(__dirname, '..', '..', 'client', 'game.html'), 'utf8');

function cut(src, re, what) {
  const m = src.match(re);
  assert.ok(m, `${what} is present in game.html`);
  return m[0];
}
// One top-level function of a 2-space-indented script, by name, through its closing brace.
const fn = (src, name) => cut(src, new RegExp(`\\n  function ${name}\\([^)]*\\) ?\\{[\\s\\S]*?\\n  \\}\\n`), name);

const kitKindsSrc = cut(html, /<script id="kit-kinds">([\s\S]*?)<\/script>/, 'the kit-kinds script').replace(/<\/?script[^>]*>/g, '');
const deployWireSrc = cut(html, /<script id="deploy-kit-wire">([\s\S]*?)<\/script>/, 'the deploy popup script').replace(/<\/?script[^>]*>/g, '');
// The planner's unload gate and the pieces of the kit modes it is read through.
const gateSrc = ['isGroundKit', 'unloadWhere', 'unloadRefusal', 'unloadTarget', 'unloadRow', 'kitAction', 'actionSummary']
  .map((name) => fn(html, name)).join('');

const SYS = (id) => ({ landmarkKind: 'system', landmarkId: id });

// --- 1. the gate ---------------------------------------------------------------------------------------------------

// gate(kind, owned, claims) -> the planner's unload gate, running in unload mode for a kit of `kind`, for a player
// whose guild holds `owned`, in a galaxy whose system claims are `claims` ({ systemId: guildId }, every guild's).
function gate(kind, owned, claims) {
  const sandbox = {
    window: {},
    PLAN: { unload: true, unloadKind: kind, deploy: null, waypoints: [] },
    PLAYER_GUILD: { ownedSystemIds: owned },
    systemToGuild: new Map(Object.entries(claims)),
  };
  vm.runInNewContext(kitKindsSrc + gateSrc, sandbox);
  return sandbox;
}

test('the gate: a Prefecture kit may end on a system it holds or an UNCLAIMED one — never a rival\'s, never off a system', () => {
  const g = gate('prefecture', ['sys_home'], { sys_home: 'g1', sys_rival: 'g2' });
  assert.equal(g.unloadRefusal(SYS('sys_home')), '', 'its own system');
  assert.equal(g.unloadRefusal(SYS('sys_free')), '', 'an unclaimed system');
  assert.equal(g.unloadRefusal(SYS('sys_rival')), 'Held by a rival guild');
  assert.equal(g.unloadRefusal({ q: 3, r: 4 }), 'Not a system', 'a bare hex');
  assert.equal(g.unloadRefusal({ landmarkKind: 'outpost', landmarkId: 'out_1' }), 'Not a system', 'an Outpost');
  assert.equal(g.unloadRefusal(null), 'Not a system');
  // The plan list's last row says why, and an accepted end reads as the unload it will carry.
  assert.equal(g.unloadRow(SYS('sys_rival')).warn, 'can\'t unload here — held by a rival guild');
  assert.equal(g.unloadRow({ q: 3, r: 4 }).warn, 'can\'t unload here — not a system');
  assert.deepEqual({ ...g.unloadRow(SYS('sys_free')) }, { act: 'unload · kit', note: '', warn: '' });
  assert.equal(g.unloadWhere(), 'an unclaimed system or one you hold');
});

test('the gate: every OTHER kit is unchanged — a system its guild holds, and nothing else', () => {
  for (const kind of ['outpost', 'deepScan', null, 'nonsense']) {
    const g = gate(kind, ['sys_home'], { sys_home: 'g1', sys_rival: 'g2' });
    assert.equal(g.unloadRefusal(SYS('sys_home')), '', `${kind}: its own system`);
    assert.equal(g.unloadRefusal(SYS('sys_free')), 'Not a system you hold', `${kind}: an unclaimed system`);
    assert.equal(g.unloadRefusal(SYS('sys_rival')), 'Not a system you hold', `${kind}: a rival's system`);
    assert.equal(g.unloadRefusal({ q: 3, r: 4 }), 'Not a system', `${kind}: a bare hex`);
    assert.equal(g.unloadWhere(), 'a system you hold');
  }
});

test('the gate: unloadTarget is the last stop only when the gate passes it — the stops before it may be anywhere', () => {
  const g = gate('prefecture', ['sys_home'], { sys_home: 'g1', sys_rival: 'g2' });
  g.PLAN.waypoints = [{ anchor: SYS('sys_rival') }, { anchor: { q: 1, r: 1 } }, { anchor: SYS('sys_free') }];
  assert.deepEqual({ ...g.unloadTarget() }, SYS('sys_free'), 'a rival system as a turning point is fine');
  g.PLAN.waypoints = [{ anchor: SYS('sys_free') }, { anchor: SYS('sys_rival') }];
  assert.equal(g.unloadTarget(), null, 'ending on the rival\'s system is not');
  g.PLAN.waypoints = [];
  assert.equal(g.unloadTarget(), null, 'no stop yet');
});

// The ORACLE: on a real galaxy (prefecture-fixtures.js — g1 holds HOME, g2 holds RIVAL, TARGET is unclaimed), for
// every kit kind the engine knows and every class of target, the client's gate accepts exactly the routes the engine's
// dispatch accepts. The client reads its claims off g1's own VIEW, as the page does (applySnapshot → systemClaims).
test('the gate agrees with the engine\'s dispatch, for every kit kind and every class of target', () => {
  const targets = {
    'a held system': SYS(P.HOME.id),
    'an unclaimed system': SYS(P.TARGET),
    'a rival\'s system': SYS(P.RIVAL),
    'a bare hex': P.ATTACHED_HEX,
  };
  for (const kind of Object.keys(DEPLOYABLE_KITS)) {
    let s = P.kitGalaxy({ fuelHoard: 5_000 });
    s = P.accept(s, createGrantKitAction({ guildId: 'g1', systemId: P.HOME.id, kind }));
    s = P.accept(s, createLoadKitAction({ guildId: 'g1', vehicleId: P.HEAVY, assetId: P.g1Of(s).assets[0].id }));
    const claims = {};
    buildSnapshot(s, 'g1').claims.forEach((c) => { if (c.landmarkKind === 'system') claims[c.landmarkId] = c.ownerGuildId; });
    const owned = Object.keys(claims).filter((id) => claims[id] === 'g1');
    const g = gate(kind, owned, claims);
    for (const [what, anchor] of Object.entries(targets)) {
      const engine = validateAction(s, P.unloadRoute(anchor));
      const client = g.unloadRefusal(anchor);
      assert.equal(client === '', engine.valid,
        `${kind} → ${what}: the client says ${JSON.stringify(client || 'yes')}, the engine ${engine.valid ? 'accepts' : `refuses (${engine.reason})`}`);
    }
  }
});

// --- 2. the planner ------------------------------------------------------------------------------------------------

// planner() -> the planner's startPlanning and its three window entry points, on stubs: `banner()` reads the two
// banner lines it wrote, and the sandbox's PLAN is the plan it made.
function planner() {
  const nodes = {};
  const stub = () => ({ textContent: '', style: {}, classList: { add() {}, remove() {}, toggle() {} } });
  const sandbox = {
    window: { __flyTo() {} },
    document: { getElementById: (id) => nodes[id] || (nodes[id] = stub()) },
    PLAN: null, planActive: false, DEPLOY_MAP_ZOOM: 4, VECTOR_ZOOM_THRESHOLD: 4,
    PLAYER_GUILD: { ownedSystemIds: ['sys_home'] }, systemToGuild: new Map(),
    closeLoadMenu() {}, refreshPlanState() {}, resolveAnchor: () => ({ q: 0, r: 0 }),
    copyWaypoint: (wp) => ({ ...wp }), prettyClass: () => 'Heavy Transport',
    deployWords: () => ({ structure: 'Outpost', target: 'a bare hex inside the dashed ring' }),
  };
  const entry = cut(html, /\n  window\.__planDeploy = [\s\S]*?\n  function kitKindAboard\(vehicle\) \{[\s\S]*?\n  \}\n/, 'the planner\'s kit entry points');
  vm.runInNewContext(kitKindsSrc + fn(html, 'startPlanning') + fn(html, 'isGroundKit') + fn(html, 'unloadWhere') + entry, sandbox);
  sandbox.banner = () => [nodes['plan-banner-title'].textContent, nodes['plan-banner-sub'].textContent];
  return sandbox;
}
const heavy = (cargo) => ({ id: 'vehicle_g1_heavyTransport_01', class: 'heavyTransport', location: SYS('sys_home'), cargo });

test('the planner: __planFerry opens UNLOAD MODE for a Prefecture kit still in inventory, titled as a ferry', () => {
  const p = planner();
  p.window.__planFerry(heavy(undefined), 'prefecture', []);
  assert.equal(p.PLAN.unload, true);
  assert.equal(p.PLAN.unloadKind, 'prefecture');
  assert.equal(p.PLAN.fromInventory, true, 'the kit loads at the popup\'s commit');
  assert.equal(p.PLAN.deploy, null, 'not the deploy map');
  assert.deepEqual(p.banner(), ['Ferrying Prefecture kit · Heavy Transport',
    'Click a hex to add a turning point · end on an unclaimed system or one you hold · arrow keys pan']);
});

test('the planner: __planKitRoute reads the kind off the kit ABOARD — a Prefecture is ferried, any other kit returned', () => {
  const p = planner();
  p.window.__planKitRoute(heavy({ prefecture_kit: 1 }), { type: 'unload' }, []);
  assert.equal(p.PLAN.unloadKind, 'prefecture');
  assert.equal(p.PLAN.fromInventory, false, 'the kit is aboard: Finalise goes to the Dispatch popup');
  assert.equal(p.banner()[0], 'Ferrying Prefecture kit · Heavy Transport');
  p.window.__planKitRoute(heavy({ outpost_kit: 1 }), { type: 'unload' }, []);
  assert.equal(p.PLAN.unloadKind, 'outpost');
  assert.deepEqual(p.banner(), ['Returning Kit · Heavy Transport', 'Click a hex to add a turning point · end on a system you hold · arrow keys pan']);
  p.window.__planKitRoute(heavy(undefined), { type: 'unload' }, []);
  assert.equal(p.PLAN.unloadKind, null, 'an empty hold names no kind — the held-system gate');
});

test('the planner: the deploy map is NEVER opened for a ground kit — asked, it throws; a space kit opens it as before', () => {
  const p = planner();
  assert.throws(() => p.window.__planDeploy(heavy(undefined), 'prefecture', []), /deploy map was asked for a ground kit \(prefecture\)/);
  assert.throws(() => p.window.__planKitRoute(heavy({ prefecture_kit: 1 }), { type: 'deploy', kind: 'prefecture' }, []), /ground kit/);
  assert.equal(p.PLAN, null, 'no plan was made');
  p.window.__planDeploy(heavy(undefined), 'outpost', []);
  assert.equal(p.PLAN.deploy, 'outpost');
  assert.equal(p.PLAN.unload, false);
  assert.equal(p.banner()[0], 'Deploying Outpost · Heavy Transport');
});

// finaliser(plan) -> finalisePlanning on a stub planner holding `plan`; `sent` records where Finalise handed it.
function finaliser(plan, claims) {
  const sent = [];
  const sandbox = {
    window: {
      __kitDeployFinalise: (v, wps) => sent.push(['kit popup', v.id, JSON.parse(JSON.stringify(wps))]),
      __dispatchFinalise: (v, wps) => sent.push(['dispatch popup', v.id, JSON.parse(JSON.stringify(wps))]),
    },
    PLAN: plan, PLAYER_GUILD: { ownedSystemIds: ['sys_home'] }, systemToGuild: new Map(Object.entries(claims)),
    anyDeadLeg: () => false, deployTarget: () => null, copyWaypoint: (wp) => ({ ...wp }),
    exitPlanning() {},
  };
  const src = ['finalisePlanning', 'canFinalise', 'isKitPlan', 'kitWaypoints'].map((name) => fn(html, name)).join('');
  vm.runInNewContext(kitKindsSrc + gateSrc + src, sandbox);
  sandbox.finalisePlanning();
  return sent;
}

test('Finalise: a ferry goes back to the kit\'s popup with the unload on its last stop; a kit aboard to the Dispatch popup; a rival\'s system to nobody', () => {
  const claims = { sys_home: 'g1', sys_rival: 'g2' };
  const plan = (fromInventory, end) => ({ vehicle: heavy(undefined), unload: true, unloadKind: 'prefecture', deploy: null, fromInventory,
    waypoints: [{ anchor: { q: 1, r: 1 } }, { anchor: end }] });
  const unloadRoute = [{ anchor: { q: 1, r: 1 } }, { anchor: SYS('sys_free'), action: { type: 'unload' } }];
  assert.deepEqual(finaliser(plan(true, SYS('sys_free')), claims), [['kit popup', 'vehicle_g1_heavyTransport_01', unloadRoute]]);
  assert.deepEqual(finaliser(plan(false, SYS('sys_free')), claims), [['dispatch popup', 'vehicle_g1_heavyTransport_01', unloadRoute]]);
  assert.deepEqual(finaliser(plan(true, SYS('sys_rival')), claims), [], 'Finalise is held');
  assert.deepEqual(finaliser(plan(true, { q: 2, r: 2 }), claims), [], 'a bare hex: Finalise is held');
});

// --- 3. the popup --------------------------------------------------------------------------------------------------

// popup(assets, vehicles, answers) -> the page's deploy popup script, run whole on a stub DOM for player g1, whose
// view carries `assets` and `vehicles`. A stub element keeps its listeners, so a test clicks a button the popup drew
// by firing the listener the popup attached. `log` records every planner call and every action sent, in order.
function popup(assets, vehicles, answers = {}) {
  const nodes = {};
  const stub = (id) => {
    const node = { id, textContent: '', innerHTML: '', value: '', disabled: false, style: {}, on: {},
      addEventListener(type, f) { node.on[type] = f; } };
    const classes = new Set();
    node.classList = { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c) };
    return node;
  };
  const $ = (id) => nodes[id] || (nodes[id] = stub(id));
  const log = [];
  const snapshot = { guilds: [{ id: 'g1', assets, vehicles }] };
  const sandbox = {
    document: { getElementById: $, addEventListener() {} },
    window: {
      __snapshot: () => snapshot,
      __player: () => ({ guildId: 'g1' }),
      __abandonPlanning() {},
      __systemName: (id) => id,
      __planFerry: (v, kind, wps) => log.push(['planFerry', v.id, kind, wps.length]),
      __planDeploy: (v, kind, wps) => log.push(['planDeploy', v.id, kind, wps.length]),
      __fetchQuote: () => Promise.resolve({ ok: true, totalTicks: 900, credits: 12 }),
      __quoteFigures: (q) => ({ time: q.totalTicks, cost: q.credits }),
      __quoteAllows: (q) => !!(q && q.ok),
      __anchorLabel: (a) => JSON.stringify(a),
      __routeActionSummary: () => 'unload · kit',
      __routeChecks: { hereNote: () => '' },
      __sendAction: (a) => { log.push(['send', a.type, a.vehicleId, a.assetId]); return Promise.resolve(answers.load || { accepted: true }); },
      __dispatchDeploy: (v, wps) => { log.push(['dispatch', v.id, JSON.parse(JSON.stringify(wps))]); return Promise.resolve({ accepted: true }); },
    },
  };
  vm.runInNewContext(kitKindsSrc + deployWireSrc, sandbox);
  const options = () => [...$('kdCarrier').innerHTML.matchAll(/<option value="([^"]*)">/g)].map((m) => m[1]).filter(Boolean);
  const click = async (id) => { await $(id).on.click(); };
  return { w: sandbox.window, $, log, options, click };
}

const KIT = { id: 'asset_g1_prefecture_01', kind: 'prefecture', systemId: 'sys_home', deployedToVentureId: null };
const craft = (n, over) => ({ id: `vehicle_g1_heavyTransport_0${n}`, class: 'heavyTransport', status: 'idle', cargo: {}, location: SYS('sys_home'), ...over });
const FLEET = [
  craft(1),                                                 // idle, empty, berthed at the kit's system — the one carrier
  craft(2, { cargo: { titanium: 5 } }),                     // a hold not empty
  craft(3, { location: SYS('sys_other') }),                 // another system
  craft(4, { status: 'inTransit' }),                        // not idle
  craft(5, { route: { waypoints: [] } }),                   // running a route
  { ...craft(6), id: 'vehicle_g1_lightTransport_06', class: 'lightTransport' },   // not a heavy
];
const FERRY_ROUTE = [{ anchor: SYS('sys_free'), action: { type: 'unload' } }];

test('the popup: an idle Prefecture kit\'s popup is the FERRY — its words, no portrait, only its system\'s idle empty heavies', () => {
  const p = popup([KIT], FLEET);
  p.w.__openKitDeploy(KIT.id);
  assert.equal(p.$('deploy-overlay').classList.contains('open'), true);
  assert.equal(p.$('kdEyebrow').textContent, 'Ferry Prefecture kit');
  assert.equal(p.$('kdName').textContent, 'Prefecture kit · #01');
  assert.equal(p.$('kdKind').textContent, 'Prefecture');
  assert.equal(p.$('kdArt').style.backgroundImage, 'none', 'no portrait yet: the plain panel, not url(\'undefined\')');
  assert.deepEqual(p.options(), ['vehicle_g1_heavyTransport_01']);
});

test('the popup: Plan Route opens UNLOAD MODE (the ferry), never the deploy map; Finalise brings it back to Ferry', async () => {
  const p = popup([KIT], FLEET);
  p.w.__openKitDeploy(KIT.id);
  p.$('kdCarrier').value = 'vehicle_g1_heavyTransport_01';
  await p.click('kdPlanBtn');
  assert.deepEqual(p.log, [['planFerry', 'vehicle_g1_heavyTransport_01', 'prefecture', 0]]);
  await p.w.__kitDeployFinalise(FLEET[0], FERRY_ROUTE);
  assert.match(p.$('kdActions').innerHTML, /id="kdDeployBtn" type="button">Ferry<\/button>/);
  // Edit Route goes back to the same unload mode, with the route kept.
  await p.click('kdEditBtn');
  assert.deepEqual(p.log[1], ['planFerry', 'vehicle_g1_heavyTransport_01', 'prefecture', 1]);
});

test('the popup: Ferry commits in the ruled order — loadKit, then the unload route\'s dispatch', async () => {
  const p = popup([KIT], FLEET);
  p.w.__openKitDeploy(KIT.id);
  p.$('kdCarrier').value = 'vehicle_g1_heavyTransport_01';
  await p.click('kdPlanBtn');
  await p.w.__kitDeployFinalise(FLEET[0], FERRY_ROUTE);
  await p.click('kdDeployBtn');
  assert.deepEqual(p.log.slice(1), [
    ['send', 'loadKit', 'vehicle_g1_heavyTransport_01', KIT.id],
    ['dispatch', 'vehicle_g1_heavyTransport_01', FERRY_ROUTE],
  ]);
  assert.equal(p.$('deploy-overlay').classList.contains('open'), false, 'an accepted dispatch closes the popup');
});

test('the popup: a refused load sends nothing more — the kit stays in inventory, and the refusal is shown', async () => {
  const p = popup([KIT], FLEET, { load: { accepted: false, reason: 'the heavy has left' } });
  p.w.__openKitDeploy(KIT.id);
  p.$('kdCarrier').value = 'vehicle_g1_heavyTransport_01';
  await p.click('kdPlanBtn');
  await p.w.__kitDeployFinalise(FLEET[0], FERRY_ROUTE);
  await p.click('kdDeployBtn');
  assert.deepEqual(p.log.slice(1), [['send', 'loadKit', 'vehicle_g1_heavyTransport_01', KIT.id]], 'no dispatch');
  assert.match(p.$('kdSection').innerHTML, /Refused: the heavy has left/);
});

test('the popup: a SPACE kit is unchanged — Deploy words, its portrait, and Plan Route opens the deploy map', async () => {
  const outpost = { id: 'asset_g1_outpost_02', kind: 'outpost', systemId: 'sys_home', deployedToVentureId: null };
  const p = popup([outpost], FLEET);
  p.w.__openKitDeploy(outpost.id);
  assert.equal(p.$('kdEyebrow').textContent, 'Deploy Outpost');
  assert.equal(p.$('kdArt').style.backgroundImage, "url('assets/units/outpost.jpg')");
  p.$('kdCarrier').value = 'vehicle_g1_heavyTransport_01';
  await p.click('kdPlanBtn');
  assert.deepEqual(p.log, [['planDeploy', 'vehicle_g1_heavyTransport_01', 'outpost', 0]]);
  await p.w.__kitDeployFinalise(FLEET[0], [{ anchor: { q: 1, r: 1 }, action: { type: 'deploy', kind: 'outpost' } }]);
  assert.match(p.$('kdActions').innerHTML, /id="kdDeployBtn" type="button">Deploy<\/button>/);
});

// --- 4. the idle row -----------------------------------------------------------------------------------------------

test('the idle row: a Prefecture kit\'s button reads Ferry; a space kit\'s Deploy; a machine has none', () => {
  const opsScript = html.slice(html.indexOf('// ---- IDLE (§5)'));
  const sandbox = { window: {}, esc: (s) => String(s) };
  vm.runInNewContext(kitKindsSrc + fn(opsScript, 'machineHtml'), sandbox);
  const row = (kind) => sandbox.machineHtml({ id: `asset_g1_${kind}_01`, kind });
  assert.match(row('prefecture'), /<span class="mkind">Prefecture kit<\/span><button class="ops-idle-deploy" type="button" data-kit-deploy="asset_g1_prefecture_01">Ferry<\/button>/);
  assert.match(row('outpost'), /data-kit-deploy="asset_g1_outpost_01">Deploy<\/button>/);
  assert.match(row('deepScan'), /data-kit-deploy="asset_g1_deepScan_01">Deploy<\/button>/);
  assert.doesNotMatch(row('miner'), /button/);
});
