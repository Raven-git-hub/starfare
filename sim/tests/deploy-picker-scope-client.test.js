'use strict';

// deploy-picker-scope-client.test.js — the Establish machine picker mirrors the engine's asset-side establish gates
// (client only; the deferred "no same-system picker filter (2.2)" of roadmap 2.1b, and the pickers' scope fix losing
// ground left over). The engine deploys a machine on a node only when it is not deployed, not aboard a vehicle, of the
// node's kind, and in the node's own system (sim/actions.js, establishVenture's Gate 2). The picker's reader,
// `window.__myIdleAssets` — read by the generic Establish popup (`fillAssets`) and the deuterium one (`fillDeutAssets`)
// — once checked only the kind and "not deployed", so it offered machines the engine refuses (§18). The tripwires:
//   1. ANOTHER HELD SYSTEM: with idle machines in both of a guild's held systems, a node's picker offers its own
//      system's machine (the positive control) and never the other system's.
//   2. STRANDED: a machine left stranded in a system the guild has lost is not offered to a node in a system it holds.
//   3. CARRIED: a machine aboard a heavy keeps the systemId it was loaded from. After abandon, salvage-load and a
//      re-plant, that system is held again and the systemId matches, yet the machine is not offered there.
//   4. THE ENGINE AGREES, machine by machine: in every held system of every view, a machine is offered exactly when
//      the engine's own establish validate accepts it on that node, and every one left out is refused at an
//      asset-side gate.
//   5. THE EMPTY-POOL HINT says what is true: no idle machine of that kind in THIS system. Main's "every one you own is
//      already deployed" is false once the pool is scoped (the guild may have one elsewhere, stranded, or aboard).
//   6. THE GUARD: everything else the two popups draw (the site lines, the territory line, the option rows, the empty
//      pool and the deploy button, before and after a pick) is pinned as `main`'s client drew it at 0a3ccea, in views
//      where main's picker already offered the right machines. It reads nothing this slice changed, so it passes on
//      main's game.html too. The hint line under the deploy button is left out of it: 5 changes it.
//
// The client has no DOM test harness, so — as prefecture-abandon-client.test.js does — this cuts the page's OWN code
// out of game.html and runs it in a node:vm sandbox on stubs: the shell's applySnapshot head and bridges (the picker's
// reader among them), the planet manifest's slot row and node-row click with the openEstablishFor they call (which
// stamps the node's system on the site, and forks a deuterium node to its own popup), and the whole Establish script,
// both popups included. The views are the engine's own fogged snapshots of abandon-script.js's galaxies, and the
// engine's own establish validate is the yardstick.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { validateAction, createEstablishVentureAction, createLoadAssetAction } = require('../actions.js');
const { buildSnapshot } = require('../snapshot.js');
const { getSystem, getSystemLayout } = require('../seed.js');
const P = require('./prefecture-fixtures.js');
const S = require('./sweep-script.js');
const A = require('./abandon-script.js');

const { HOME, TARGET, HEAVY, PLANET_A, SLOT_A1, SLOT_A2 } = P;
const W = A.abandonWorld();
const ids = W.ids;   // homeMiner (HOME); miner, factory, idleFactory, outpostKit (TARGET)

// STRANDED — `position`, abandoned: g1 holds HOME alone; TARGET's miner, both its factories and its Outpost kit lie
// stranded in the fallow system. The idle miner at HOME is untouched.
const STRANDED = P.accept(W.position, S.abandon());
// CARRIED_MINER — `carried` with the MINER aboard instead of the idle factory. A machine fills a whole heavy hold, so
// this is how the deuterium popup (which takes miners) gets a carried machine of its own; then g1 re-plants TARGET.
function carriedMiner() {
  let s = P.accept(STRANDED, createLoadAssetAction({ guildId: 'g1', vehicleId: HEAVY, assetId: ids.miner }));
  let kitId;
  ({ s, kitId } = P.grantPrefectureKit(s, 'g1', TARGET));
  return P.accept(s, P.plant('g1', kitId, SLOT_A1));
}
const CARRIED_MINER = carriedMiner();
// ONE_MINER — `bare`, plus one idle miner granted into TARGET: the guild's only machine (for the guard).
const ONE_MINER = S.grantMachine(W.bare, 'g1', 'miner', TARGET).s;

// The sites the test opens, read off the seed so a regen carries the test: in a system, its LAST ordinary resource node
// (not deuterium, which opens its own popup), its LAST settlement slot and its LAST deuterium node. `open` below checks
// each is vacant before it is used. Plus two on PLANET_A, the one planet g1 surveyed itself, so they stay listed in
// its view of TARGET after the abandon (an unheld system lists only the guild's own surveys).
function sitesOf(systemId) {
  const planets = getSystemLayout(systemId).planets;
  const nodes = planets.flatMap((pl) => pl.resourceNodes.map((n) => ({ kind: 'node', planetId: pl.id, id: n.id, resourceType: n.resourceType })));
  const slots = planets.flatMap((pl) => pl.settlementSlots.map((x) => ({ kind: 'slot', planetId: pl.id, id: x.id })));
  const last = (xs) => xs[xs.length - 1];
  return { node: last(nodes.filter((n) => n.resourceType !== 'deuterium')), slot: last(slots),
    deuterium: last(nodes.filter((n) => n.resourceType === 'deuterium')) };
}
const AT = { [HOME.id]: sitesOf(HOME.id), [TARGET]: sitesOf(TARGET) };
const PLANET_A_NODE = { kind: 'node', planetId: PLANET_A, id: S.NODE.id, resourceType: S.NODE.resourceType };
const PLANET_A_SLOT = { kind: 'slot', planetId: PLANET_A, id: SLOT_A2 };

// --- the harness ---------------------------------------------------------------------------------------------------

const html = fs.readFileSync(path.join(__dirname, '..', '..', 'client', 'game.html'), 'utf8');

function cut(src, re, what) {
  const m = src.match(re);
  assert.ok(m, `${what} is present in game.html`);
  return m[0];
}
// One top-level function by name, the FIRST in the page (the planet manifest's script comes before the shell's and the
// Establish script's): a one-liner whole, or a longer one through its closing brace at column 0.
const fn = (name) => {
  const head = `\\nfunction ${name}\\([^)]*\\) ?\\{`;
  const oneLine = html.match(new RegExp(`${head}[^\\n]*\\}\\n`));
  if (oneLine) return oneLine[0];
  return cut(html, new RegExp(`${head}\\n[\\s\\S]*?\\n\\}\\n`), name);
};

const kitKindsSrc = cut(html, /<script id="kit-kinds">([\s\S]*?)<\/script>/, 'the kit-kinds script').replace(/<\/?script[^>]*>/g, '');
// The shell: its two stores, applySnapshot's head (through the line that files every planted Prefecture under its slot —
// it fills LIVE.myAssets, the claims and the site states), and the bridges the manifest and the pickers read. The
// picker's reader is cut whatever its argument list, so the guard runs on main's one-argument reader too.
const shellSrc = cut(html, /\nvar GAME = \{[^\n]*\n/, 'GAME') + cut(html, /\nvar LIVE = \{[\s\S]*?snap:null \};\n/, 'LIVE')
  + fn('setText') + fn('prefectureSite') + fn('myIdleGroundKits')
  + cut(html, /\nfunction applySnapshot\(snap\)\{\n[\s\S]*?\n  \(snap\.prefectures \|\| \[\]\)\.forEach\([^\n]*\n/, 'applySnapshot') + '}\n'
  + cut(html, /\nwindow\.__siteInfo = [^\n]*\n/, '__siteInfo') + cut(html, /\nwindow\.__occupancy = [^\n]*\n/, '__occupancy')
  + cut(html, /\nwindow\.__player = [^\n]*\n/, '__player')
  + cut(html, /\nwindow\.__myIdleGroundKitsIn = function\(systemId\)\{[\s\S]*?\n\};\n/, '__myIdleGroundKitsIn')
  + cut(html, /\nwindow\.__controllerFor = function\(id\)\{[\s\S]*?\n\};\n/, '__controllerFor')
  + cut(html, /\nwindow\.__isClaimed = [^\n]*\n/, '__isClaimed') + cut(html, /\nwindow\.__isMine = [^\n]*\n/, '__isMine')
  + cut(html, /\nwindow\.__myIdleAssets = function\([^)]*\)\{\n[\s\S]*?\n\};\n/, '__myIdleAssets');
// The planet manifest: a slot's row (its click opens the Establish flow on a vacant slot), and a vacant node row's
// click — the one statement render() runs, cut verbatim and wrapped, since render() itself draws the whole planet
// view — and the openEstablishFor both hand the site to.
const viewSrc = cut(html, /\nconst ARCHETYPE_LABEL = [^\n]*\n/, 'ARCHETYPE_LABEL') + cut(html, /\nconst RESOURCE_LABEL = [^\n]*\n/, 'RESOURCE_LABEL')
  + ['esc', 'planetDesignation', 'siteState', 'myGuildName', 'siteBadge', 'siteBadgeHtml', 'isOwnSite', 'plantKitFor',
    'settlementRow', 'openEstablishFor'].map((name) => fn(name)).join('')
  + '\nfunction clickVacantNode(node, i, p){' + cut(html, /\n *openEstablishFor\(\{ kind:'node', [\s\S]*?\}, p\);\n/, 'the node row\'s click') + '}\n';
// The whole Establish script: the generic popup (#est-overlay) and the deuterium one (#deut-overlay), as served.
const establishSrc = cut(html, /<script>\n\/\* ===== Establish a venture[\s\S]*?<\/script>/, 'the Establish script').replace(/<\/?script>/g, '');

// element() -> the few DOM members the cut code touches. As the DOM does: setting innerHTML drops the children (the
// pickers empty their select that way before they fill it), and setting textContent sets the markup to that text,
// escaped (the deuterium popup's site line escapes through a div that way).
function element() {
  const classes = new Set();
  let markup = '';
  let text = '';
  const node = { value: '', disabled: false, style: {}, on: {}, children: [],
    get innerHTML() { return markup; },
    set innerHTML(v) { markup = v; node.children = []; },
    get textContent() { return text; },
    set textContent(v) { text = String(v); markup = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); node.children = []; },
    addEventListener(type, f) { node.on[type] = f; },
    appendChild(child) { node.children.push(child); return child; },
    closest: () => element(), querySelector: () => element(), querySelectorAll: () => [] };
  node.classList = { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c),
    toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)) };
  return node;
}

// page(state, opts) -> the planet manifest of `systemId` for player `guildId`, reading the engine's own fogged view of
// `state` through the page's own applySnapshot, with both Establish popups loaded beside it.
function page(state, { guildId = 'g1', systemId = TARGET } = {}) {
  const nodes = {};
  const sandbox = {
    SYSTEM: { id: systemId, name: getSystem(systemId).name },
    setGuildLabel: () => {},
    document: { createElement: element, getElementById: (id) => nodes[id] || (nodes[id] = element()),
      querySelectorAll: () => [], addEventListener: () => {} },
    window: {},
  };
  vm.runInNewContext(kitKindsSrc + shellSrc + viewSrc + establishSrc, sandbox);
  sandbox.GAME.guildId = guildId;
  const p = { sandbox, view: buildSnapshot(state, guildId) };
  sandbox.applySnapshot(p.view);
  sandbox.SYSTEM.controller = sandbox.window.__controllerFor(systemId);   // as adaptBoardSystem reads it
  const $ = sandbox.document.getElementById;
  p.$ = $;
  p.myRows = () => p.view.guilds.find((g) => g.id === guildId).assets;
  // A planet as the manifest adapts it: exactly the slots and nodes the guild's view lists (geography.known).
  p.planet = (planetId) => {
    const order = getSystemLayout(systemId).planets.findIndex((x) => x.id === planetId) + 1;
    const k = ((p.view.geography.known || {})[systemId] || {})[planetId];
    return { id: planetId, roman: String(order), archetype: k ? k.archetype : null,
      slots: k ? Object.keys(k.slots).map((id) => ({ id })) : [],
      nodes: k ? Object.entries(k.nodes).map(([id, resourceType]) => ({ id, resourceType })) : [] };
  };
  // open(site) -> the popup a click on the site's row opens, and its picker: each option's [value, text], whether the
  // select is disabled, and the machine ids it offers. A deuterium node must open the deuterium popup, any other site
  // the generic one.
  p.open = (site) => {
    assert.equal(sandbox.siteState(site.id), null, `${site.id} is vacant in this view`);
    $('est-overlay').classList.remove('open');
    $('deut-overlay').classList.remove('open');
    const planet = p.planet(site.planetId);
    const list = site.kind === 'slot' ? planet.slots : planet.nodes;
    const i = list.findIndex((x) => x.id === site.id);
    assert.ok(i >= 0, `${site.id} is listed on ${site.planetId} in the view`);
    if (site.kind === 'slot') sandbox.settlementRow(list[i], i, planet).on.click();
    else sandbox.clickVacantNode(list[i], i, planet);
    const popup = $('deut-overlay').classList.contains('open') ? 'deuterium' : ($('est-overlay').classList.contains('open') ? 'establish' : null);
    assert.equal(popup, site.resourceType === 'deuterium' ? 'deuterium' : 'establish', `${site.id} opens its own popup`);
    const sel = $(popup === 'deuterium' ? 'deutAsset' : 'assetSel');
    const options = sel.children.map((o) => [o.value, o.textContent]);
    return { popup, disabled: sel.disabled, options, offered: options.map(([v]) => v).filter((v) => v !== '') };
  };
  // pick(popup, assetId): the player chooses a machine in the open popup's picker.
  p.pick = (popup, assetId) => {
    const sel = $(popup === 'deuterium' ? 'deutAsset' : 'assetSel');
    sel.value = assetId;
    sel.on.change.call(sel);
  };
  return p;
}

// engine(state, site, assetId) -> the engine's verdict on establishing that machine on that site, as the popups send it:
// a mine of the node's own resource (the deuterium popup's mine included), or a refinery on a slot. The recipe is any
// real one; the asset gates do not read it.
function engine(state, site, assetId) {
  const base = { guildId: 'g1', ventureId: 'v_probe', siteId: site.id, assetId };
  return validateAction(state, site.kind === 'slot'
    ? createEstablishVentureAction({ ...base, type: 'refining', recipeId: 'titanium_alloy' })
    : createEstablishVentureAction({ ...base, type: 'mining', resourceType: site.resourceType }));
}
const SAME_SYSTEM = /sits in system "[^"]+" but site "[^"]+" is in system "[^"]+" — an asset deploys only within its own system/;
const ABOARD = new RegExp(`is aboard vehicle "${HEAVY}", in transit`);
const EMPTY_MINERS = { disabled: true, options: [['', '— no idle miners in inventory —']], offered: [] };
const EMPTY_FACTORIES = { disabled: true, options: [['', '— no idle factories in inventory —']], offered: [] };
const pool = ({ disabled, options, offered }) => ({ disabled, options, offered });

// --- 1. another held system ------------------------------------------------------------------------------------------

test('another held system: a node is offered its own system\'s idle machine, never the other held system\'s', () => {
  // position: g1 holds HOME and TARGET. Its idle miner is at HOME, its idle factory in TARGET (TARGET's other miner and
  // factory run its two ventures).
  let p = page(W.position, { systemId: HOME.id });
  assert.deepEqual(p.open(AT[HOME.id].node).offered, [ids.homeMiner], 'HOME\'s node: HOME\'s miner (the positive control)');
  assert.deepEqual(pool(p.open(AT[HOME.id].slot)), EMPTY_FACTORIES, 'HOME\'s slot: TARGET\'s idle factory is not offered');
  p = page(W.position, { systemId: TARGET });
  assert.deepEqual(p.open(AT[TARGET].slot).offered, [ids.idleFactory], 'TARGET\'s slot: TARGET\'s factory');
  assert.deepEqual(pool(p.open(AT[TARGET].node)), EMPTY_MINERS, 'TARGET\'s node: HOME\'s miner is not offered');
  assert.deepEqual(pool(p.open(AT[TARGET].deuterium)), EMPTY_MINERS, 'nor on the deuterium popup');
  // carried: both held systems have an idle MINER now (the re-plant recovered TARGET's). Each node gets its own.
  p = page(W.carried, { systemId: HOME.id });
  assert.deepEqual(p.open(AT[HOME.id].node).offered, [ids.homeMiner]);
  p = page(W.carried, { systemId: TARGET });
  assert.deepEqual(p.open(AT[TARGET].node).offered, [ids.miner]);
  assert.deepEqual(p.open(AT[TARGET].deuterium).offered, [ids.miner], 'the deuterium popup, scoped the same way');
  // The engine draws the same line: TARGET's miner deploys on TARGET's nodes, HOME's is refused at the same-system gate.
  for (const site of [AT[TARGET].node, AT[TARGET].deuterium]) {
    assert.equal(engine(W.carried, site, ids.miner).valid, true, site.id);
    assert.match(engine(W.carried, site, ids.homeMiner).reason, SAME_SYSTEM, site.id);
  }
  assert.match(engine(W.position, AT[HOME.id].slot, ids.idleFactory).reason, SAME_SYSTEM);
});

// --- 2. stranded -----------------------------------------------------------------------------------------------------

test('stranded: a machine left in a system the guild has lost is not offered to a node in a system it holds', () => {
  assert.equal(P.held(STRANDED, 'g1', HOME.id), true);
  assert.equal(P.held(STRANDED, 'g1', TARGET), false);
  const p = page(STRANDED, { systemId: HOME.id });
  const stranded = p.myRows().filter((a) => a.stranded);
  assert.deepEqual(stranded.map((a) => a.id).sort(), [ids.factory, ids.idleFactory, ids.miner, ids.outpostKit].sort(),
    'the view publishes TARGET\'s machines and kit as stranded');
  assert.ok(stranded.every((a) => a.systemId === TARGET && a.deployedToVentureId == null && a.inTransitOnVehicleId == null),
    'idle, not aboard, and in the lost system — only the system tells them apart');
  assert.deepEqual(p.open(AT[HOME.id].node).offered, [ids.homeMiner], 'HOME\'s own miner is offered; the stranded one is not');
  assert.deepEqual(pool(p.open(AT[HOME.id].slot)), EMPTY_FACTORIES, 'neither stranded factory');
  assert.match(engine(STRANDED, AT[HOME.id].node, ids.miner).reason, SAME_SYSTEM);
  for (const id of [ids.factory, ids.idleFactory]) assert.match(engine(STRANDED, AT[HOME.id].slot, id).reason, SAME_SYSTEM);
  // In the lost system itself the stranded factories are listed (they are there, idle, not aboard), but nothing can be
  // deployed: TARGET is not held, so the popup's deploy stays off and says why (§4 gate 3), as the engine refuses.
  const lost = page(STRANDED, { systemId: TARGET });
  assert.deepEqual(lost.open(PLANET_A_SLOT).offered, [ids.factory, ids.idleFactory]);
  lost.pick('establish', ids.factory);
  assert.equal(lost.$('deployBtn').disabled, true);
  assert.match(lost.$('deployHint').textContent, /deploy requires holding it first/);
  assert.match(engine(STRANDED, PLANET_A_SLOT, ids.factory).reason, /does not hold system/);
});

// --- 3. carried ------------------------------------------------------------------------------------------------------

test('carried: a machine aboard a heavy is not offered, though its system is held again and its systemId matches', () => {
  assert.equal(P.held(W.carried, 'g1', TARGET), true, 'g1 re-planted TARGET');
  let p = page(W.carried, { systemId: TARGET });
  const aboard = p.myRows().find((a) => a.id === ids.idleFactory);
  assert.deepEqual([aboard.systemId, aboard.inTransitOnVehicleId, aboard.deployedToVentureId], [TARGET, HEAVY, null],
    'the factory aboard still names TARGET as its system, and is not deployed');
  const slot = p.open(AT[TARGET].slot);
  assert.ok(!slot.offered.includes(ids.idleFactory), 'the factory aboard is not offered');
  assert.ok(slot.offered.includes(ids.factory), 'its sibling, recovered into TARGET by the re-plant, is (the positive control)');
  assert.match(engine(W.carried, AT[TARGET].slot, ids.idleFactory).reason, ABOARD);
  assert.equal(engine(W.carried, AT[TARGET].slot, ids.factory).valid, true);
  // The deuterium popup reads the same reader: with the miner aboard instead, neither it nor an ordinary node offers it.
  p = page(CARRIED_MINER, { systemId: TARGET });
  const miner = p.myRows().find((a) => a.id === ids.miner);
  assert.deepEqual([miner.systemId, miner.inTransitOnVehicleId], [TARGET, HEAVY]);
  for (const site of [AT[TARGET].deuterium, AT[TARGET].node]) {
    assert.ok(!p.open(site).offered.includes(ids.miner), `${site.id}: the miner aboard is not offered`);
    assert.match(engine(CARRIED_MINER, site, ids.miner).reason, ABOARD);
  }
  assert.deepEqual(p.open(AT[TARGET].slot).offered, [ids.factory, ids.idleFactory], 'both factories are back in TARGET');
});

// --- 4. the engine agrees ----------------------------------------------------------------------------------------------

test('the engine agrees, machine by machine: in every held system, offered exactly when establish would accept it', () => {
  const ASSET_GATES = { deployed: /is already deployed to venture/, aboard: ABOARD, kind: /is a \w+; a \w+ venture needs a/, system: SAME_SYSTEM };
  const seen = { offered: 0, deployed: 0, aboard: 0, kind: 0, system: 0 };
  const views = { position: W.position, carried: W.carried, carriedMiner: CARRIED_MINER, stranded: STRANDED };
  for (const [name, s] of Object.entries(views)) {
    for (const systemId of [HOME.id, TARGET].filter((id) => P.held(s, 'g1', id))) {
      const p = page(s, { systemId });
      for (const site of Object.values(AT[systemId]).filter(Boolean)) {
        const { offered } = p.open(site);
        // Every machine and kit the guild owns, wherever it is.
        for (const a of s.guilds.find((g) => g.id === 'g1').assets) {
          const verdict = engine(s, site, a.id);
          const where = `${name}, ${site.id}, ${a.id}`;
          assert.equal(offered.includes(a.id), verdict.valid, `${where}: offered ⇔ the engine accepts (${verdict.reason || 'valid'})`);
          if (verdict.valid) { seen.offered += 1; continue; }
          const gate = Object.keys(ASSET_GATES).find((k) => ASSET_GATES[k].test(verdict.reason));
          assert.ok(gate, `${where}: refused at an asset-side gate, not for the site — ${verdict.reason}`);
          seen[gate] += 1;
        }
      }
    }
  }
  // Each of the engine's four asset-side refusals was met at least once, and so was an accepted machine.
  for (const [k, n] of Object.entries(seen)) assert.ok(n > 0, `${k}: reached (${n})`);
});

// --- 5. the empty-pool hint ------------------------------------------------------------------------------------------

test('the empty-pool hint says what is true — none in this system, never "every one you own is already deployed"', () => {
  // position: HOME's slot has no idle factory, but g1 has one in TARGET; TARGET's nodes have no idle miner, but g1 has
  // one at HOME. Main's hint said every one was deployed — false in each case.
  let p = page(W.position, { systemId: HOME.id });
  assert.deepEqual(p.open(AT[HOME.id].slot).offered, []);
  assert.equal(p.$('deployHint').textContent, 'No idle factories in this system.');
  p = page(W.position, { systemId: TARGET });
  assert.deepEqual(p.open(AT[TARGET].node).offered, []);
  assert.equal(p.$('deployHint').textContent, 'No idle miners in this system.');
  assert.deepEqual(p.open(AT[TARGET].deuterium).offered, []);
  assert.equal(p.$('deutHint').textContent, 'No idle miners in this system.');
  assert.ok(!html.includes('already deployed'), 'the false claim is gone from the page');
});

// --- 6. everything else, unchanged ----------------------------------------------------------------------------------

const sha = (x) => crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex');

// The guard's cases: views where main's picker already offered exactly the right machines — the guild has none of the
// kind elsewhere, and none aboard — so main drew them as this slice does. A held and an unheld system, an empty pool
// and a full one, on each of the three pickers (a node's miners, a slot's factories, a deuterium node's miners).
const GUARD = {
  'bare, HOME node': [W.bare, HOME.id, AT[HOME.id].node], 'bare, HOME slot': [W.bare, HOME.id, AT[HOME.id].slot],
  'bare, TARGET node': [W.bare, TARGET, AT[TARGET].node], 'bare, TARGET slot': [W.bare, TARGET, AT[TARGET].slot],
  'bare, TARGET deuterium': [W.bare, TARGET, AT[TARGET].deuterium],
  'position, HOME node': [W.position, HOME.id, AT[HOME.id].node], 'position, TARGET slot': [W.position, TARGET, AT[TARGET].slot],
  'one miner, TARGET node': [ONE_MINER, TARGET, AT[TARGET].node], 'one miner, TARGET deuterium': [ONE_MINER, TARGET, AT[TARGET].deuterium],
  'fallow, TARGET node': [W.fallow, TARGET, PLANET_A_NODE],
};
// What the guard pins of each popup. The hint under the deploy button (`deployHint`, `deutHint`) is NOT in it: its
// empty-pool sentence is this slice's to change (test 5), so pinning main's words would make the guard fail on one
// side or the other. The deploy button's disabled state, which the same gate sets, stays pinned.
const DRAWN = {
  establish: ['siteNode', 'siteRes', 'sitePlanet', 'siteArch', 'siteTerr', 'assetSel', 'deployBtn'],
  deuterium: ['deutTitle', 'deutSite', 'deutAssetLbl', 'deutAsset', 'deutDeploy'],
};
// popupAsMain(state, systemId, site) -> what the site's popup draws, as it opens and again after the first machine it
// offers is picked: every element above — its text, its markup, whether it is disabled, its options.
function popupAsMain(state, systemId, site) {
  const p = page(state, { systemId });
  const opened = p.open(site);
  const draw = () => DRAWN[opened.popup].map((id) => {
    const e = p.$(id);
    return [id, e.textContent, e.innerHTML, e.disabled, e.children.map((o) => [o.value, o.textContent])];
  });
  const out = [opened.popup, draw()];
  if (opened.offered.length) {
    p.pick(opened.popup, opened.offered[0]);
    out.push(draw());
  }
  return { hash: sha(out).slice(0, 16), opened };
}
// Every case, as main's own engine + client drew it at 0a3ccea — hashed there by this same test (it reads nothing this
// slice changed, so it passes on main's game.html too) and pinned.
const PINS = {
  'bare, HOME node': '527932cd6c9db038', 'bare, HOME slot': '20b84d204891263f', 'bare, TARGET node': '36d4689c54b2cc7a',
  'bare, TARGET slot': 'c90b29a013310463', 'bare, TARGET deuterium': '74e7ca9411bca927',
  'position, HOME node': '56c258d2ddf2f8d8', 'position, TARGET slot': '3578939dd4b36e31',
  'one miner, TARGET node': 'dee88070c59aabf6', 'one miner, TARGET deuterium': '8ce3ae68e6f5039e',
  'fallow, TARGET node': 'd1de023d25570fae',
};

test('GUARD: the popups draw exactly as main drew them wherever main\'s picker was already right', () => {
  const actual = Object.fromEntries(Object.entries(GUARD).map(([name, [s, systemId, site]]) => [name, popupAsMain(s, systemId, site).hash]));
  assert.deepEqual(actual, PINS);
});

test('GUARD: its cases reach every picker, empty and full, in a held system and an unheld one', () => {
  const reached = new Set();
  for (const [s, systemId, site] of Object.values(GUARD)) {
    const { opened } = popupAsMain(s, systemId, site);
    const picker = opened.popup === 'deuterium' ? 'deuterium' : site.kind;
    reached.add(`${picker} ${opened.offered.length ? 'full' : 'empty'}`);
    reached.add(P.held(s, 'g1', systemId) ? 'held' : 'unheld');
  }
  assert.deepEqual([...reached].sort(), ['deuterium empty', 'deuterium full', 'held', 'node empty', 'node full', 'slot empty', 'slot full', 'unheld']);
});
