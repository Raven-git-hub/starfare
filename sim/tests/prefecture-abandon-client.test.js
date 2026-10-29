'use strict';

// prefecture-abandon-client.test.js — LOSING GROUND, client slice 5: the abandon control (design.md §2 "Losing it
// evicts the system", §19 #67 / #69; docs/territory-model.md §4). The engine half is engine PR 1
// (prefecture-abandon.test.js): `abandonPrefecture { guildId, prefectureId }` destroys a Prefecture of the guild's
// own and evicts its system. This slice gives the owner the button for it, on the planet manifest. The tripwires:
//   1. THE CONTROL: the overlay of a settlement slot carries Abandon exactly when the player's own Prefecture stands
//      on it — never on a rival's Prefecture, a vacant slot, a venture's slot or a resource node — and opening the
//      overlay, or pressing Abandon on it, sends nothing.
//   2. THE CONFIRM: Abandon opens the Guild Adviser's card, which spells out what is lost and what the player has in
//      the system now. Its counts are checked against the engine's own eviction of that state (the `system_lost`
//      payload: the ventures it closed, the machines and kits it stranded), and read "no …" rather than 0 or null.
//   3. THE SEND: the card's Abandon sends one well-formed `abandonPrefecture` and re-reads; Cancel sends nothing.
//   4. THE REFUSAL: the engine's centre-bound refusal (and an unreachable server, a Prefecture already gone) is shown
//      in its own words, and the Prefecture still stands.
//   5. THE GUARD: everything else the manifest draws — every slot row, every row click, every overlay, the Plant
//      confirm — is pinned as `main`'s own client drew it at a869f6b. The guard reads nothing this slice added, and
//      the harness cuts the new code only where it is present, so the guard passes on `main`'s game.html too.
//
// The client has no DOM test harness, so — as prefecture-plant-client.test.js does — this cuts the page's OWN code out
// of game.html and runs it in a node:vm sandbox on stubs: the planet manifest's slot pieces, the shell's applySnapshot
// (its head, through the line that files every planted Prefecture under its slot) and bridges, and the Guild Adviser's
// card itself, so Cancel and Abandon are its real buttons. The views are the engine's own fogged snapshots of
// abandon-script.js's galaxies, and an action the page sends is validated and applied by the real engine.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { validateAction, applyAction, createAbandonPrefectureAction, createEstablishVentureAction } = require('../actions.js');
const { buildSnapshot } = require('../snapshot.js');
const { listRecipes } = require('../recipes.js');
const { getSystem, getSystemLayout } = require('../seed.js');
const P = require('./prefecture-fixtures.js');
const S = require('./sweep-script.js');
const A = require('./abandon-script.js');

const { HOME, TARGET, PLANET_A, SLOT_A1, SLOT_A2 } = P;
const TARGET_NAME = getSystem(TARGET).name;
const W = A.abandonWorld();

const html = fs.readFileSync(path.join(__dirname, '..', '..', 'client', 'game.html'), 'utf8');

function cut(src, re, what) {
  const m = src.match(re);
  assert.ok(m, `${what} is present in game.html`);
  return m[0];
}
// One top-level function by name, the FIRST in the page (the planet manifest's script comes before the shell's): a
// one-liner whole, or a longer one through its closing brace at column 0. `optional` returns '' when it is absent —
// this slice's own code is, on `main`, where the guard below must still run.
const fn = (name, prefix = '', optional = false) => {
  const head = `\\n${prefix}function ${name}\\([^)]*\\) ?\\{`;
  const oneLine = html.match(new RegExp(`${head}[^\\n]*\\}\\n`));
  if (oneLine) return oneLine[0];
  const long = html.match(new RegExp(`${head}\\n[\\s\\S]*?\\n\\}\\n`));
  if (!long && optional) return '';
  assert.ok(long, `${name} is present in game.html`);
  return long[0];
};
const maybe = (re) => (html.match(re) || [''])[0];

const kitKindsSrc = cut(html, /<script id="kit-kinds">([\s\S]*?)<\/script>/, 'the kit-kinds script').replace(/<\/?script[^>]*>/g, '');
// The shell: its two stores, applySnapshot's head, and the bridges the manifest reads.
const shellSrc = cut(html, /\nvar GAME = \{[^\n]*\n/, 'GAME') + cut(html, /\nvar LIVE = \{[\s\S]*?snap:null \};\n/, 'LIVE')
  + fn('setText') + fn('prefectureSite') + fn('myIdleGroundKits')
  + cut(html, /\nfunction applySnapshot\(snap\)\{\n[\s\S]*?\n  \(snap\.prefectures \|\| \[\]\)\.forEach\([^\n]*\n/, 'applySnapshot') + '}\n'
  + cut(html, /\nwindow\.__siteInfo = [^\n]*\n/, '__siteInfo') + cut(html, /\nwindow\.__occupancy = [^\n]*\n/, '__occupancy')
  + cut(html, /\nwindow\.__player = [^\n]*\n/, '__player')
  + cut(html, /\nwindow\.__myIdleGroundKitsIn = function\(systemId\)\{[\s\S]*?\n\};\n/, '__myIdleGroundKitsIn')
  + cut(html, /\nwindow\.__isClaimed = [^\n]*\n/, '__isClaimed') + cut(html, /\nwindow\.__isMine = [^\n]*\n/, '__isMine')
  + maybe(/\nwindow\.__myHoldingsIn = function\(systemId\)\{[\s\S]*?\n\};\n/);
// The Guild Adviser's card: the generic confirm and its two buttons (the 'generic' branch of reelNext's listener).
const reelSrc = cut(html, /\nfunction \$\(id\)\{ return document\.getElementById\(id\); \}\n/, '$') + cut(html, /\nvar reelMode='info'[^\n]*\n/, 'reelMode') + fn('openReel') + fn('closeReel')
  + cut(html, /\n\$\('reelCancel'\)\.addEventListener\('click', closeReel\);\n/, 'the Cancel listener')
  + cut(html, /\n\$\('reelNext'\)\.addEventListener\('click', function\(\)\{\n[\s\S]*?\n\}\);\n/, 'the Next listener')
  + cut(html, /\nvar __adviserOnConfirm = null;\nwindow\.__adviserConfirm = function\(opts\)\{\n[\s\S]*?\n\};\n/, '__adviserConfirm');
// The planet manifest's slot pieces: the site state and badge, the row, the overlay, the plant — and the abandon.
const viewSrc = ['esc', 'planetDesignation', 'siteState', 'myGuildName', 'siteBadge', 'siteBadgeHtml', 'isOwnSite',
  'prettyGood', 'settlementRow', 'plantKitFor', 'openPlantFor', 'openEstablishFor', 'openNodeOverlay']
  .map((name) => fn(name)).join('')
  + cut(html, /\nlet plantInFlight = false;\n/, 'plantInFlight') + fn('sendPlant', 'async ')
  + fn('openAbandonFor', '', true) + fn('countWords', '', true) + maybe(/\nlet abandonInFlight = false;\n/)
  + fn('sendAbandon', 'async ', true);

// element() -> the few DOM members the cut code touches.
function element() {
  const classes = new Set();
  const node = { className: '', innerHTML: '', textContent: '', disabled: false, onclick: null, on: {}, style: {},
    addEventListener(type, f) { node.on[type] = f; } };
  node.classList = { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c),
    toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)) };
  return node;
}

// page(state, opts) -> the planet manifest of `systemId` for player `guildId`, reading the engine's own fogged view
// of `state` through the page's own applySnapshot. `log` records every card, action and re-read, in order; `send`
// answers a sent action (default: the real engine, validate then apply). `p.state` is the galaxy as it stands.
function page(state, { guildId = 'g1', systemId = TARGET, send } = {}) {
  const log = [];
  const nodes = {};
  const p = { state, log };
  const sandbox = {
    SYSTEM: { id: systemId, name: getSystem(systemId).name },
    ARCHETYPE_LABEL: new Proxy({}, { get: (_, k) => String(k) }),
    setGuildLabel: () => {},
    document: { createElement: element, getElementById: (id) => nodes[id] || (nodes[id] = element()) },
    window: {
      __sendAction: async (action) => {
        log.push(['send', JSON.parse(JSON.stringify(action))]);
        if (send) return send(action);
        const verdict = validateAction(p.state, action);
        if (!verdict.valid) return { accepted: false, reason: verdict.reason };
        p.state = applyAction(p.state, action);
        return { accepted: true };
      },
      __refreshNow: async () => { log.push(['refresh']); read(); },
      openEstablish: (site) => log.push(['establish', { siteId: site.siteId, mine: site.mine }]),
      __openVentureManagement: (id) => log.push(['vm', id]),
    },
  };
  sandbox.el = { overlay: sandbox.document.getElementById('overlay'), overlayTitle: sandbox.document.getElementById('overlayTitle'),
    overlayCopy: sandbox.document.getElementById('overlayCopy') };
  vm.runInNewContext(kitKindsSrc + shellSrc + reelSrc + viewSrc, sandbox);
  sandbox.GAME.guildId = guildId;
  listRecipes().forEach((r) => { sandbox.GAME.recipeOut[r.id] = r.output.good; });
  // Every card the page opens is logged as it opens; the real card then shows it.
  const card = sandbox.window.__adviserConfirm;
  sandbox.window.__adviserConfirm = (opts) => { log.push(['confirm', opts]); card(opts); };
  function read() {
    p.view = buildSnapshot(p.state, guildId);
    sandbox.applySnapshot(p.view);
  }
  read();
  // A planet as the manifest adapts it: exactly the slots and nodes the guild's view lists (geography.known).
  p.planet = (planetId) => {
    const order = getSystemLayout(systemId).planets.findIndex((x) => x.id === planetId) + 1;
    const k = ((p.view.geography.known || {})[systemId] || {})[planetId];
    return { id: planetId, roman: String(order), archetype: k ? k.archetype : null,
      slots: k ? Object.keys(k.slots).map((id) => ({ id })) : [],
      nodes: k ? Object.entries(k.nodes).map(([id, resourceType]) => ({ id, resourceType })) : [] };
  };
  p.planets = () => getSystemLayout(systemId).planets.map((x) => p.planet(x.id));
  p.row = (planetId, slotId) => {
    const planet = p.planet(planetId);
    const i = planet.slots.findIndex((x) => x.id === slotId);
    assert.ok(i >= 0, `${slotId} is listed on ${planetId} in the view`);
    return sandbox.settlementRow(planet.slots[i], i, planet);
  };
  // A click on a row, with any overlay a previous click opened dismissed first, as the modal overlay forces.
  p.click = (planetId, slotId) => { sandbox.el.overlay.classList.remove('open'); p.row(planetId, slotId).on.click(); };
  const $ = sandbox.document.getElementById;
  p.overlay = () => ({ open: sandbox.el.overlay.classList.contains('open'), title: sandbox.el.overlayTitle.textContent,
    copy: sandbox.el.overlayCopy.textContent });
  p.abandonButton = () => $('overlayAbandon');
  p.offersAbandon = () => p.overlay().open && p.abandonButton().style.display === '' && typeof p.abandonButton().onclick === 'function';
  p.card = () => ({ open: $('est-reel').classList.contains('open'), title: $('reelTitle').textContent, body: $('reelBody').innerHTML,
    confirm: $('reelNext').textContent, cancel: $('reelCancel').textContent, cancelShown: $('reelCancel').style.display !== 'none' });
  p.pressConfirm = () => $('reelNext').on.click();
  p.pressCancel = () => $('reelCancel').on.click();
  // The send is async, and the card does not await it: let it, and the re-read after it, finish.
  p.settle = async () => { for (let i = 0; i < 6; i += 1) await new Promise((r) => setImmediate(r)); };
  p.sandbox = sandbox;
  return p;
}

const prefectureOn = (s, slotId) => (s.prefectures || []).find((x) => x.slotId === slotId) || null;
const abandonOf = (guildId, prefectureId) => createAbandonPrefectureAction({ guildId, prefectureId });

// openAbandon(state, opts) -> the page, its Abandon pressed on SLOT_A1's overlay: the confirm is open.
function openAbandon(state, opts) {
  const p = page(state, opts);
  p.click(PLANET_A, SLOT_A1);
  assert.equal(p.offersAbandon(), true, 'SLOT_A1 holds our Prefecture: its overlay offers Abandon');
  p.abandonButton().onclick();
  return p;
}

// --- 1. the control ------------------------------------------------------------------------------------------------

// Every view the test reads: a state, whose eyes, which system.
const VIEWS = {
  'bare (g1, TARGET)': [W.bare, 'g1', TARGET], 'bare (g1, HOME)': [W.bare, 'g1', HOME.id],
  'position (g1, TARGET)': [W.position, 'g1', TARGET], 'position (g1, HOME)': [W.position, 'g1', HOME.id],
  'position (g2, TARGET)': [W.position, 'g2', TARGET],
  'carried (g1, TARGET)': [W.carried, 'g1', TARGET], 'centreBound (g1, TARGET)': [W.centreBound, 'g1', TARGET],
  'fallow (g1, TARGET)': [W.fallow, 'g1', TARGET],
  'rival (g1, TARGET)': [W.rival, 'g1', TARGET], 'rival (g2, TARGET)': [W.rival, 'g2', TARGET],
};

test('the control: a slot\'s overlay offers Abandon exactly where the player\'s own Prefecture stands — and the engine agrees it is theirs to abandon', () => {
  let offers = 0;
  for (const [name, [s, guildId, systemId]] of Object.entries(VIEWS)) {
    const p = page(s, { guildId, systemId });
    for (const planet of p.planets()) {
      for (const slot of planet.slots) {
        p.click(planet.id, slot.id);
        const f = prefectureOn(s, slot.id);
        const ours = !!f && f.ownerGuildId === guildId;
        assert.equal(p.offersAbandon(), ours, `${name}, ${slot.id}: ${f ? `${f.ownerGuildId}'s Prefecture` : 'no Prefecture'}`);
        if (f) {
          // The engine's own answer for the viewer: theirs — accepted, bar the one centre-bound refusal; a rival's —
          // refused by its owner's name.
          const verdict = validateAction(s, abandonOf(guildId, f.id));
          if (ours) assert.ok(verdict.valid || /flying a Deep Scan Array to deploy on the centre/.test(verdict.reason), `${name}: ${verdict.reason}`);
          else assert.match(verdict.reason, /a guild abandons only its own/);
        }
        if (ours) offers += 1;
      }
      // A resource node's overlay (an occupied node opens it) never carries Abandon.
      for (const node of planet.nodes) {
        p.sandbox.openNodeOverlay('Resource Node', node.id, node.resourceType);
        assert.equal(p.offersAbandon(), false, `${name}, node ${node.id}`);
      }
    }
    // Nothing is sent, and the only card a row click opens is Plant's, on a plantable slot — never the abandon's.
    assert.ok(!p.log.some((e) => e[0] === 'send'), `${name}: a row click sends nothing`);
    assert.ok(p.log.every((e) => e[0] !== 'confirm' || e[1].title === 'Plant the Prefecture?'), `${name}: no abandon confirm`);
  }
  assert.equal(offers, 5, 'bare, position, carried, centreBound (g1) and rival (g2): one Prefecture each, offered once');
});

test('the control: HOME carries no Prefecture, so nothing there offers Abandon; a rival\'s Prefecture keeps its neutral overlay', () => {
  const home = page(W.position, { systemId: HOME.id });
  assert.equal((W.position.prefectures || []).some((f) => f.systemId === HOME.id), false, 'a home never carries a Prefecture');
  assert.ok(home.planets().some((pl) => pl.slots.length), 'HOME lists slots');
  const rival = page(W.rival);
  rival.click(PLANET_A, SLOT_A1);
  assert.deepEqual(rival.overlay(), { open: true, title: 'Settlement Slot 1',
    copy: `Settlement slot — ${SLOT_A1}. g2’s Prefecture stands here: it holds ${TARGET_NAME}.` });
  assert.equal(rival.abandonButton().style.display, 'none');
  assert.equal(rival.abandonButton().onclick, null, 'no handler left behind either');
});

test('the control: Abandon on the overlay closes it and opens the confirm — it sends nothing; the button is hidden again on the next overlay', () => {
  const p = page(W.position);
  p.click(PLANET_A, SLOT_A1);
  assert.deepEqual(p.overlay(), { open: true, title: 'Settlement Slot 1',
    copy: `Settlement slot — ${SLOT_A1}. Your Prefecture ${A.PREFECTURE} stands here: it holds ${TARGET_NAME} for your guild.` });
  assert.deepEqual(p.log, [], 'the overlay alone asks nothing');
  p.abandonButton().onclick();
  assert.equal(p.overlay().open, false, 'the overlay closes behind the card');
  assert.deepEqual(p.log.map((e) => e[0]), ['confirm'], 'the confirm, and no send');
  assert.equal(p.card().open, true);
  // The next overlay opened — f1's refinery slot opens VM, so a resource node's — hides the button again.
  p.sandbox.openNodeOverlay('Resource Node', S.NODE.id, S.NODE.resourceType);
  assert.equal(p.abandonButton().style.display, 'none');
  assert.equal(p.abandonButton().onclick, null);
});

// --- 2. the confirm ------------------------------------------------------------------------------------------------

// The stakes sentence, and its three counts read back as numbers.
const STAKES = /<p>You have <em>(no|\d+) ventures?<\/em>, <em>(no|\d+) machines?<\/em> and <em>(no|\d+) kits?<\/em> in ([^<]+) now\.<\/p>/;
const stakesOf = (body) => {
  const m = body.match(STAKES);
  assert.ok(m, `the stakes sentence is in the confirm: ${body}`);
  const n = (x) => (x === 'no' ? 0 : Number(x));
  return { ventures: n(m[1]), machines: n(m[2]), kits: n(m[3]), system: m[4] };
};
// What the engine's own eviction of `s` does: the `system_lost` payload's closed ventures and stranded assets.
function engineEviction(s, guildId, prefectureId) {
  const after = applyAction(s, abandonOf(guildId, prefectureId));
  const g = after.guilds.find((x) => x.id === guildId);
  const notice = g.events.filter((e) => e.type === 'system_lost').slice(-1)[0].payload;
  const kit = (id) => /_(outpost|deepScan|prefecture)_\d+$/.test(id);
  return { ventures: notice.ventureIds.length, machines: notice.strandedAssetIds.filter((id) => !kit(id)).length,
    kits: notice.strandedAssetIds.filter(kit).length, system: TARGET_NAME };
}

test('the confirm spells out the loss, on the Guild Adviser\'s card, with Abandon and Cancel', () => {
  const p = openAbandon(W.position);
  const opts = p.log[0][1];
  assert.equal(opts.title, 'Abandon the Prefecture?');
  assert.equal(opts.confirmLabel, 'Abandon Prefecture ▸');
  assert.equal(opts.singleButton, undefined, 'two buttons');
  const { body, ...card } = p.card();
  assert.deepEqual(card, { open: true, title: 'Abandon the Prefecture?', confirm: 'Abandon Prefecture ▸', cancel: 'Cancel', cancelShown: true });
  assert.equal(body,
    `<p>Your Prefecture on <em>Settlement Slot 1</em> holds <em>${TARGET_NAME}</em> for g1. Abandon it, and it is <em>destroyed</em>. It does not come back as a kit, and ${TARGET_NAME} is unclaimed again, open to any guild’s claim.</p>`
    + `<p>You have <em>2 ventures</em>, <em>3 machines</em> and <em>1 kit</em> in ${TARGET_NAME} now.</p>`
    + '<p>Your ventures there close. Every machine and kit you have there, the ventures’ own included, is left stranded, awaiting salvage: a heavy transport must carry them out. Any goods you hold there are forfeit. Any lane of yours with a stop there ends, and any Deep Scan Array of yours that touches no other territory you hold goes dark, its survey voided. Your exploration record of the system is kept.</p>'
    + '<p>This cannot be undone.</p>');
});

test('the confirm\'s counts are the engine\'s own eviction, state by state — the HOME miner and a machine aboard a heavy are not counted', () => {
  const cases = {
    bare: [W.bare, 'g1', A.PREFECTURE, { ventures: 0, machines: 0, kits: 0 }],
    position: [W.position, 'g1', A.PREFECTURE, { ventures: 2, machines: 3, kits: 1 }],
    carried: [W.carried, 'g1', A.SECOND, { ventures: 0, machines: 2, kits: 1 }],
    rival: [W.rival, 'g2', A.RIVAL_PREFECTURE, { ventures: 0, machines: 0, kits: 0 }],
  };
  for (const [name, [s, guildId, prefectureId, expected]] of Object.entries(cases)) {
    const stakes = stakesOf(openAbandon(s, { guildId }).card().body);
    assert.deepEqual(stakes, { ...expected, system: TARGET_NAME }, `${name}: the confirm's tally`);
    assert.deepEqual(stakes, engineEviction(s, guildId, prefectureId), `${name}: exactly what the engine closes and strands`);
  }
  // The carried factory keeps TARGET as its systemId, but it is in the hold: the eviction leaves it be, and so does the count.
  const aboard = W.carried.guilds.find((g) => g.id === 'g1').assets.find((a) => a.id === W.ids.idleFactory);
  assert.equal(aboard.systemId, TARGET);
});

// Hand-built: no play path puts a rival's venture in a system the player holds (a venture deploys only in its own
// guild's held system), so the owner filter is shown to bite on a view with one added.
test('the confirm counts only the player\'s OWN rows: a rival\'s venture row in the system (hand-built) is not counted', () => {
  const p = page(W.position);
  const view = buildSnapshot(W.position, 'g1');
  view.ventures.push({ id: 'v_rival', ownerGuildId: 'g2', type: 'mining', siteId: null, systemId: TARGET });
  p.sandbox.applySnapshot(view);
  p.click(PLANET_A, SLOT_A1);
  p.abandonButton().onclick();
  assert.deepEqual(stakesOf(p.card().body), { ventures: 2, machines: 3, kits: 1, system: TARGET_NAME });
});

test('the confirm reads sensibly at zero and at one — "no …", "1 venture", never "0", "null" or "undefined"', () => {
  const zero = openAbandon(W.bare).card().body;
  assert.match(zero, /<p>You have <em>no ventures<\/em>, <em>no machines<\/em> and <em>no kits<\/em> in /);
  assert.doesNotMatch(zero, /null|undefined|NaN|>0 /);
  // One venture on one machine: a miner granted into TARGET and put to work on NODE.
  let { s, id } = S.grantMachine(W.bare, 'g1', 'miner', TARGET);
  s = P.accept(s, createEstablishVentureAction({ guildId: 'g1', ventureId: 'm9', type: 'mining', siteId: S.NODE.id, assetId: id, resourceType: S.NODE.resourceType }));
  const one = openAbandon(s).card().body;
  assert.match(one, /<p>You have <em>1 venture<\/em>, <em>1 machine<\/em> and <em>no kits<\/em> in /);
  assert.deepEqual(stakesOf(one), engineEviction(s, 'g1', A.PREFECTURE));
  const { countWords } = page(W.bare).sandbox;
  assert.equal(countWords(0, 'kit', 'kits'), 'no kits');
  assert.equal(countWords(12, 'kit', 'kits'), '12 kits');
});

// --- 3. the send ---------------------------------------------------------------------------------------------------

test('the card\'s Abandon sends one well-formed abandonPrefecture and re-reads: the Prefecture is gone, the slot vacant, the system unclaimed', async () => {
  const p = openAbandon(W.position);
  p.pressConfirm();
  await p.settle();
  assert.deepEqual(p.log.slice(1), [
    ['send', { type: 'abandonPrefecture', guildId: 'g1', prefectureId: A.PREFECTURE }],
    ['refresh'],
  ], 'one action, the re-read, and no refusal card');
  assert.equal(p.card().open, false, 'the card closed on the press');
  assert.equal(P.held(p.state, 'g1', TARGET), false, 'the engine evicted the system');
  assert.equal(p.state.prefectures, undefined, 'the Prefecture is destroyed — no row left');
  // The re-read view: SLOT_A1 vacant, its row VACANT, and its click no longer an overlay with Abandon.
  assert.equal(p.sandbox.siteState(SLOT_A1), null);
  assert.match(p.row(PLANET_A, SLOT_A1).innerHTML, /<span class="venture-btn vacant"><span class="sb-act">VACANT<\/span><\/span>$/);
  p.log.length = 0;
  p.click(PLANET_A, SLOT_A1);
  assert.deepEqual(p.log, [['establish', { siteId: SLOT_A1, mine: false }]], 'a vacant slot of an unheld system, with no kit: the gated Establish');
});

test('the second Prefecture is abandoned by its own id', async () => {
  const p = openAbandon(W.carried);
  p.pressConfirm();
  await p.settle();
  assert.deepEqual(p.log[1], ['send', { type: 'abandonPrefecture', guildId: 'g1', prefectureId: A.SECOND }]);
  assert.equal(P.held(p.state, 'g1', TARGET), false);
});

test('Cancel closes the card and sends nothing: the Prefecture still stands', async () => {
  const p = openAbandon(W.position);
  p.pressCancel();
  await p.settle();
  assert.equal(p.card().open, false);
  assert.deepEqual(p.log.map((e) => e[0]), ['confirm'], 'no send, no re-read');
  assert.equal(p.state, W.position, 'the galaxy is untouched');
  // Opened again and confirmed, it is the one abandon — Cancel left nothing armed.
  p.click(PLANET_A, SLOT_A1);
  p.abandonButton().onclick();
  p.pressConfirm();
  await p.settle();
  assert.equal(p.log.filter((e) => e[0] === 'send').length, 1);
});

test('one abandon is sent however often the player confirms while the first is in flight', async () => {
  const answers = [];
  const p = page(W.position, { send: () => new Promise((resolve) => answers.push(() => resolve({ accepted: true }))) });
  p.click(PLANET_A, SLOT_A1);
  p.abandonButton().onclick();
  const onConfirm = p.log[0][1].onConfirm;
  const first = onConfirm();
  const second = onConfirm();                 // a second confirm while the first is still waiting on the engine
  answers.forEach((answer) => answer());
  await Promise.all([first, second]);
  assert.equal(p.log.filter((e) => e[0] === 'send').length, 1);
});

// --- 4. the refusal ------------------------------------------------------------------------------------------------

test('the centre-bound refusal: the engine refuses, the page shows its reason, and the Prefecture still stands — Abandon still offered', async () => {
  const p = openAbandon(W.centreBound);
  p.pressConfirm();
  await p.settle();
  assert.deepEqual(p.log.slice(1, 3), [['send', { type: 'abandonPrefecture', guildId: 'g1', prefectureId: A.PREFECTURE }], ['refresh']]);
  const refusal = p.log[3];
  assert.equal(refusal[0], 'confirm', 'a second card: the refusal');
  assert.deepEqual(p.card(), { open: true, title: 'The Prefecture was not abandoned',
    body: `<p>Refused: vehicle &quot;${A.ARRAY_HEAVY}&quot; is flying a Deep Scan Array to deploy on the centre of system &quot;${TARGET}&quot;, which needs the system held when it lands — let it land, or re-dispatch it, before abandoning the Prefecture</p>`,
    confirm: 'Close', cancel: 'Cancel', cancelShown: false });
  assert.equal(p.state, W.centreBound, 'nothing applied');
  assert.equal(P.held(p.state, 'g1', TARGET), true);
  p.pressConfirm();                            // Close
  assert.equal(p.card().open, false);
  assert.equal(p.log.length, 4, 'Close sends nothing');
  p.click(PLANET_A, SLOT_A1);
  assert.equal(p.offersAbandon(), true, 'the re-read slot is still our Prefecture');
});

test('a Prefecture already gone between the offer and the press, an unreachable server, a reason-less refusal — each shown, none pretended', async () => {
  // The operator abandons it first: the engine says so in its words.
  let p = openAbandon(W.position);
  p.state = applyAction(p.state, abandonOf('g1', A.PREFECTURE));
  p.pressConfirm();
  await p.settle();
  assert.equal(p.card().body, `<p>Refused: there is no Prefecture &quot;${A.PREFECTURE}&quot;</p>`);
  p = openAbandon(W.position, { send: () => { throw new Error('HTTP 502'); } });
  p.pressConfirm();
  await p.settle();
  assert.equal(p.card().body, '<p>The Syndicate could not be reached: HTTP 502</p>');
  assert.equal(P.held(p.state, 'g1', TARGET), true);
  p = openAbandon(W.position, { send: () => ({ accepted: false }) });
  p.pressConfirm();
  await p.settle();
  assert.equal(p.card().body, '<p>Refused: the Syndicate declined</p>');
});

// --- 5. everything else, unchanged ---------------------------------------------------------------------------------

const sha = (x) => crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex');

// manifestAsMain(state, guildId, systemId) -> the hash of everything the manifest draws for that view, read without
// this slice's one new piece (the overlay's Abandon button): every listed slot's row, what its click does (the log,
// the overlay, the card), and every listed site's overlay as openNodeOverlay draws it.
function manifestAsMain(state, guildId, systemId) {
  const p = page(state, { guildId, systemId });
  const out = [];
  for (const planet of p.planets()) {
    for (const [i, slot] of planet.slots.entries()) {
      p.log.length = 0;
      const row = p.row(planet.id, slot.id);
      p.click(planet.id, slot.id);
      const card = p.log.some((e) => e[0] === 'confirm') ? p.card() : null;
      out.push([slot.id, row.innerHTML, p.log.map((e) => (e[0] === 'confirm' ? ['confirm', e[1].title] : e)), p.overlay(), card]);
      if (card) p.pressCancel();
      p.sandbox.openNodeOverlay(`Settlement Slot ${i + 1}`, slot.id, 'Settlement slot');
      out.push([slot.id, p.overlay()]);
    }
    for (const node of planet.nodes) {
      p.sandbox.openNodeOverlay('Resource Node', node.id, node.resourceType);
      out.push([node.id, p.overlay()]);
    }
  }
  return sha(out).slice(0, 16);
}
// Every view, as main's own engine + client drew it at a869f6b — hashed there by this same test (it reads nothing
// this slice added, so it passes on main's game.html too) and pinned.
const PINS = {
  'bare (g1, TARGET)': 'c388068f072f57a3', 'bare (g1, HOME)': '83f29dbc68ecb96d',
  'position (g1, TARGET)': 'e09d32aac176f39c', 'position (g1, HOME)': '83f29dbc68ecb96d',
  'position (g2, TARGET)': 'c8e4ac5ea7e7a5c1', 'carried (g1, TARGET)': '6aa9d820f8746e7e',
  'centreBound (g1, TARGET)': 'e09d32aac176f39c', 'fallow (g1, TARGET)': '628214bbb80aa110',
  'rival (g1, TARGET)': '0563ae6d5d33aa84', 'rival (g2, TARGET)': '8ec2ee9fe48691f2',
};

test('GUARD: every slot row, row click, overlay and Plant confirm renders exactly as main rendered it, in every view', () => {
  const actual = Object.fromEntries(Object.entries(VIEWS).map(([name, [s, guildId, systemId]]) => [name, manifestAsMain(s, guildId, systemId)]));
  assert.deepEqual(actual, PINS);
});

test('GUARD: the views it pins reach every slot branch — our Prefecture and a rival\'s, a venture, vacant, a Plant', () => {
  const kinds = new Set();
  for (const [s, guildId, systemId] of Object.values(VIEWS)) {
    const p = page(s, { guildId, systemId });
    for (const planet of p.planets()) {
      for (const slot of planet.slots) {
        const st = p.sandbox.siteState(slot.id);
        if (st) kinds.add(st.kind === 'other' && st.prefectureId ? 'rival-prefecture' : st.kind);
        else kinds.add(p.sandbox.plantKitFor(st) ? 'plantable' : 'vacant');
      }
    }
  }
  assert.deepEqual([...kinds].sort(), ['plantable', 'prefecture', 'refinery', 'rival-prefecture', 'vacant']);
});

test('wiring: one Abandon button in the overlay, hidden until shown; styled; the bridge published once', () => {
  const count = (src, s) => src.split(s).length - 1;
  assert.equal(count(html, '<button class="close abandon" id="overlayAbandon" style="display:none">Abandon Prefecture</button>'), 1);
  assert.match(html, /\.overlay-panel button\.abandon\{/);
  assert.equal(count(html, 'window.__myHoldingsIn = function(systemId){'), 1);
  assert.match(viewSrc, /window\.__myHoldingsIn\(SYSTEM\.id\)/);
  assert.match(viewSrc, /type:'abandonPrefecture', guildId:player\.guildId, prefectureId:site\.prefectureId/);
});
