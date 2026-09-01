'use strict';

// tools/run_economy.js — the ECONOMY RECORDER: a lockstep, multi-guild observation
// harness for the fuel economy (the pool, the mean line, and rationing).
//
// It is the sibling of `tools/run_scenario.js`, not a generalisation of it. That one
// watches the PRODUCTION/LICENCE layer of a single guild; this one watches the FUEL layer
// across several. They share the engine spine — `advance(state, actions)` and
// `buildSnapshot(state)` — and deliberately nothing else: folding them together would
// produce one recorder that traced neither subject well.
//
// WHY IT EXISTS. The mean line and rationing are inherently MULTI-GUILD facts and cannot
// be seen with one guild:
//   - density-beats-sprawl only appears when guilds of comparable size sit on OPPOSITE
//     sides of their own lines, so the modifier's spread has something to be a spread of;
//   - `rationGrants`'s proportional clip only runs when Σdesired exceeds the pool, which
//     one guild against a galaxy-scale influx will never manage.
// It doubles as two other things. (a) AN INTEGRATION TRIPWIRE: `advance()` asserts every
// invariant on every tick, so a run that COMPLETES is itself a proof that invariant 1
// (fuel conservation) held across every influx, every grant and every rationed clip of
// that run. (b) THE TUNING RIG FOR 5b: the fixed influx cannot track a variable draw, so
// the pool bleeds down and rationing switches on — the drift the price controller exists
// to correct, made watchable rather than argued about.
//
// One tick of the loop, in lockstep:
//   1. read the snapshot (PRE) — the view every driver acts on;
//   2. the WORLD driver returns any scheduled actions for this producing tick;
//   3. EACH guild's bot returns that guild's actions for this producing tick;
//   4. advance(state, [...worldActions, ...allBotActions]) — ONE tick;
//   5. read the snapshot again (POST) and append ONE JSONL line.
//
// WHICH SNAPSHOT EACH FIELD READS — the same deliberate split `run_scenario.js` documents,
// applied to this subject:
//   - The ECONOMY INPUTS (gp, rp, expected, modifier) come from the PRE snapshot — the
//     state every driver sensed, and the state step 6's issuance read when it decided the
//     grant. Reading them POST would describe a boundary that had already been paid.
//     ⚠ ONE PRECISE CAVEAT, worth stating rather than glossing: `advance` runs INTAKE and
//     then the tick, so an ACTION that lands on the same tick (a venture established, say)
//     is already applied by the time step 6 reads the state, while the PRE snapshot was
//     taken before it. On such a tick — and only such a tick — the `gp` column is one
//     action stale relative to the grant beside it. The bundled scenario keeps its one
//     scheduled action OFF a cycle boundary so the two can never disagree in its trace,
//     and a test pins that. A scenario that does schedule an action onto a boundary should
//     expect that column to lag by exactly that action.
//   - The REALIZED OUTPUTS (fuelGrant, hoard, and the pool level) come from the POST
//     snapshot, because they are what the tick actually did.
// So each line reads: "the engine saw the guild standing HERE, and paid it THAT."
//
// THE RECORDER COMPUTES NO GAME NUMBER (design.md §18). Every figure below is read off
// `buildSnapshot`; `gap` is the one arithmetic expression in the file and it is a
// presentation convenience (rp − expected, both read), not a rule. It imports `advance`
// and `buildSnapshot` and NOTHING else from `sim/` — in particular it never reaches into
// `issuance.js` or `meanline.js` to re-derive a grant or a modifier, because a second
// derivation could only ever disagree with the engine's.
//
// DETERMINISM (invariant 9): pure throughout — no `Date`, no `Math.random`. Two runs of
// one scenario yield byte-identical JSONL, which the tests pin.

const fs = require('node:fs');
const path = require('node:path');

const { advance } = require('../sim/run.js');
const { buildSnapshot } = require('../sim/snapshot.js');

// --- Per-line extraction (reads only buildSnapshot output — no engine maths) ---

// The grant a guild took on THIS producing tick, or null. `fuelGrant` is the guild's
// standing record of its LAST grant, so `thisTick` is what distinguishes "paid just now"
// from "paid three cycles ago and untouched since" — without it every non-boundary tick
// would report a stale grant as if it had just happened.
function grantThisTick(guildRow) {
  const grant = guildRow && guildRow.fuelGrant;
  if (!grant || !grant.thisTick) return null;
  return grant;
}

// One guild's row for one tick. `pre`/`post` are that guild's rows from the two snapshots;
// either may be absent (a guild founded mid-run has no PRE row on its first tick).
function guildLine(id, pre, post) {
  const grant = grantThisTick(post);
  // The mean-line inputs as the issuance step saw them (PRE). A guild that did not yet
  // exist reads 0/1 — the same neutral the empty-guild guard returns — rather than null,
  // so a column never changes type mid-trace.
  const gp = pre ? pre.guildPoints : 0;
  const rp = pre ? pre.guildReputation : 0;
  const expected = pre ? pre.expectedReputation : 0;
  const modifier = pre ? pre.issuanceModifier : 1;
  return {
    id,
    gp,
    rp,
    expected,
    // The ONE arithmetic expression in this file, and it is presentation: both terms are
    // read off the snapshot, and the engine's own modifier is read beside it rather than
    // recomputed from this difference.
    gap: rp - expected,
    modifier,
    desired: grant ? grant.desired : 0,
    granted: grant ? grant.granted : 0,
    rationed: grant ? grant.rationed : false,
    hoard: post ? post.fuelHoard : 0,
  };
}

// The galaxy-level fuel picture for one tick. `level` is the pool AFTER the boundary's
// influx and issuance; the two sigmas are summed over the guilds paid on THIS tick.
//
// `rationing` is derived from the two sigmas rather than from any guild's `rationed` flag,
// so it is a statement about the CYCLE (did the pool fail to cover the galaxy's draw?)
// rather than about any one guild. On a non-boundary tick both sigmas are 0 and this is
// false — nothing was asked for, so nothing was refused.
//
// THE CONTROLLER'S OWN THREE NUMBERS (added for slice 5b-ii) ride here too, and every one
// of them is READ from the snapshot's `galacticSupply.fuel` — this recorder still computes
// no game number and still imports nothing but `advance` and `buildSnapshot`. `price` is
// the price the controller posted at the END of this cycle, i.e. the one NEXT cycle will
// issue at (§8); `target` and `avgDraw` are what it steered by. Read `level` against
// `target` and the price's direction is no longer a mystery: below ⇒ rising, above ⇒
// falling, at it ⇒ exactly the reference.
function reserveLine(post, guildLines) {
  const sigmaDesired = guildLines.reduce((n, g) => n + g.desired, 0);
  const sigmaGranted = guildLines.reduce((n, g) => n + g.granted, 0);
  const fuel = post.galacticSupply.fuel;
  return {
    level: fuel.reserve,
    price: fuel.fuelPrice,
    target: fuel.targetReserve,
    avgDraw: fuel.avgDraw,
    sigmaDesired,
    sigmaGranted,
    rationing: sigmaGranted < sigmaDesired,
  };
}

// --- The recorder ------------------------------------------------------------

// runEconomy(spec) -> { trace, jsonl, lastTick, name }.
//   spec: {
//     name, ticks,
//     makeState: () => a fresh tick-0 state,
//     world:     (snapshot, producingTick) => { actions, events } | null,
//     bots:      { [guildId]: (snapshot) => { actions, reasonTag, sensed } } | null,
//     outPath?:  where to write the JSONL (optional),
//   }
//
// `bots` is the multi-guild generalisation of `run_scenario`'s single `bot`. The bots are
// driven in SORTED GUILD-ID ORDER, not object-insertion order: the actions they return are
// concatenated into one intake list, and `advance` applies them first-valid-wins, so the
// order they are collected in is an input to the run. Sorting it makes the run reproducible
// from the spec alone rather than from how the spec's object literal happened to be typed.
function runEconomy(spec) {
  const {
    name, ticks, makeState, world = null, bots = null, outPath = null,
  } = spec;
  if (typeof makeState !== 'function') throw new Error('runEconomy: makeState must be a function');
  if (!Number.isInteger(ticks) || ticks <= 0) throw new Error('runEconomy: ticks must be a positive integer');

  const botIds = bots ? Object.keys(bots).sort() : [];

  let state = makeState();
  const lines = [];

  for (let i = 0; i < ticks; i += 1) {
    const producingTick = state.tick + 1;      // the tick this iteration advances to
    const pre = buildSnapshot(state);          // the view every driver — and step 6 — acts on

    const worldOut = world ? world(pre, producingTick) : { actions: [], events: [] };
    const botOuts = botIds.map((id) => ({ id, out: bots[id](pre) }));

    const actions = [
      ...(worldOut.actions || []),
      ...botOuts.flatMap((b) => b.out.actions || []),
    ];
    const { state: next, results } = advance(state, actions);
    state = next;

    const post = buildSnapshot(next);

    // ONE ROW PER GUILD PRESENT THIS TICK, in a STABLE order (by id) so two runs — and two
    // ticks of one run — line up column for column. The roster is the union of both
    // snapshots: a guild founded on this very tick appears in POST but not PRE, and a
    // guild is never silently dropped from a line it belongs on.
    const ids = [...new Set([
      ...(pre.guilds || []).map((g) => g.id),
      ...(post.guilds || []).map((g) => g.id),
    ])].sort();
    const guilds = ids.map((id) => guildLine(
      id,
      (pre.guilds || []).find((g) => g.id === id) || null,
      (post.guilds || []).find((g) => g.id === id) || null,
    ));

    lines.push({
      tick: producingTick,
      reserve: reserveLine(post, guilds),
      guilds,
      worldEvents: worldOut.events || [],
      botDecisions: botOuts.map((b) => ({
        guildId: b.id,
        actions: b.out.actions || [],
        reasonTag: b.out.reasonTag,
      })),
      // The engine's per-action verdicts — a plain audit of what the drivers submitted.
      intake: results.map((r) => ({
        type: r.action && r.action.type,
        accepted: r.accepted,
        ...(r.accepted ? {} : { reason: r.reason }),
      })),
    });
  }

  const jsonl = lines.map((l) => JSON.stringify(l)).join('\n') + '\n';

  if (outPath) {
    const resolved = path.resolve(outPath);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, jsonl);
  }

  return { trace: lines, jsonl, lastTick: state.tick, name: name || 'economy' };
}

module.exports = { runEconomy };

// --- CLI ---------------------------------------------------------------------
// `node tools/run_economy.js [outPath]` runs the four-guild mean-line scenario, writes its
// JSONL trace, and prints the watchable table. The table is the point: the pool's dip, the
// price rising to answer it, and the draw bending back to the influx should be readable at
// a glance — and, in the crisis run, the cycle the pool can no longer cover the draw and
// the rationed tail after it.
//
// TWO SCENARIOS, chosen by argv (slice 5b-ii): the default four-guild run shows the
// controller STABILISING a galaxy, and `--crisis` shows the crunch edge that survives it —
// a galaxy too big for its supply, pinned at the price ceiling and rationing anyway.
// How many per-guild figures the table prints on a row before it says "…+N more". The
// JSONL keeps every guild; this is purely how wide the human table is allowed to get.
const CLUSTER_CAP = 4;

if (require.main === module) {
  const scenarios = require('./scenarios/economy_meanline.js');
  const wantsCrisis = process.argv.includes('--crisis');
  const scenario = wantsCrisis ? scenarios.buildCrisisScenario() : scenarios.buildScenario();
  // The four-guild run keeps the committed artefact's original name (`economy.jsonl`, which
  // the roadmap names); the crisis run lands beside it under its own.
  const defaultFile = wantsCrisis ? 'economy_crisis.jsonl' : 'economy.jsonl';
  const outPath = process.argv.filter((a) => !a.startsWith('--'))[2]
    || path.join(__dirname, '..', 'data', 'runs', defaultFile);

  const { trace } = runEconomy({ ...scenario, outPath });

  // Only the BOUNDARY ticks carry an economy event; the ticks between them move no fuel at
  // all. Printing all of them would bury four interesting rows under thirty-six empty ones,
  // so the table shows the boundaries and says how many quiet ticks it skipped.
  // The ticks that actually moved fuel. Only a CYCLE BOUNDARY carries an economy event;
  // between them the pool does not move at all, so the level on the tick before a boundary
  // is the pool as it stood when that boundary opened.
  const cycles = [];
  for (let i = 0; i < trace.length; i += 1) {
    const line = trace[i];
    if (!line.guilds.some((g) => g.desired > 0 || g.granted > 0)) continue;
    const before = i > 0 ? trace[i - 1].reserve.level : null;
    // THE INFLUX IS OBSERVED, NOT ASSUMED. It is not a snapshot field, and this recorder
    // deliberately does not import the engine's constant — so the column is derived from
    // the pool's own movement: whatever came in, minus whatever went out, is the change.
    // If the influx ever stops being a fixed number, this column reports the real one.
    const influx = before === null ? null : (line.reserve.level - before) + line.reserve.sigmaGranted;
    cycles.push({ line, influx });
  }

  console.log(`=== ${scenario.name}: ${trace.length} ticks → ${outPath} ===`);
  console.log(`(one row per CYCLE BOUNDARY — ${cycles.length} of ${trace.length} ticks move fuel; the rest are quiet)\n`);

  const idsSeen = [...new Set(trace.flatMap((l) => l.guilds.map((g) => g.id)))].sort();
  console.log(`guilds (${idsSeen.length}): ${idsSeen.length > 8
    ? `${idsSeen.slice(0, 8).join(', ')}, …+${idsSeen.length - 8} more`
    : idsSeen.join(', ')}`);
  console.log('per-guild cluster is  id:modifier×→granted/desired  (a ✂ marks a clipped grant)');
  // The controller's own columns (slice 5b-ii). `price` is what the controller posted at the
  // END of this cycle — the price the NEXT row's grants are issued at (§8) — and `target` is
  // the demand-relative level it is steering the pool to. The story is in `pool` vs `target`:
  // pool short of target ⇒ the price rises ⇒ Σdesired falls toward the influx.
  console.log('price is what the controller POSTED at the end of the cycle — i.e. what the NEXT row issues at\n');
  console.log('tick |  pool  | target | price | influx | Σdesired Σgranted |        | per guild');
  console.log('-----+--------+--------+-------+--------+-------------------+--------+------------------------');

  let wasRationing = null;
  for (const { line, influx } of cycles) {
    const r = line.reserve;
    if (wasRationing !== null && r.rationing !== wasRationing) {
      console.log(`     |        |        |       |        |                   |        |  ${r.rationing
        ? '▼▼▼ THE POOL CAN NO LONGER COVER THE DRAW — RATIONING BEGINS ▼▼▼'
        : '▲▲▲ the pool recovers — grants paid in full again ▲▲▲'}`);
    }
    wasRationing = r.rationing;

    // The per-guild detail, CAPPED so a big galaxy stays readable (slice 5b-ii adds the
    // 16-guild crisis run, whose full cluster is four screens wide and tells you nothing
    // the first few rows do not — every wing of it is a copy of the same guild).
    const drawing = line.guilds.filter((g) => g.desired > 0 || g.granted > 0);
    const shown = drawing.slice(0, CLUSTER_CAP);
    const cluster = shown
      .map((g) => `${g.id.slice(0, 4)}:${g.modifier.toFixed(2)}×→${g.granted}/${g.desired}${g.rationed ? '✂' : ''}`)
      .join('  ')
      + (drawing.length > shown.length ? `  …+${drawing.length - shown.length} more` : '');
    console.log(
      `${String(line.tick).padStart(4)} `
      + `| ${String(r.level).padStart(6)} `
      + `| ${r.target.toFixed(0).padStart(6)} `
      + `| ${r.price.toFixed(2).padStart(5)} `
      + `| ${String(influx === null ? '-' : `+${influx}`).padStart(6)} `
      + `| ${String(r.sigmaDesired).padStart(8)} ${String(r.sigmaGranted).padStart(8)} `
      + `| ${(r.rationing ? 'RATION' : '      ').padEnd(6)} `
      + `| ${cluster}`,
    );
  }

  // The world driver's scheduled perturbations, called out where they land.
  const events = trace.filter((l) => (l.worldEvents || []).length);
  if (events.length) {
    console.log('\nworld events:');
    for (const l of events) {
      // The note lives on the driver's own `detail` block (tools/world_relief.js).
      for (const e of l.worldEvents) console.log(`  tick ${l.tick}: [${e.kind}] ${(e.detail && e.detail.note) || ''}`);
    }
  }

  // The size-0 guild, if the scenario carries one: the empty-guild guard, tick by tick.
  const zero = trace[trace.length - 1].guilds.filter((g) => g.gp === 0);
  if (zero.length) {
    console.log('\nthe empty-guild guard (a guild holding nothing):');
    for (const g of zero) {
      console.log(`  ${g.id}: gp ${g.gp}, expected ${g.expected}, modifier ${g.modifier} `
        + `→ desired ${g.desired} (no division by zero, no grant taken)`);
    }
  }
}
