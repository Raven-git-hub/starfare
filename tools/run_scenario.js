'use strict';

// tools/run_scenario.js — the LOCKSTEP RUN-RECORDER (roadmap Phase 1 Stage 2,
// the licence-layer sequence's step (3)). An in-process, deterministic harness
// that runs a single-guild scenario tick-by-tick, driven by a WORLD driver and a
// BOT driver, emitting a per-tick JSONL trace so a run can be analysed and bot
// profiles developed. Player tooling: it drives the SAME `sim/` engine the tests
// guard, through the SAME `advance(state, actions)` primitive — it changes no
// engine file.
//
// One tick of the loop, in lockstep:
//   1. read the snapshot (buildSnapshot — the read-only engine view, §5/§7);
//   2. the WORLD driver returns any scheduled actions for this producing tick;
//   3. the BOT driver returns the guild's actions for this producing tick;
//   4. advance(state, [...worldActions, ...botActions]) — ONE tick;
//   5. append ONE JSONL line describing the tick.
//
// WHICH SNAPSHOT EACH FIELD READS (a deliberate, documented split):
//   - The window + production telemetry is read from the PRE-advance snapshot —
//     the engine's own projection for the producing tick, which is exactly what
//     the drivers sensed. This is what carries the window's met/breach resolution
//     ON the boundary tick (the post-advance snapshot previews the NEXT tick, where
//     the window has already rolled, so the resolution would be lost there).
//   - The realized holdings (credits, per-system stockpiles) are read from the
//     POST-advance snapshot — the actual result of the tick, with no lag.
// So each line reads: "the engine projected THIS for the tick the drivers acted on,
// and the tick actually left the guild holding THAT." Both halves are engine truth
// (buildSnapshot); the recorder computes no game number of its own.
//
// DETERMINISM: pure functions throughout — no Math.random, no Date. Two runs of
// the same scenario yield byte-identical JSONL (proven in the tests). A NULL bot
// driver (bot: null) yields a plain state-recorder for a static scenario.

const fs = require('node:fs');
const path = require('node:path');

const { advance } = require('../sim/run.js');
const { buildSnapshot } = require('../sim/snapshot.js');

// --- Per-line extraction (reads only buildSnapshot output — no engine maths) ---

// The resolved production report for (guildId, systemId) inside a snapshot's
// `production` block, or null if the guild/system isn't producing yet.
function reportFor(snapshot, guildId, systemId) {
  const g = (snapshot.production || []).find((p) => p.guildId === guildId);
  if (!g) return null;
  return (g.systems || []).find((s) => s.systemId === systemId) || null;
}

// The window telemetry for every COMMITTED good in the report (a good has a
// `window` sub-object only when its aggregate commitment Q > 0). Keyed by good.
function windowsFrom(report) {
  const out = {};
  if (!report || !report.goods) return out;
  for (const [good, entry] of Object.entries(report.goods)) {
    if (!entry.window) continue;
    const w = entry.window;
    out[good] = {
      Q: w.Q,
      delivered: w.delivered,
      requiredRate: w.requiredRate,
      ticksRemaining: w.ticksRemaining,
      sendThisTick: w.sendThisTick,
      pctAchieved: w.pctAchieved,
      status: w.status,
    };
  }
  return out;
}

// The per-good flow and per-refinery output the engine projected for this tick —
// the squeeze/relief signal (fresh, the Gate-1 fork split, and each refinery's
// realized rate + minted output). Read verbatim from the report.
function productionFrom(report) {
  if (!report) return null;
  const goods = {};
  for (const [good, e] of Object.entries(report.goods || {})) {
    goods[good] = {
      fresh: e.fresh,
      supplied: e.supplied,
      forkSyndicate: e.fork ? e.fork.syndicate : 0,
      forkDownstream: e.fork ? e.fork.downstream : 0,
      forkReserve: e.fork ? e.fork.stockpile : 0,
      reserveDelta: e.reserveDelta,
    };
  }
  const refineries = (report.refineries || []).map((r) => ({
    ventureId: r.ventureId,
    rate: r.rate,
    minted: r.minted,
    bottleneckGood: r.bottleneckGood,
  }));
  return { systemId: report.systemId, goods, refineries };
}

// The guild's realized holdings after the tick (POST snapshot): credits and the
// per-system stockpiles (each system's own pool — the reserves and processed
// output the tick actually left in place, ruling B1).
function holdingsFrom(postSnapshot, guildId) {
  const guild = (postSnapshot.guilds || []).find((g) => g.id === guildId);
  if (!guild) return null;
  return {
    id: guild.id,
    credits: guild.credits,
    stockpilesBySystem: guild.stockpilesBySystem || {},
  };
}

// --- The recorder ------------------------------------------------------------

// runScenario(spec) -> { trace, jsonl, firstHash, lastTick }.
//   spec: {
//     name, guildId, systemId, ticks,
//     makeState:  () => a fresh tick-0 state,
//     world:      (snapshot, producingTick) => { actions, events } | null,
//     bot:        (snapshot) => { actions, reasonTag, sensed }       | null,
//     outPath?:   where to write the JSONL (optional; caller may write instead),
//   }
// `world`/`bot` may each be null: a null bot yields a plain state-recorder.
function runScenario(spec) {
  const {
    name, guildId, systemId, ticks, makeState, world = null, bot = null, outPath = null,
  } = spec;
  if (typeof makeState !== 'function') throw new Error('runScenario: makeState must be a function');
  if (!Number.isInteger(ticks) || ticks <= 0) throw new Error('runScenario: ticks must be a positive integer');

  let state = makeState();
  const lines = [];

  for (let i = 0; i < ticks; i += 1) {
    const producingTick = state.tick + 1; // the tick this iteration advances to
    const sense = buildSnapshot(state); // the view the drivers act on (previews producingTick)

    const worldOut = world ? world(sense, producingTick) : { actions: [], events: [] };
    const botOut = bot
      ? bot(sense)
      : { actions: [], reasonTag: 'null-bot (static state-recorder)', sensed: null };

    const actions = [...(worldOut.actions || []), ...(botOut.actions || [])];
    const { state: next, results } = advance(state, actions);
    state = next;

    const senseReport = reportFor(sense, guildId, systemId);
    const post = buildSnapshot(next);

    lines.push({
      tick: producingTick,
      guild: holdingsFrom(post, guildId), // realized, POST-advance
      windows: windowsFrom(senseReport), // projected for this tick, PRE-advance (carries boundary status)
      production: productionFrom(senseReport), // projected flow/output for this tick
      worldEvents: worldOut.events || [],
      botDecisions: {
        actions: botOut.actions || [],
        reasonTag: botOut.reasonTag,
        sensed: botOut.sensed || null,
      },
      // The engine's per-action verdicts for this tick (accepted / rejected+reason)
      // — a plain audit of what the drivers submitted actually did.
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

  return { trace: lines, jsonl, lastTick: state.tick, name: name || 'scenario' };
}

module.exports = { runScenario };

// --- CLI ---------------------------------------------------------------------
// `node tools/run_scenario.js [outPath]` runs the supply-relief scenario and
// writes its JSONL trace, then prints a short per-window human summary (like
// sim/demo.js) so the squeeze→relief arc is watchable, not just trusted.
if (require.main === module) {
  const { buildScenario } = require('./scenarios/supply_relief.js');
  const scenario = buildScenario();
  const outPath = process.argv[2]
    || path.join(__dirname, '..', 'data', 'runs', 'supply_relief.jsonl');

  const { trace } = runScenario({ ...scenario, outPath });

  console.log(`=== ${scenario.name}: ${trace.length} ticks → ${outPath} ===\n`);
  console.log('tick | fresh Ti | licence send/req | delivered/Q  status  | refinery rate·minted | Ti reserve | alloy');
  console.log('-----+----------+------------------+----------------------+----------------------+------------+------');
  for (const line of trace) {
    const sys = scenario.systemId;
    const prod = line.production || { goods: {}, refineries: [] };
    const ti = (prod.goods && prod.goods.titanium) || {};
    const win = (line.windows && line.windows.titanium) || {};
    const ref = (prod.refineries || [])[0] || {};
    const pool = (line.guild && line.guild.stockpilesBySystem && line.guild.stockpilesBySystem[sys]) || {};
    const req = win.requiredRate === undefined ? '-' : win.requiredRate.toFixed(1);
    const rate = ref.rate === undefined ? '-' : ref.rate.toFixed(2);
    const relief = line.worldEvents && line.worldEvents.length ? '  <-- RELIEF: second titanium mine' : '';
    console.log(
      `${String(line.tick).padStart(4)} `
      + `| ${String(ti.fresh ?? '-').padStart(8)} `
      + `| send ${String(win.sendThisTick ?? '-')} / req ${String(req).padStart(3)}   `
      + `| ${String(win.delivered ?? '-').padStart(3)}/${String(win.Q ?? '-').padStart(2)}  ${String(win.status ?? '-').padEnd(8)}`
      + `| rate ${String(rate).padStart(4)} · minted ${String(ref.minted ?? '-')}   `
      + `| ${String(pool.titanium ?? 0).padStart(10)} `
      + `| ${String(pool.titanium_alloy ?? 0).padStart(4)}${relief}`,
    );
  }
}
