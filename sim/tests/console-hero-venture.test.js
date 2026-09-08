'use strict';

// console-hero-venture.test.js — the SYSTEM MANIFEST Production Console's industrial-hero
// "Open venture management ▸" must open the venture the console actually put on screen, and
// the console must never DEFAULT that hero onto a venture the player never chose.
//
// THE BUG THIS GUARDS (reported from the live game, 08-09-26). The embedded console's hero,
// and so its `#ihManage` button (which opens `window.__vmHeroVenture`, the last venture the
// console posted up the bridge), opened a DEUTERIUM MINE regardless of what the player was
// looking at. Root cause, in `client/console.html`:
//   (a) the default-good picker set `STATE.good` to `report.mines[0].good` — this system's
//       FIRST-established venture's good — with no regard for whether the console surfaces it.
//       deuterium is a HIDDEN good (§1.4, `HIDDEN_GOODS`): a guild whose first venture is a
//       deuterium mine therefore opened the whole console on an un-consoled good; and
//   (b) the hero auto-open selected `report.mines[0]` (the system's first mine, ANY good) as
//       the "lead" instead of the first producer of the good ON SCREEN — so it posted that
//       deuterium mine up the bridge, painting the hero and pinning `__vmHeroVenture` to it.
// Both are now keyed on the VISIBLE good: the default skips `HIDDEN_GOODS`, and the auto-open
// opens on `producersOf(report, good)[0]` only while nothing valid FOR THIS GOOD is selected
// (`!heroSelection(good, report)` — the same producer/consumer test the hero itself uses).
//
// The prior slices' checks only asserted that a popup opened from the console hero, never that
// it opened the RIGHT venture — which is why this shipped. This is the missing correctness
// tripwire, at the served-page level (the way every client slice in this repo is pinned): a
// page that silently reverted the wiring would still render, so the guard is on the bytes. The
// behavioural end-to-end (headless Chromium, driving the real console→bridge→popup path for a
// producer chip, a consumer chip and the Planet-Manifest path) is recorded in
// docs/venture-management.md; this file is what `node --test` runs.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { makeServer } = require('../server.js');
const { getSystemLayout } = require('../seed.js');
const { HOME_SYSTEM, HOME_MINE } = require('./home-anchor.js');

let server, base;

before(async () => {
  server = makeServer();
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  if (server.closeAllConnections) server.closeAllConnections();
  server.close();
});

async function req(method, p, body) {
  const res = await fetch(base + p, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
}

// A deuterium node in the HOME system, derived from the seed (like home-anchor.js) so a
// regenerated seed carries the test with it rather than pinning seed-7331's own ids.
function firstDeuteriumNode() {
  const layout = getSystemLayout(HOME_SYSTEM);
  for (const pl of layout.planets || []) {
    for (const n of pl.resourceNodes || []) {
      if (n.resourceType === 'deuterium') return n.id;
    }
  }
  throw new Error('no deuterium node in the home system on this seed');
}

// The TRIGGER CONDITION is real: a guild whose first-established venture is a deuterium mine
// has report.mines[0] === that deuterium mine, and deuterium is NOT in the console's goods.
test('the trigger is real: a deuterium mine can be report.mines[0], and deuterium is un-consoled', async () => {
  const G = 'player-guild';
  const DEUT = firstDeuteriumNode();
  await req('POST', '/reset');
  await req('POST', '/action', { type: 'foundGuild', guildId: G, credits: 100000, influence: 100000, homeSystemId: HOME_SYSTEM });
  // Establish the DEUTERIUM mine FIRST (so it lands at report.mines[0]), then a titanium mine.
  const d = await req('POST', '/action', { type: 'establishVenture', guildId: G, ventureId: 'mine_deut', ventureType: 'mining', siteId: DEUT, assetId: `asset_${G}_miner_01`, resourceType: 'deuterium', productionRate: 4 });
  assert.equal(d.body.accepted, true, `deuterium mine establish should be accepted: ${d.body.reason}`);
  const t = await req('POST', '/action', { type: 'establishVenture', guildId: G, ventureId: 'mine_ti', ventureType: 'mining', siteId: HOME_MINE, assetId: `asset_${G}_miner_02`, resourceType: 'titanium', productionRate: 5 });
  assert.equal(t.body.accepted, true, `titanium mine establish should be accepted: ${t.body.reason}`);
  await req('POST', '/tick');

  const snap = (await req('GET', '/snapshot')).body;
  const sys = (snap.production || []).find((p) => p.guildId === G).systems.find((s) => s.systemId === HOME_SYSTEM);
  // The first-established venture is the deuterium mine — the very venture the old default-good
  // picker and auto-open would both have latched the console (and its hero) onto.
  assert.equal(sys.mines[0].ventureId, 'mine_deut');
  assert.equal(sys.mines[0].good, 'deuterium');

  // deuterium is a REAL raw good the engine mines (that is why it can be report.mines[0]) —
  // it is the CONSOLE that must not surface it (HIDDEN_GOODS, pinned in the served-page test
  // below), so a deuterium mine must never become the good the console opens on.
  const goods = (await req('GET', '/goods')).body;
  assert.ok((goods.raw || []).includes('deuterium'), 'deuterium is a real raw good the engine mines');
});

// The FIX, pinned as served bytes: the default good and the hero auto-open are both keyed on
// the VISIBLE good, and the good-blind `report.mines[0]` lead is gone.
test('GET /console keys the default good and the hero auto-open on the VISIBLE good', async () => {
  const html = await (await fetch(base + '/console')).text();

  // deuterium is declared hidden, and the default-good picker HONOURS that — it skips any
  // producer whose good is in HIDDEN_GOODS instead of taking report.mines[0]'s good blind.
  assert.match(html, /HIDDEN_GOODS\s*=\s*\{\s*deuterium/);
  assert.match(html, /!HIDDEN_GOODS\[g\]/);   // the default-good skip

  // The hero auto-open opens on the first PRODUCER OF THE GOOD ON SCREEN, and only while
  // nothing valid for that good is selected (heroSelection is the hero's own validity test).
  assert.match(html, /!heroSelection\(good, report\)/);
  assert.match(html, /producersOf\(report, good\)\[0\]/);

  // The REGRESSION marker: the old good-blind lead (this system's first mine, whatever it
  // produces) must be gone. Its return is exactly the reported bug.
  assert.ok(!html.includes('var lead = (report.mines || [])[0];'),
    'the hero auto-open must not select report.mines[0] blind — it opened a deuterium mine regardless of the good on screen');

  // The bridge the hero manage button reads is unchanged: a selected venture is posted up as
  // `kind:'venture', name:<id>` (the parent stores it as __vmHeroVenture and #ihManage opens it).
  assert.match(html, /kind\s*:\s*'venture'\s*,\s*name\s*:\s*id/);
});
