'use strict';

// salvage-client.test.js — losing ground, client slice 4: the salvage-run client (roadmap 2.5; docs/territory-model.md
// §5, docs/operations-hub.md §4 / §5). The engine's salvage run (engine PR 2) — loadAsset in the fallow system, an
// ordinary dispatch, unloadAsset at a held system — could be played only from the operator CLI. This slice gives the
// player the controls and the display, in client/game.html only:
//   - SALVAGE on a stranded machine's IDLE row, live only when a heavy that could take it is in its system. It asks the
//     deploy popup's carrier list (shared with the kit's dropdown) and opens that popup in a salvage mode, whose one
//     commit is loadAsset;
//   - a carried machine leaves IDLE (its row carries `inTransitOnVehicleId`), and the IDLE signature moves with it;
//   - the laden heavy's hold names the machine and reads locked: on its IN TRANSIT manifest, where it read "No cargo.",
//     and on its IDLE TRANSPORTS card, where it read "Hold empty". Dock steps aside on it;
//   - UNLOAD on that card, live only at a system the guild holds, sending unloadAsset.
// As the other *-client tests do, this runs the page's OWN code — the Operations hub, unwrapped, and the deploy popup —
// in a node:vm sandbox on a stub DOM, against REAL per-guild snapshots of salvage-script.js's galaxy. Its action path
// is the real engine: an action the page sends is validated and applied to the galaxy, and the page re-reads it, as
// the shell's __refreshNow does. The live click-through is the human's Playwright pass, outside the repo.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { buildSnapshot } = require('../snapshot.js');
const { getSystem } = require('../seed.js');
const {
  validateAction, quoteDispatch, createLoadAssetAction, createUnloadAssetAction, createLoadKitAction,
  createDispatchVehicleAction, createRemoveAssetAction,
} = require('../actions.js');
const P = require('./prefecture-fixtures.js');
const X = require('./salvage-script.js');
const seed = require('../../data/seed.json');

const ROOT = path.join(__dirname, '..', '..');
const html = fs.readFileSync(path.join(ROOT, 'client', 'game.html'), 'utf8');

// This slice's words, verbatim from game.html. Draft copy, to be tuned (roadmap checklist).
const NO_HEAVY = 'No empty, idle heavy transport is berthed in this system';
// main's words, unchanged.
const STRANDED_MARK = 'Stranded · awaiting salvage';

// ---- the page's own code, cut out of game.html -----------------------------------------------------------

function cut(src, re, what) {
  const m = src.match(re);
  assert.ok(m, `${what} is present in game.html`);
  return m;
}
const kitKindsSrc = cut(html, /<script id="kit-kinds">([\s\S]*?)<\/script>/, 'the kit-kinds script')[1];
// The Operations hub's whole script without its IIFE wrapper, so its own functions land at the sandbox's top level.
const opsSrc = cut(html, /<script id="operations-tab-wire">\n\(function\(\)\{\n([\s\S]*?)\n\}\)\(\);\n<\/script>/, 'the Operations script')[1];
const deployWireSrc = cut(html, /<script id="deploy-kit-wire">([\s\S]*?)<\/script>/, 'the deploy popup script')[1];
// One function of a 2-space-indented script, by name: a one-liner, or one that closes on its own line.
const fn = (src, name) => cut(src, new RegExp(`\\n  function ${name}\\([^)]*\\) ?\\{(?:[^\\n]*\\}\\n|[\\s\\S]*?\\n  \\}\\n)`), name)[0];
const dispatchScript = html.slice(html.indexOf('  var DP = { vehicle: null'));
const dispatchSrc = ['anchorsOf', 'dpRoute', 'wireWaypoints', 'repeatAllowed', 'launchRepeat', 'dispatchActionFor']
  .map((name) => fn(dispatchScript, name)).join('');

// ---- the galaxy (salvage-script.js) --------------------------------------------------------------------------

const W = X.salvageRun();
const { HEAVY, TARGET, HOME } = P;
const TARGET_NAME = getSystem(TARGET).name;
const HOME_NAME = getSystem(HOME.id).name;

const viewOf = (s, guildId) => JSON.parse(JSON.stringify(buildSnapshot(s, guildId)));
const meOf = (snap, guildId) => snap.guilds.find((g) => g.id === guildId);
const sha = (x) => crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex');
const fmt = (n) => Number(n).toLocaleString('en-US');
const count = (s, sub) => s.split(sub).length - 1;
const settle = () => new Promise((r) => setImmediate(r));
const SYS = (id) => ({ landmarkKind: 'system', landmarkId: id });

// The board's name for a hex, as the shell's __landmarkNameAt reads it: a system on it, else a seed waystation.
function landmarkNameAt(q, r) {
  const on = (x) => x.coords && x.coords.q === q && x.coords.r === r;
  const hit = seed.systems.find(on) || seed.outposts.find(on);
  return hit ? hit.name : null;
}
const OPS_HOSTS = ['ops-lane-notices', 'ops-transit-list', 'ops-deployed-list', 'ops-idle-list', 'ops-tp-list'];

// page(state, { guildId, ops, wire }) -> the Operations hub and the deploy popup (or mutated copies) running for the
// player on a stub DOM. A stub element keeps its listeners, so a test clicks a popup button by firing the listener
// the popup attached, and setting an element's html makes the elements it names new, as the browser does (a fresh
// <select> has no value). `world.s` is the galaxy the action path writes to: __sendAction validates and applies an
// action there, and __refreshNow re-reads it and redraws the hub. `poll(s)` is the shell's next poll on `s`.
function page(state, { guildId = 'g1', ops = opsSrc, wire = deployWireSrc } = {}) {
  const world = { s: state };
  let current = viewOf(state, guildId);
  const nodes = {};
  const writes = {};
  const sent = [];
  const node = (id) => {
    if (!nodes[id]) {
      let inner = '';
      writes[id] = writes[id] || 0;
      const classes = new Set();
      const n = {
        id, textContent: '', value: '', disabled: false, style: {}, on: {},
        get innerHTML() { return inner; },
        set innerHTML(v) {
          inner = v; writes[id] += 1;
          for (const m of v.matchAll(/ id="([^"]+)"/g)) delete nodes[m[1]];
        },
        querySelectorAll: () => [],
        addEventListener(type, f) { n.on[type] = f; },
        classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c), toggle() {} },
      };
      nodes[id] = n;
    }
    return nodes[id];
  };
  const sandbox = {
    document: { getElementById: node, addEventListener() {} },
    window: {
      __player: () => ({ guildId }),
      __snapshot: () => current,
      __systemName: (id) => (getSystem(id) ? getSystem(id).name : id),
      __outpostName: (id) => id,
      __landmarkNameAt: landmarkNameAt,
      __abandonPlanning() {},
      __sendAction(a) {
        sent.push(JSON.parse(JSON.stringify(a)));
        const { valid, reason } = validateAction(world.s, a);
        if (!valid) return Promise.resolve({ accepted: false, reason });
        world.s = P.accept(world.s, a);
        return Promise.resolve({ accepted: true });
      },
      __refreshNow() { current = viewOf(world.s, guildId); sandbox.window.__opsRefresh(); return Promise.resolve(); },
    },
  };
  vm.runInNewContext(kitKindsSrc + ops, sandbox);
  vm.runInNewContext(wire, sandbox);
  const html_ = (id) => node(id).innerHTML;
  // press(host, cls, attr, value) — click a button the hub DREW: the host's html must hold a button of class `cls`
  // whose `attr` is `value`. The panel's own click listener is fired with a target whose closest() finds that button
  // by its classes or its attribute, as the browser's would.
  const press = (host, cls, attr, value) => {
    const m = html_(host).match(new RegExp(`<button class="([^"]*\\b${cls}\\b[^"]*)" type="button" ${attr}="${value}"( disabled)?>`));
    assert.ok(m, `${host} draws a ${cls} button with ${attr}="${value}"`);
    const classes = m[1].split(' ');
    const btn = { disabled: !!m[2], getAttribute: (k) => (k === attr ? value : null) };
    const finds = (sel) => sel.split(',').map((x) => x.trim()).some((x) => (x[0] === '.' ? classes.includes(x.slice(1)) : x === `[${attr}]`));
    node('tp-ops').on.click({ target: { closest: (sel) => (finds(sel) ? btn : null) } });
  };
  return {
    w: sandbox.window, page: sandbox, world, sent, $: node, press,
    open: () => sandbox.window.__opsOpen(),
    poll: (s) => { world.s = s; current = viewOf(s, guildId); sandbox.window.__opsRefresh(); },
    view: () => current,
    html: html_,
    writes: (id) => writes[id] || 0,
    hub: () => Object.fromEntries(OPS_HOSTS.map((id) => [id, node(id).innerHTML])),
    options: () => [...node('kdCarrier').innerHTML.matchAll(/<option value="([^"]*)">/g)].map((m) => m[1]).filter(Boolean),
    popupOpen: () => node('deploy-overlay').classList.contains('open'),
  };
}

// ---- what this slice draws --------------------------------------------------------------------------------

const ordinaryRow = (id, kind) => `<div class="ops-idle-machine"><span class="mid">${id}</span><span class="mkind">${kind}</span></div>`;
const strandedRow = (id, kind, button) => `<div class="ops-idle-machine stranded"><span class="mid">${id}</span>`
  + `<span class="mkind">${kind}</span>${button}<span class="mstranded">${STRANDED_MARK}</span></div>`;
const SALVAGE = (id) => `<button class="ops-idle-deploy ops-idle-salvage" type="button" data-salvage="${id}">Salvage</button>`;
const SALVAGE_NONE = `<button class="ops-idle-deploy ops-idle-salvage" type="button" disabled title="${NO_HEAVY}">Salvage</button>`;
const DEPLOY = (id) => `<button class="ops-idle-deploy" type="button" data-kit-deploy="${id}">Deploy</button>`;
const UNLOAD = (id, busy) => `<button class="ops-tp-unload" type="button" data-tp-unload="${id}"${busy ? ' disabled' : ''}>Unload</button>`;
const DOCK = (id) => `<button class="ops-tp-dock" type="button" data-tp-dock="${id}">Dock</button>`;
const carriedRow = (id, kind) => `<div class="ops-manrow"><span class="g">${kind} asset</span><span class="q">${id}</span></div>`;
const lockedHold = (v) => `<div class="ops-manrow"><span class="g">Hold</span><span class="q">${fmt(v.used)} / ${fmt(v.capacity)} · locked</span></div>`;
const NO_CARGO = '<div class="ops-manrow ops-manempty">No cargo.</div>';
const HOLD_EMPTY = '<div class="ops-manrow ops-manempty">Hold empty</div>';

// idleGroups(idleHtml) -> { systemName: the html of that system's IDLE group }.
const idleGroups = (h) => Object.fromEntries(h.split('<div class="ops-idle-sys"').slice(1)
  .map((g) => [g.match(/<span class="nm">([^<]*)<\/span>/)[1], g]));
// The guild's own craft row, and its carried machine's kind, off a view.
const craftIn = (snap, id) => meOf(snap, 'g1').vehicles.find((v) => v.id === id);
const kindOf = (snap, assetId) => meOf(snap, 'g1').assets.find((a) => a.id === assetId).kind;

// ---- 1. SALVAGE: the offer on a stranded machine's row -----------------------------------------------------

test('IDLE: a stranded miner and factory each offer Salvage while a heavy that could take them is in their system; the kit keeps Deploy; an ordinary row has nothing', () => {
  const p = page(W.stranded);
  p.open();
  const groups = idleGroups(p.html('ops-idle-list'));
  assert.ok(groups[TARGET_NAME].includes(strandedRow(W.miner, 'miner', SALVAGE(W.miner))), 'the stranded miner');
  assert.ok(groups[TARGET_NAME].includes(strandedRow(W.factory, 'factory', SALVAGE(W.factory))), 'the stranded factory');
  assert.ok(groups[TARGET_NAME].includes(strandedRow(W.kit, 'Outpost kit', DEPLOY(W.kit))), 'the stranded kit: its own Deploy, no Salvage');
  assert.ok(groups[HOME_NAME].includes(ordinaryRow(W.homeMiner, 'miner')), 'the home miner, as main drew it');
  assert.equal(count(p.html('ops-idle-list'), 'ops-idle-salvage'), 2);
  // Before the loss nothing is stranded, so nothing offers Salvage.
  const before = page(W.held);
  before.open();
  assert.equal(count(before.html('ops-idle-list'), 'ops-idle-salvage'), 0);
});

// The ORACLE. For every state and every one of g1's craft, the client offers the craft as a carrier for a stranded
// machine exactly when the engine's loadAsset accepts that craft and that machine — and the row's Salvage is live
// exactly when some craft is accepted. `fleet` puts a craft on each carrier gate; `loaded` has the heavy laden (its
// hold locked); `home` / `unloaded` have it in another system; `returned` brings it back. One more, built by hand: the
// heavy holding a lane while berthed at TARGET (the engine refuses a load onto a craft running a lane).
function laneCase() {
  const s = structuredClone(W.stranded);
  s.guilds.find((g) => g.id === 'g1').vehicles.find((v) => v.id === HEAVY).route = { waypoints: [] };
  const view = viewOf(W.stranded, 'g1');
  craftIn(view, HEAVY).route = { waypoints: [] };
  return { s, view };
}
test('the Salvage gate agrees with the engine\'s loadAsset, for every craft, every stranded machine and every state', () => {
  const cases = ['stranded', 'fleet', 'loaded', 'inFlight', 'home', 'unloaded', 'returned']
    .map((k) => ({ name: k, s: W[k], view: viewOf(W[k], 'g1') })).concat([{ name: 'lane', ...laneCase() }]);
  const offers = {};
  for (const c of cases) {
    const p = page(c.s);
    p.page.window.__snapshot = () => c.view;
    const me = meOf(c.view, 'g1');
    // Every stranded MACHINE; the stranded kit has its own load, loadKit (the next test).
    for (const a of me.assets.filter((x) => x.stranded && x.id !== W.kit)) {
      const client = p.w.__carriersFor(a).map((v) => v.id);
      const engine = me.vehicles.map((v) => v.id)
        .filter((vid) => validateAction(c.s, createLoadAssetAction({ guildId: 'g1', vehicleId: vid, assetId: a.id })).valid);
      assert.deepEqual(client, engine, `${c.name}: carriers for ${a.id}`);
      assert.equal(p.page.salvageable(a), engine.length > 0, `${c.name}: ${a.id}'s Salvage is live`);
      offers[`${c.name} ${a.kind}`] = client.length;
    }
  }
  // The premise, so the oracle is not vacuous: Salvage is live in some cases and dead in others.
  assert.deepEqual(offers, {
    'stranded miner': 1, 'stranded factory': 1, 'fleet miner': 1, 'fleet factory': 1, 'loaded factory': 0,
    'inFlight factory': 0, 'home factory': 0, 'unloaded factory': 0, 'returned factory': 1, 'lane miner': 0, 'lane factory': 0,
  });
  // …and the fleet's four extra craft are each refused for a different gate.
  const why = (vid) => validateAction(W.fleet, createLoadAssetAction({ guildId: 'g1', vehicleId: vid, assetId: W.miner })).reason;
  assert.match(why(W.craft.light), /is a lightTransport/);
  assert.match(why(W.craft.goods), /has cargo aboard/);
  assert.match(why(W.craft.busy), /is not idle/);
  assert.match(why(W.craft.away), /berthed in its own system/);
  assert.match(validateAction(W.loaded, createLoadAssetAction({ guildId: 'g1', vehicleId: HEAVY, assetId: W.factory })).reason, /is carrying asset .* the hold is locked/);
});

test('the kit\'s carrier list is the same list, and no longer offers a heavy whose hold a machine has locked', () => {
  for (const k of ['stranded', 'fleet', 'loaded', 'returned']) {
    const p = page(W[k]);
    const kit = meOf(p.view(), 'g1').assets.find((a) => a.id === W.kit);
    const engine = meOf(p.view(), 'g1').vehicles.map((v) => v.id)
      .filter((vid) => validateAction(W[k], createLoadKitAction({ guildId: 'g1', vehicleId: vid, assetId: W.kit })).valid);
    assert.deepEqual(p.w.__carriersFor(kit).map((v) => v.id), engine, `${k}: carriers for the kit`);
  }
  // main's list (no machine-aboard term) put back: in `loaded` it offers the laden heavy, which the engine refuses.
  const term = ' && v.carryingAssetId == null';
  assert.ok(deployWireSrc.includes(term), 'the term this test removes is there');
  const m = page(W.loaded, { wire: deployWireSrc.replace(term, '') });
  const kit = meOf(m.view(), 'g1').assets.find((a) => a.id === W.kit);
  assert.deepEqual(m.w.__carriersFor(kit).map((v) => v.id), [HEAVY]);
  assert.equal(validateAction(W.loaded, createLoadKitAction({ guildId: 'g1', vehicleId: HEAVY, assetId: W.kit })).valid, false);
});

// ---- 2. SALVAGE: the popup and the load ---------------------------------------------------------------------

test('Salvage opens the deploy popup for that machine, offers only the carriers the engine accepts, and sends one well-formed loadAsset', async () => {
  const p = page(W.fleet);
  p.open();
  p.press('ops-idle-list', 'ops-idle-salvage', 'data-salvage', W.miner);
  assert.equal(p.popupOpen(), true);
  assert.equal(p.$('kdEyebrow').textContent, 'Salvage Miner');
  assert.equal(p.$('kdName').textContent, `Miner · #${W.miner.split('_').pop()}`);
  assert.equal(p.$('kdKind').textContent, 'Miner');
  assert.equal(p.$('kdStored').textContent, TARGET_NAME);
  assert.equal(p.$('kdArt').style.backgroundImage, "url('assets/units/heavytransport.jpg')");
  assert.ok(fs.existsSync(path.join(ROOT, 'client', 'assets', 'units', 'heavytransport.jpg')), 'an existing portrait');
  assert.deepEqual(p.options(), [HEAVY], 'of five craft, only the one loadAsset accepts');
  assert.equal(p.$('kdSalvageBtn').disabled, true, 'Salvage waits for a carrier');
  p.$('kdCarrier').value = HEAVY;
  p.$('kdCarrier').on.change();
  assert.equal(p.$('kdSalvageBtn').disabled, false);
  await p.$('kdSalvageBtn').on.click();
  assert.deepEqual(p.sent, [createLoadAssetAction({ guildId: 'g1', vehicleId: HEAVY, assetId: W.miner })]);
  assert.equal(craftIn(viewOf(p.world.s, 'g1'), HEAVY).carryingAssetId, W.miner, 'the engine took it: the miner is aboard');
  assert.equal(p.popupOpen(), false, 'an accepted load closes the popup');
  // The page re-read the galaxy at once: the miner has left IDLE, and the heavy's card names it.
  assert.equal(p.html('ops-idle-list').includes(W.miner), false);
  assert.ok(p.html('ops-tp-list').includes(carriedRow(W.miner, 'miner')));
});

test('Salvage refused: the engine\'s reason shows, the popup stays open, nothing is aboard; a carrier gone from the page\'s own snapshot sends nothing', async () => {
  const p = page(W.stranded);
  p.open();
  p.press('ops-idle-list', 'ops-idle-salvage', 'data-salvage', W.factory);
  p.$('kdCarrier').value = HEAVY;
  // The galaxy moves on before the click lands: the heavy has been dispatched away.
  p.world.s = P.accept(W.stranded, createDispatchVehicleAction({ guildId: 'g1', vehicleId: HEAVY, waypoints: [P.AT_HOME] }));
  await p.$('kdSalvageBtn').on.click();
  assert.deepEqual(p.sent.map((a) => a.type), ['loadAsset']);
  assert.match(p.$('kdSection').innerHTML, /Refused: vehicle &quot;vehicle_g1_heavyTransport_01&quot; is not idle/);
  assert.equal(p.popupOpen(), true);
  assert.equal(craftIn(viewOf(p.world.s, 'g1'), HEAVY).carryingAssetId, undefined);
  assert.equal(p.$('kdCarrier').value, HEAVY, 'the pick is kept while the page still offers it');

  // The page's own snapshot shows the heavy gone (here it is at HOME): the click re-reads it, sends nothing, and the
  // dropdown redraws with nothing to pick.
  const q = page(W.stranded);
  q.open();
  q.press('ops-idle-list', 'ops-idle-salvage', 'data-salvage', W.factory);
  q.$('kdCarrier').value = HEAVY;
  q.poll(W.unloaded);
  await q.$('kdSalvageBtn').on.click();
  assert.deepEqual(q.sent, []);
  assert.deepEqual(q.options(), []);
  assert.match(q.$('kdCarrier').innerHTML, /No Available Transport/);
});

test('the salvage popup opens for a stranded machine only — not an ordinary one, a kit, one already aboard, or an unknown id', () => {
  for (const [state, id] of [[W.stranded, W.homeMiner], [W.stranded, W.kit], [W.loaded, W.miner], [W.stranded, 'asset_g1_miner_99']]) {
    const p = page(state);
    p.w.__openSalvage(id);
    assert.equal(p.popupOpen(), false, id);
    assert.equal(p.$('kdEyebrow').textContent, '', `${id}: nothing written`);
  }
  // A disabled Salvage carries no id, so a click on it opens nothing.
  const p = page(W.loaded);
  p.open();
  assert.ok(p.html('ops-idle-list').includes(strandedRow(W.factory, 'factory', SALVAGE_NONE)), 'the factory, with no carrier');
  p.page.window.__openSalvage = () => assert.fail('a disabled Salvage must not open the popup');
  p.$('tp-ops').on.click({ target: { closest: (sel) => (sel === '.ops-idle-salvage' ? { getAttribute: () => null } : null) } });
});

// ---- 3. IDLE: a carried machine is not idle ----------------------------------------------------------------

test('IDLE: a carried machine is absent from the list while aboard, and back as an ordinary row once unloaded — the signature moving each time', () => {
  const p = page(W.stranded);
  p.open();
  const listed = () => p.html('ops-idle-list').includes(W.miner);
  assert.equal(listed(), true);
  const steps = [['loaded', false], ['inFlight', false], ['home', false], ['unloaded', true]];
  for (const [k, shown] of steps) {
    const before = p.writes('ops-idle-list');
    p.poll(W[k]);
    assert.equal(listed(), shown, `${k}: the miner ${shown ? 'listed' : 'absent'}`);
    if (k !== 'inFlight' && k !== 'home') assert.equal(p.writes('ops-idle-list'), before + 1, `${k}: redrawn`);
  }
  // Unloaded at HOME, it is an ordinary idle machine there: no flag, no button.
  assert.ok(idleGroups(p.html('ops-idle-list'))[HOME_NAME].includes(ordinaryRow(W.miner, 'miner')));
  // Absent exactly as if its row were not in the view at all: the only thing read is `inTransitOnVehicleId`.
  const view = viewOf(W.home, 'g1');
  const aboard = meOf(view, 'g1').assets.find((a) => a.id === W.miner);
  assert.equal(aboard.inTransitOnVehicleId, HEAVY, 'premise: the snapshot publishes the pointer');
  const sigOf = (v) => p.page.idleSignature(p.page.myIdle(meOf(v, 'g1')));
  const without = viewOf(W.home, 'g1');
  meOf(without, 'g1').assets = meOf(without, 'g1').assets.filter((a) => a.id !== W.miner);
  assert.equal(sigOf(view), sigOf(without));
  assert.equal(new Set(['stranded', 'loaded', 'unloaded'].map((k) => sigOf(viewOf(W[k], 'g1')))).size, 3);

  // main's member rule put back: the loaded miner stays listed under the fallow system, as an ordinary row.
  const MAIN_MYIDLE = 'return a.deployedToVentureId == null; });';
  const NEW_MYIDLE = 'return a.deployedToVentureId == null && a.inTransitOnVehicleId == null; });';
  assert.ok(opsSrc.includes(NEW_MYIDLE), 'the line this test swaps is there');
  const m = page(W.loaded, { ops: opsSrc.replace(NEW_MYIDLE, MAIN_MYIDLE) });
  m.open();
  assert.ok(idleGroups(m.html('ops-idle-list'))[TARGET_NAME].includes(ordinaryRow(W.miner, 'miner')));
});

test('IDLE: a heavy arriving in the fallow system makes Salvage live with nothing else about the row changing — the signature sees it', () => {
  const [unloaded, returned] = [viewOf(W.unloaded, 'g1'), viewOf(W.returned, 'g1')];
  const factoryRow = (v) => JSON.stringify(meOf(v, 'g1').assets.find((a) => a.id === W.factory));
  assert.equal(factoryRow(returned), factoryRow(unloaded), 'premise: the factory\'s own row is unchanged');
  const p = page(W.unloaded);
  p.open();
  assert.ok(p.html('ops-idle-list').includes(strandedRow(W.factory, 'factory', SALVAGE_NONE)));
  p.poll(W.returned);
  assert.ok(p.html('ops-idle-list').includes(strandedRow(W.factory, 'factory', SALVAGE(W.factory))), 'live on the poll after it lands');
  const writes = p.writes('ops-idle-list');
  p.poll(W.returned);
  assert.equal(p.writes('ops-idle-list'), writes, 'an unchanged poll still rebuilds nothing');

  // Without the salvage term the list never redraws, and the dead button stays dead.
  const term = " + (salvageable(a) ? '+salvage' : '')";
  assert.ok(opsSrc.includes(term), 'the term this test removes is there');
  const m = page(W.unloaded, { ops: opsSrc.replace(term, '') });
  m.open();
  m.poll(W.returned);
  assert.ok(m.html('ops-idle-list').includes(strandedRow(W.factory, 'factory', SALVAGE_NONE)), 'stale');
});

// ---- 4. the laden heavy: its hold, in transit and idle ---------------------------------------------------

test('IN TRANSIT: the laden heavy\'s manifest names the machine and reads the hold full and locked, where main read "No cargo."', () => {
  const view = viewOf(W.inFlight, 'g1');
  const v = craftIn(view, HEAVY);
  assert.deepEqual([v.status, v.carryingAssetId, v.used], ['inTransit', W.miner, v.capacity], 'premise: flying, laden, the hold full');
  const p = page(W.inFlight);
  p.open();
  const transit = p.html('ops-transit-list');
  assert.ok(transit.includes('<div class="ops-manhd">Manifest</div>' + carriedRow(W.miner, 'miner') + lockedHold(v)));
  assert.equal(transit.includes(NO_CARGO), false);
  assert.doesNotMatch(transit, /Unload|null|undefined/);
  // A rival sees none of it: g2's hub carries no trace of the machine.
  const g2 = page(W.inFlight, { guildId: 'g2' });
  g2.open();
  assert.equal(JSON.stringify(g2.hub()).includes(W.miner), false);
  // No player act changes a hold in flight, but the operator's removeAsset of the carried machine empties it there and
  // then (engine PR 2). The row's signature carries the machine, so the open manifest redraws to "No cargo.".
  const emptied = P.accept(W.inFlight, createRemoveAssetAction({ guildId: 'g1', assetId: W.miner }));
  assert.deepEqual([craftIn(viewOf(emptied, 'g1'), HEAVY).status, craftIn(viewOf(emptied, 'g1'), HEAVY).carryingAssetId], ['inTransit', undefined]);
  p.poll(emptied);
  assert.ok(p.html('ops-transit-list').includes('<div class="ops-manhd">Manifest</div>' + NO_CARGO));
});

test('IDLE TRANSPORTS: the laden heavy\'s card names the machine and reads locked; Dock steps aside; Unload only at a system g1 holds', () => {
  const card = (k) => { const p = page(W[k]); p.open(); return p.html('ops-tp-list'); };
  const loadedView = viewOf(W.loaded, 'g1');
  const v = craftIn(loadedView, HEAVY);
  for (const [k, unload] of [['loaded', false], ['home', true]]) {
    const h = card(k);
    assert.ok(h.includes(`<span class="v">${fmt(v.used)} / ${fmt(v.capacity)} · locked</span></div>` + carriedRow(W.miner, 'miner')), `${k}: the hold`);
    assert.equal(h.includes(HOLD_EMPTY), false, `${k}: not "Hold empty"`);
    assert.equal(h.includes('data-tp-dock'), false, `${k}: no Dock on a locked hold`);
    assert.equal(h.includes(UNLOAD(HEAVY)), unload, `${k}: Unload ${unload ? 'offered' : 'not offered'}`);
    assert.ok(h.includes(`data-tp-dispatch="${HEAVY}">Dispatch</button>`), `${k}: Dispatch, as ever`);
  }
  // Empty again after the unload, the card is main's: Hold empty, Dock back, no Unload.
  const after = card('unloaded');
  assert.ok(after.includes(HOLD_EMPTY) && after.includes(DOCK(HEAVY)));
  assert.equal(after.includes('ops-tp-unload'), false);
});

test('IDLE TRANSPORTS redraws when a machine is loaded or unloaded in place, which main\'s signature never saw', () => {
  const p = page(W.stranded);
  p.open();
  assert.ok(p.html('ops-tp-list').includes(HOLD_EMPTY));
  p.poll(W.loaded);
  assert.ok(p.html('ops-tp-list').includes(carriedRow(W.miner, 'miner')), 'named on the poll after the load');
  const term = " + ':' + (v.carryingAssetId || '') + (unloadable(v) ? '+unload' : '')";
  assert.ok(opsSrc.includes(term), 'the term this test removes is there');
  const m = page(W.stranded, { ops: opsSrc.replace(term, '') });
  m.open();
  m.poll(W.loaded);
  assert.ok(m.html('ops-tp-list').includes(HOLD_EMPTY), 'without it: the card freezes at "Hold empty" — nothing it keyed on moved');
});

// The ORACLE for Unload: for every state, every one of g1's craft, and four cases built by hand for the laden heavy at
// HOME (berthed at a bare hex, at an Outpost, at a rival's system; and holding a lane, which no laden heavy can reach in
// play — the engine refuses it a lane — but which the gate mirrors), the client offers Unload exactly when the
// engine's unloadAsset accepts.
test('the Unload gate agrees with the engine\'s unloadAsset, for every craft, every state, and every kind of berth', () => {
  const homeWith = (field, value) => {
    const s = structuredClone(W.home);
    s.guilds.find((g) => g.id === 'g1').vehicles.find((v) => v.id === HEAVY)[field] = value;
    const view = viewOf(W.home, 'g1');
    craftIn(view, HEAVY)[field] = value;
    return { s, view };
  };
  const berth = (loc) => homeWith('location', loc);
  const cases = ['stranded', 'fleet', 'loaded', 'inFlight', 'home', 'unloaded', 'returned']
    .map((k) => ({ name: k, s: W[k], view: viewOf(W[k], 'g1') }))
    .concat([
      { name: 'bare hex', ...berth({ q: P.ATTACHED_HEX.q, r: P.ATTACHED_HEX.r }) },
      { name: 'outpost', ...berth({ landmarkKind: 'outpost', landmarkId: 'outpost_g1_01' }) },
      { name: 'rival system', ...berth(SYS(P.RIVAL)) },
      { name: 'lane', ...homeWith('route', { waypoints: [] }) },
    ]);
  const offered = [];
  for (const c of cases) {
    const p = page(c.s);
    p.page.window.__snapshot = () => c.view;
    for (const v of meOf(c.view, 'g1').vehicles) {
      const engine = validateAction(c.s, createUnloadAssetAction({ guildId: 'g1', vehicleId: v.id })).valid;
      assert.equal(p.page.unloadable(v), engine, `${c.name}: ${v.id}`);
      if (engine) offered.push(`${c.name}: ${v.id}`);
    }
  }
  assert.deepEqual(offered, [`home: ${HEAVY}`], 'the premise: offered exactly once — laden, idle, at HOME');
});

// ---- 5. UNLOAD: the click ----------------------------------------------------------------------------------

test('Unload sends one well-formed unloadAsset; the machine joins IDLE at HOME as an ordinary row, and the card is empty again', async () => {
  const p = page(W.home);
  p.open();
  p.press('ops-tp-list', 'ops-tp-unload', 'data-tp-unload', HEAVY);
  assert.ok(p.html('ops-tp-list').includes(UNLOAD(HEAVY, true)), 'held while it posts');
  await settle();
  assert.deepEqual(p.sent, [createUnloadAssetAction({ guildId: 'g1', vehicleId: HEAVY })]);
  const after = viewOf(p.world.s, 'g1');
  assert.deepEqual([craftIn(after, HEAVY).carryingAssetId, meOf(after, 'g1').assets.find((a) => a.id === W.miner).systemId],
    [undefined, HOME.id], 'the engine took it: the hold is free and the miner is at HOME');
  assert.ok(idleGroups(p.html('ops-idle-list'))[HOME_NAME].includes(ordinaryRow(W.miner, 'miner')));
  assert.ok(p.html('ops-tp-list').includes(HOLD_EMPTY) && p.html('ops-tp-list').includes(DOCK(HEAVY)));
  assert.equal(p.html('ops-tp-list').includes('ops-tp-unload'), false);
});

test('Unload refused: the engine\'s reason stays on the card through a poll on the same tick, and goes once the clock moves on', async () => {
  const p = page(W.home);
  p.open();
  // The galaxy moves on before the click lands: the heavy has been dispatched again.
  p.world.s = P.accept(W.home, createDispatchVehicleAction({ guildId: 'g1', vehicleId: HEAVY, waypoints: [P.AT_TARGET] }));
  p.press('ops-tp-list', 'ops-tp-unload', 'data-tp-unload', HEAVY);
  await settle();
  const refusal = /<div class="ops-lane-msg">Refused: vehicle &quot;vehicle_g1_heavyTransport_01&quot; is not idle[^<]*<\/div>/;
  assert.match(p.html('ops-tp-list'), refusal);
  assert.ok(p.html('ops-tp-list').includes(UNLOAD(HEAVY)), 'the button is live again');
  p.poll(W.home);
  assert.match(p.html('ops-tp-list'), refusal, 'the same tick: still shown');
  p.poll(P.ticks(W.home, 1));
  assert.doesNotMatch(p.html('ops-tp-list'), /ops-lane-msg/, 'a later tick: gone');
});

// ---- 6. the flight between: an ordinary dispatch ----------------------------------------------------------

test('the laden heavy dispatches as any craft does: the Dispatch popup\'s own send builds a plain dispatchVehicle, its quote allows it, and the engine takes it', () => {
  const v = craftIn(viewOf(W.loaded, 'g1'), HEAVY);
  const sandbox = {
    DP: { vehicle: v, waypoints: [{ anchor: P.AT_HOME }], mode: 'once', n: '', cadence: 'immediate' },
    // TARGET and HOME are two hexes apart, so the first leg is no reposition skip; a once-run never repeats.
    window: { __routeChecks: { skipsFirstLeg: () => false, canRepeat: () => false } },
  };
  vm.runInNewContext(dispatchSrc, sandbox);
  const action = JSON.parse(JSON.stringify(sandbox.dispatchActionFor('g1', v)));
  assert.deepEqual(action, createDispatchVehicleAction({ guildId: 'g1', vehicleId: HEAVY, waypoints: [P.AT_HOME] }));
  const quote = quoteDispatch(W.loaded, { guildId: 'g1', vehicleId: HEAVY, waypoints: [P.AT_HOME] });
  assert.deepEqual([quote.ok, quote.affordable], [true, true]);
  // salvage-script.js flew it with this very action, so its next state IS the in-flight one the manifest test reads.
  assert.equal(sha(P.accept(W.loaded, action)), sha(W.inFlight));
});

// ---- 7. everything else, unchanged ---------------------------------------------------------------------------

// This slice's changes to a host, undone — each a no-op on main's html, where none of them is drawn:
//   IDLE — the Salvage buttons out. (A carried machine's absence is undone by reading the view without its row:
//     test 3 proves that is exactly the change.)
//   IN TRANSIT — the laden manifest back to "No cargo.".
//   IDLE TRANSPORTS — the laden card's hold back to "Hold empty" without "· locked", Unload out, and Dock back in.
const toMain = {
  idle: (h) => h.split(SALVAGE_NONE).join('').replace(/<button class="ops-idle-deploy ops-idle-salvage" type="button" data-salvage="[^"]+">Salvage<\/button>/g, ''),
  transit: (h, v, kind) => h.replace(carriedRow(v.carryingAssetId, kind) + lockedHold(v), NO_CARGO),
  tp: (h, v, kind) => (!h.includes(carriedRow(v.carryingAssetId, kind)) ? h : h
    .replace(`${fmt(v.used)} / ${fmt(v.capacity)} · locked</span>`, `${fmt(v.used)} / ${fmt(v.capacity)}</span>`)
    .replace(carriedRow(v.carryingAssetId, kind), HOLD_EMPTY)
    .replace(UNLOAD(v.id), '')
    .replace(`<div class="ops-tp-btns"><button class="ops-tp-dispatch" type="button" data-tp-dispatch="${v.id}">`,
      `<div class="ops-tp-btns">${DOCK(v.id)}<button class="ops-tp-dispatch" type="button" data-tp-dispatch="${v.id}">`)),
};
// hubAsMain(state, guildId) -> every Operations host's hash, with this slice's changes undone.
function hubAsMain(state, guildId) {
  const view = viewOf(state, guildId);
  const p = page(state, { guildId });
  p.open();
  const hub = p.hub();
  const laden = (meOf(view, guildId).vehicles || []).find((v) => v.carryingAssetId);
  if (laden) {
    const kind = kindOf(view, laden.carryingAssetId);
    hub['ops-transit-list'] = toMain.transit(hub['ops-transit-list'], laden, kind);
    hub['ops-tp-list'] = toMain.tp(hub['ops-tp-list'], laden, kind);
  }
  const without = viewOf(state, guildId);
  meOf(without, guildId).assets = (meOf(without, guildId).assets || []).filter((a) => a.inTransitOnVehicleId == null);
  const q = page(state, { guildId });
  q.page.window.__snapshot = () => without;
  q.open();
  hub['ops-idle-list'] = toMain.idle(q.html('ops-idle-list'));
  return Object.fromEntries(Object.entries(hub).map(([id, h]) => [id, sha(h).slice(0, 16)]));
}
// Every host, in every state, as main's own engine + client drew it at 367a3cf — hashed there by this same test (each
// undo above is a no-op on main's html, so this test passes on main's game.html too) and pinned.
const AS_ON_MAIN = {
  'held (g1)': [() => W.held, 'g1'],
  'stranded (g1)': [() => W.stranded, 'g1'],
  'stranded (g2)': [() => W.stranded, 'g2'],
  'fleet (g1)': [() => W.fleet, 'g1'],
  'loaded (g1)': [() => W.loaded, 'g1'],
  'inFlight (g1)': [() => W.inFlight, 'g1'],
  'inFlight (g2)': [() => W.inFlight, 'g2'],
  'home (g1)': [() => W.home, 'g1'],
  'unloaded (g1)': [() => W.unloaded, 'g1'],
  'returned (g1)': [() => W.returned, 'g1'],
};
const PINS = {
  'held (g1)': {
    'ops-lane-notices': '12ae32cb1ec02d01', 'ops-transit-list': '3b10d9713b124c52', 'ops-deployed-list': '01b637646c7e1986',
    'ops-idle-list': 'b17c5004050e1bbe', 'ops-tp-list': '0f5b383564800677',
  },
  'stranded (g1)': {
    'ops-lane-notices': '12ae32cb1ec02d01', 'ops-transit-list': '3b10d9713b124c52', 'ops-deployed-list': '01b637646c7e1986',
    'ops-idle-list': '74ab3599a10d2898', 'ops-tp-list': '0f5b383564800677',
  },
  'stranded (g2)': {
    'ops-lane-notices': '12ae32cb1ec02d01', 'ops-transit-list': '3b10d9713b124c52', 'ops-deployed-list': '01b637646c7e1986',
    'ops-idle-list': '7f6bf06c1ae78e8b', 'ops-tp-list': 'a9b8e5a9b92f8bef',
  },
  'fleet (g1)': {
    'ops-lane-notices': '12ae32cb1ec02d01', 'ops-transit-list': '8eae89355076c922', 'ops-deployed-list': '01b637646c7e1986',
    'ops-idle-list': '74ab3599a10d2898', 'ops-tp-list': '4f2b20bdf6cc31c6',
  },
  'loaded (g1)': {
    'ops-lane-notices': '12ae32cb1ec02d01', 'ops-transit-list': '3b10d9713b124c52', 'ops-deployed-list': '01b637646c7e1986',
    'ops-idle-list': 'ad96232665906708', 'ops-tp-list': 'e6039230e39dc033',
  },
  'inFlight (g1)': {
    'ops-lane-notices': '12ae32cb1ec02d01', 'ops-transit-list': '41c16a21e3bf0720', 'ops-deployed-list': '01b637646c7e1986',
    'ops-idle-list': 'ad96232665906708', 'ops-tp-list': 'a9b8e5a9b92f8bef',
  },
  'inFlight (g2)': {
    'ops-lane-notices': '12ae32cb1ec02d01', 'ops-transit-list': '3b10d9713b124c52', 'ops-deployed-list': '01b637646c7e1986',
    'ops-idle-list': '7f6bf06c1ae78e8b', 'ops-tp-list': 'a9b8e5a9b92f8bef',
  },
  'home (g1)': {
    'ops-lane-notices': '12ae32cb1ec02d01', 'ops-transit-list': '3b10d9713b124c52', 'ops-deployed-list': '01b637646c7e1986',
    'ops-idle-list': 'ad96232665906708', 'ops-tp-list': 'febef596de266e08',
  },
  'unloaded (g1)': {
    'ops-lane-notices': '12ae32cb1ec02d01', 'ops-transit-list': '3b10d9713b124c52', 'ops-deployed-list': '01b637646c7e1986',
    'ops-idle-list': '4d7a97bef7274b85', 'ops-tp-list': 'b6ab0c7f3815cbe0',
  },
  'returned (g1)': {
    'ops-lane-notices': '12ae32cb1ec02d01', 'ops-transit-list': '3b10d9713b124c52', 'ops-deployed-list': '01b637646c7e1986',
    'ops-idle-list': '4d7a97bef7274b85', 'ops-tp-list': '0f5b383564800677',
  },
};

test('GUARD: with this slice\'s changes undone, every Operations host renders exactly as main rendered it, in every state', () => {
  const actual = Object.fromEntries(Object.entries(AS_ON_MAIN).map(([name, [state, guild]]) => [name, hubAsMain(state(), guild)]));
  assert.deepEqual(actual, PINS);
});

test('wiring: the new buttons are styled, the popup publishes its two bridges once, and the hub reads them', () => {
  assert.match(html, /#tp-ops \.ops-tp-unload,\n/);
  assert.match(html, /#tp-ops \.ops-tp-unload:disabled,\n#tp-ops \.ops-idle-deploy:disabled\{/);
  assert.equal(count(html, 'window.__openSalvage = openSalvage;'), 1);
  assert.equal(count(html, 'window.__carriersFor = carriersFor;'), 1);
  assert.match(opsSrc, /window\.__carriersFor\(a\)\.length > 0/);
  assert.match(opsSrc, /window\.__openSalvage\(sid\)/);
  assert.match(opsSrc, /type: 'unloadAsset', guildId: gid, vehicleId: vid/);
});
