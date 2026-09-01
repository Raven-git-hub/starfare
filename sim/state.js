'use strict';

// state.js — entity constructors, and createState(scenario): the one-time
// mold that builds tick-0 state. It runs ONCE, at the start of a run — never
// again during play. Every subsequent state comes from tick.js applying
// changes to the state this file built.
//
// WHAT THIS FILE DOES NOT DO: invent game-balance numbers. The walking
// skeleton's actual starting credits, fuel needs, production rates, etc. are
// a SCENARIO (design.md's "widened Phase 1" starting setup) — a separate,
// not-yet-built concern (see sim/README.md's planned scenarios/ folder).
// createState() below just assembles whatever scenario data it is given into
// a valid state object; it never supplies its own numbers. That keeps this
// file honest infrastructure, reusable by every scenario and every test.
//
// Shape produced matches what invariants.js already expects (see the comment
// block at the top of that file) and design.md §15.4 for full entity fields —
// this is a SUBSET of §15.4, just what the walking skeleton needs first.

const { computeGalacticSupply } = require('./supply.js');
const { cloneStockpiles } = require('./stock.js');
const { cloneProfile } = require('./profile.js');
const { cloneWindows } = require('./windows.js');
const { cloneHistory } = require('./history.js');
const { seedPrices } = require('./prices.js');
const { clonePriceHistory } = require('./price-history.js');
const { ASSET_CONDITION_NEW } = require('./assets.js');
const { REFERENCE_FUEL_PRICE } = require('./fuel.js');

// cloneShipments(list) -> a deep-enough copy of the IN-FLIGHT rows. `cargo` is the
// only nested object a shipment carries (§6: no origin, no route, no status), so
// one level of spread is the whole clone.
function cloneShipments(list) {
  return (Array.isArray(list) ? list : []).map((ship) => ({ ...ship, cargo: { ...(ship.cargo || {}) } }));
}

// --- Entity constructors -----------------------------------------------

// Guild (OWNED, design.md §15.4). `ventures` and `vehicles` are nested here
// (rather than separate top-level arrays keyed by ownerGuildId) because
// that's the shape invariants.js already reads (`g.ventures`) — see
// design.md §15.4's note that Venture.ownerGuildId is the same fact seen
// from the other end. Vehicle follows the identical pattern.
function createGuild({
  id,
  name = id,
  isBot = false,
  credits,
  fuelHoard,
  influence = 0,
  incomeRate = 0,
  homeSystemId = null,
  homePlanetId = null,
  foundingEndowment = 0,
  stockpiles = {},
  productionProfile = {},
  syndicateWindows = {},
  productionHistory = {},
  assets = [],
  ventures = [],
  vehicles = [],
}) {
  if (id === undefined) throw new Error('createGuild: id is required');
  if (credits === undefined) throw new Error('createGuild: credits is required');
  if (fuelHoard === undefined) throw new Error('createGuild: fuelHoard is required');

  return {
    id,
    name,
    isBot,
    credits,
    fuelHoard,
    influence,
    incomeRate,
    // Home (design.md §13): the starter system a guild entered on, and its
    // Terran homeworld planet within it. A DENORMALISED pointer for convenience;
    // the OWNERSHIP source of truth is the guild's home claim in state.claims
    // (§15.2). invariants.js asserts the two agree and that the system is really
    // starter-eligible. null until seated — a guild built directly by a test
    // (bypassing the foundGuild action) may legitimately have no home.
    homeSystemId,
    homePlanetId,
    // guildReputation: the guild's Reputation Points — the SUM of its ventures'
    // `venture.reputation` (docs/points-and-reputation.md §2, "guild RP = Σ its
    // ventures' RP"). Signed INTEGER, and non-negativity-EXEMPT like `credits`: a
    // guild in bad standing is a pressure state, not a broken ledger.
    //
    // DENORMALISED, not derived — a decision, not an oversight. §15.2 wants one source
    // of truth and the ventures ARE it; this is the cached sum, kept in step at the one
    // place RP moves (the boundary verdict in sim/tick.js) and GUARDED every tick by
    // `checkGuildReputationSum` (invariants.js), so it can never silently drift from the
    // rows it totals. That is the same discipline `homeSystemId` and `venture.systemId`
    // already run under — a denormalised copy is legal here exactly when an invariant
    // watches it. It is kept STORED rather than derived because deleting the field is
    // not free: it sits on every guild in every save and in every pinned determinism
    // golden, so deriving it would move all of those hashes to buy a purity the tripwire
    // already delivers more cheaply. Written 0 here UNCONDITIONALLY — never omitted the
    // way `venture.reputation` is — for the same reason: the key is already in those
    // goldens, and a guild with no ventures must serialize exactly as it did before.
    guildReputation: 0,
    // foundingEndowment: the one-time reputation a FOUNDING granted this guild
    // (docs/points-and-reputation.md §2.5) — `MEANLINE_K × W_SYS × the systems it held at
    // founding`, which neutralises the home system's bar exactly once so a newborn opens
    // on its line instead of pinned at the issuance floor. A signed INTEGER, and part of
    // the guild's reputation total: `guildReputation == Σ venture.reputation +
    // foundingEndowment`, which `checkGuildReputationSum` asserts every tick.
    //
    // SET ONLY BY THE `foundGuild` APPLY, never here — this constructor has no claims to
    // size it from (the home claim is pushed after the guild is built), and a scenario
    // guild is not "founded" in the sense the endowment is about. It is CARRIED here for
    // one reason, the same one `venture.committedFromTick` records: a scenario or a
    // restored save that HANDS ONE IN must keep it, and without this line it would be
    // silently dropped and the sum tripwire would fire on the next tick.
    //
    // OMITTED when 0, exactly as `venture.reputation` and `assetId` are: every guild not
    // built by `foundGuild` carries no key at all, so all the determinism goldens whose
    // guilds come from `createState` stay byte-identical.
    ...(foundingEndowment !== 0 ? { foundingEndowment } : {}),
    // stockpiles: systemId -> good -> int, the guild's holdings of each RAW
    // resource, SYSTEM-SCOPED per ruling B1 (§15.2) — a separate pool per system
    // it operates in, accessed only via sim/stock.js. Fuel is NOT here — it
    // lives in fuelHoard, tracked by
    // the fuel-conservation law. Empty = holds nothing; keys are added as
    // production deposits goods. Legality of keys/values (known resource,
    // integer, non-negative) is enforced every tick by invariants.js, not here
    // — same division of labour as credits (this file assembles, invariants.js
    // judges). Copied so a caller's object can't alias into state.
    stockpiles: cloneStockpiles(stockpiles),
    // productionProfile: systemId -> { goods, throttles }, the guild's per-system
    // standing policy routing each good through §5's three gates, SYSTEM-SCOPED
    // like stockpiles (ruling B1, §15.2) and accessed only via sim/profile.js.
    // Defaults to {} (sparse: an absent entry means the all-defaults policy, so a
    // guild behaves exactly as today). Copied through cloneProfile so a caller's
    // object can't alias into engine state — the same discipline stockpiles uses.
    // ENGINE-OWNED and, as of this slice, UNREAD by the tick: stored intent only
    // (stepProduction's consumption of it is slice 2a-ii, §15.4).
    productionProfile: cloneProfile(productionProfile),
    // syndicateWindows: systemId -> good -> { windowStart, delivered, sendCarry }, the
    // ENGINE-OWNED per-(system, good) windowed-accrual state (§5 Slice B-i, sim/
    // windows.js) — NOT player-set. Deliberately omitted from the returned object when
    // empty (created LAZILY by applyProduction only for a committed good), so an
    // unlicensed guild's serialized state is byte-identical to pre-Slice-B — the
    // determinism-hash no-op proof. A caller's non-empty seed is deep-copied so it can
    // never alias into engine state (like stockpiles/productionProfile).
    ...(Object.keys(syndicateWindows).length ? { syndicateWindows: cloneWindows(syndicateWindows) } : {}),
    // productionHistory: systemId -> good -> { prod: [...], cons: [...] }, the
    // ENGINE-OWNED per-(system, good) rolling record of the last HISTORY_N ticks'
    // fresh output and downstream draw (sim/history.js) — NOT player-set. It exists so
    // the console's two trend sparklines are ENGINE truth that survives a reload and
    // reads the same for every viewer, instead of a browser buffer that started empty
    // on every page load. Omitted when empty for the same reason syndicateWindows is:
    // it is minted LAZILY by applyProduction, only for a good that actually moved, so
    // a galaxy where nothing is produced carries no key and stays byte-identical.
    ...(Object.keys(productionHistory).length ? { productionHistory: cloneHistory(productionHistory) } : {}),
    lifetimeProduced: {}, // good -> int; monotonic, only ever increases (§13)
    // assets: the guild's ground-asset INVENTORY (design.md §4, 30-08-26) — the
    // Miners and Factories it owns. Nested here, a sibling of `ventures` and
    // `vehicles`, for the same reason they are: ownership is "the guild whose
    // array holds it", so there is exactly one place to look and nothing to keep
    // in sync. An asset in this array is DEPLOYED if one of the guild's own
    // ventures names it in `assetId`, and IDLE otherwise — derived, never stored
    // (sim/assets.js; invariant 5). Deep-copied through createAsset so a caller's
    // object can't alias into engine state, exactly as `ventures` is.
    //
    // OMITTED when empty, like `syndicateWindows` and `productionHistory` above:
    // a guild with no assets — every guild built directly by a test or a scenario,
    // since only the founding grant mints them — carries no key at all and
    // serializes byte-identically to pre-asset state, which is what keeps the
    // determinism goldens meaningful.
    ...(assets.length ? { assets: assets.map(createAsset) } : {}),
    ventures: ventures.map(createVenture),
    vehicles: vehicles.map(createVehicle),
  };
}

// Venture (OWNED, design.md §15.4). Fields not yet needed by the walking
// skeleton (licenceId, droidComplement, shareholders, automation) are left out
// rather than defaulted to a made-up value — add them when a real consumer needs
// them, not speculatively. `reputation` stopped being one of them on 31-08-26
// (RP slice 1, docs/points-and-reputation.md §6 step 1): the window boundary is a
// real consumer, so it is assembled below.
function createVenture({
  id,
  ownerGuildId,
  type,
  siteId = null,
  systemId = null,
  assetId = null,
  resourceType = null,
  recipeId = null,
  productionRate = 0,
  inputStockpiles = {},
  syndicateCommitment = 0,
  equityPct = 0,
  licence = null,
  committedFromTick = null,
  reputation = 0,
  batchCarry = {},
}) {
  if (id === undefined) throw new Error('createVenture: id is required');
  if (ownerGuildId === undefined) throw new Error('createVenture: ownerGuildId is required');
  if (type === undefined) throw new Error('createVenture: type is required');

  return {
    id,
    ownerGuildId,
    type,
    // siteId: the seed site this venture occupies — a resource node (mining) or
    // a settlement slot (refinery/factory/construction). Reference only: it
    // names a place in data/seed.json; the seed is never written back to. null
    // = not seated anywhere yet. Referential integrity (the id resolves to a
    // real site) and one-venture-per-site are enforced every tick by
    // invariants.js, which is also where "a mining venture's resourceType must
    // match its node's" lives — this file assembles, invariants.js judges.
    siteId,
    // systemId: the system the venture's site sits in — a DENORMALISED copy of
    // getSite(siteId).systemId, stamped at establish (actions.js), same pattern
    // as resourceType. It is the pool key production deposits into / draws from
    // (ruling B1: resources are system-scoped, §15.2). Guarded against the site
    // by invariants.js so the denormalised copy can't silently drift. null for a
    // synthetic venture built directly by a test with no seat.
    systemId,
    // assetId: the ground ASSET this venture runs (design.md §4, §15.4) — the
    // machine, as against the operating company around it. NULLABLE BY DESIGN: a
    // venture can outlive its asset (a breakdown, a future swap-out), so null is a
    // real, legal state and `checkAssetOccupancy` deliberately does NOT demand one.
    // It is nonetheless UNREACHABLE at birth in this slice: both real create-paths
    // occupy an idle asset, so every venture the game creates has one —
    // `establishVenture` the one its caller NAMED (31-08-26), a `foundGuild`'s inline
    // ventures one from the starter pool that founding mints. A venture built
    // DIRECTLY by a test may legitimately have none.
    //
    // OMITTED when null, the discipline `equityPct` / `licence` / `committedFromTick`
    // below already follow: a venture with no asset carries no key, so a state built
    // without the founding grant serializes byte-identically to pre-asset state. The
    // field and its default still exist here, so the shape is settled and nothing
    // needs migrating when swap-out and breakdown make null reachable.
    ...(assetId != null ? { assetId } : {}),
    // resourceType: the RAW good a MINING venture extracts. Its output goes to
    // the owner guild's stockpile (tick.js stepProduction). This DRIVES
    // production; the seed node at siteId is the authority it is checked
    // against (see invariants.js). null for ventures that don't mine a single
    // named good (e.g. a future refinery/factory on a settlement slot).
    resourceType,
    // recipeId: for a REFINING venture, the recipes.js recipe it runs (e.g.
    // 'titanium_alloy') — consuming the recipe's input goods from the owner's
    // stockpile and producing its output good, up to `productionRate` batches
    // per tick (tick.js stepProduction). null for a mining venture. A venture is
    // one or the other: a mining venture sets resourceType, a refining venture
    // sets recipeId. invariants.js checks a refining venture sits on a
    // settlement slot and its recipeId resolves.
    recipeId,
    productionRate,
    inputStockpiles: { ...inputStockpiles },
    // syndicateCommitment: a RESERVED PLACEHOLDER (design.md §15.4, §5) for the
    // share of this venture's output promised to the Syndicate under its future
    // licence. 0 = UNLICENSED, which is every venture today: no licence system
    // exists yet (Licence is itself a reserved entity, §15.4), so there is no
    // path that sets this to anything but 0. It is ENGINE-OWNED — defaulted here
    // rather than operator-supplied — precisely so the Production view can read a
    // real field off the venture instead of inventing its own number. Kept an
    // INTEGER (§15.2) so it sums cleanly in the view's totals: it is a per-tick
    // committed QUANTITY of output, not a percentage. NO tick step reads it, so
    // carrying it is a behavioural no-op; it exists to give commitment a home
    // everywhere (rows + totals) before slice 3 gives it a function.
    syndicateCommitment,
    // equityPct: the venture's offered equity share `o` — the cut of its
    // commitment-SALE income forfeited to outside investors, or (with none, which is
    // every venture today) kept by the Syndicate ledger (§5 "Equity offered", the
    // 49% structural ceiling; docs/licence-and-price-system.md Part 2). It is the
    // venture-level placeholder for §15.4's reserved `Licence.equityOfferedPct`,
    // exactly as `syndicateCommitment` is the placeholder for `committedOutputPct`:
    // when the Licence entity lands it becomes the source and these retire. A
    // FRACTION (0–0.49), not a percentage, and the ONE sanctioned non-integer on a
    // venture besides batchCarry — it scales credits, it is not credits (§15.2);
    // the credits it produces are rounded once, in sim/licence.js.
    //
    // OMITTED when 0, exactly as `syndicateCommitment`'s sibling `syndicateWindows`
    // is omitted when empty: a venture that offered no equity carries no key, so an
    // unlicensed galaxy's serialized state stays byte-identical to pre-Slice-3a and
    // the determinism-hash no-op proof still means something. Range is refused at
    // intake (actions.js) and asserted every tick (invariants.js) — this file
    // assembles, they judge.
    ...(equityPct ? { equityPct } : {}),
    // licence: the Syndicate Venture Licence this venture runs under (Slice 3b-i;
    // design.md §5 "LICENCE FEE MECHANICS — RULED", which pins it as an EMBEDDED
    // object on the venture rather than §15.4's earlier separate-entity-by-`licenceId`
    // sketch). Granted by the `applyForLicence` action, never by the operator:
    //
    //   { committedOutputPct,   // the share of BASELINE output promised, a fraction
    //     windowDays,           // §5's renegotiation window, in days — stored, inert
    //                           //   until renegotiation resolves it to a tick
    //     signedTick,           // when the terms were struck (§15.2: record the tick)
    //     lockedPrice,          // the POSTED price at signing — what the fee is
    //                           //   priced off, fixed until renegotiation
    //     basicFee,             // integer credits: the full fee, the maximum payable
    //     discountedFee }       // integer credits: after §5's four-corner grid
    //
    // The two fees are computed ONCE, at signing, and stored — that is what "terms
    // locked at issuance" means, and it is why timing your signature is a real
    // decision. NOTHING IS CHARGED YET: 3b-iii debits one of them at each window
    // boundary. `syndicateCommitment` above is the operative quantity the window
    // machinery reads; this block is the contract that set it.
    //
    // OMITTED when absent, like `equityPct` and `syndicateWindows`: an unlicensed
    // venture carries no `licence` key at all, so an unlicensed galaxy's serialized
    // state is byte-identical to pre-Slice-3b-i. Copied so a caller's object can never
    // alias into engine state.
    ...(licence ? { licence: { ...licence } } : {}),
    // committedFromTick: the venture's FIRST PRODUCING tick under its licence — the
    // term that pro-rates its first window's obligation (§5's Option-A join ruling;
    // Slice 3b-ii, `sim/windows.js` `windowFraction`). Stamped by `applyForLicence` as
    // `signedTick + 1`; carried here so a scenario or a persisted state that HANDS ONE
    // IN keeps it. Without this line it was silently dropped and the venture reverted
    // to owing a full window — the pro-rate quietly undone by a field that assembled
    // fine everywhere else.
    //
    // OMITTED when absent, like `equityPct` and `licence` above, so an unlicensed (and
    // a dev-scaffold-committed) venture carries no key and its serialized state stays
    // byte-identical. `!= null` rather than truthiness on purpose: a 0 is not "absent",
    // it is a tick that does not exist, and it should reach the tick's tripwire rather
    // than be swallowed here (this file assembles, invariants.js judges).
    ...(committedFromTick != null ? { committedFromTick } : {}),
    // reputation: the venture's REPUTATION POINTS — its running contribution score
    // (docs/points-and-reputation.md §2; design.md §5 "Reputation and Hostile Takeovers",
    // which is where "ventures carry a fully visible reputation score" comes from). A
    // SIGNED integer (§15.2), and the sign is the point: it may go NEGATIVE, so it joins
    // `credits` and the Syndicate ledger in invariant 3's carve-out (invariants.js). A
    // venture in bad standing is a pressure state — the band's -500 closure floor is what
    // eventually acts on it (§2.1) — not a broken ledger.
    //
    // NON-CONSERVED, like `influence` and unlike `fuelHoard`: RP is MINTED and DESTROYED
    // by events, so there is no ledger counterpart to balance it against and no
    // conservation law to keep. What IS kept is the guild SUM (`guild.guildReputation`),
    // and `checkGuildReputationSum` asserts it every tick.
    //
    // MOVED BY EXACTLY ONE THING TODAY: the licence's met/breach verdict at the window
    // boundary (sim/tick.js, magnitudes in sim/licence.js). That is invariant 8 —
    // "reputation moves only on measurable events" — held structurally rather than by
    // convention. The other sources §2.4 lists (equity offered, leasing, the outpost
    // deploy offset) are `[DEFERRED]` and deliberately not stubbed.
    //
    // OMITTED when 0, exactly as `equityPct`, `licence` and `committedFromTick` above
    // are: a venture that has never been judged carries no key, so an unlicensed galaxy's
    // serialized state stays byte-identical and the determinism-hash no-op proof keeps
    // meaning something. Minted LAZILY by the first verdict that MOVES it, and kept from
    // then on — the same lifecycle `guild.syndicateWindows` has. Both halves are load-
    // bearing: a venture that climbs and falls back to exactly 0 KEEPS its key (that last
    // step was a real change), while a verdict worth a zero delta — a 0%-commitment
    // licence, a venture pinned at the floor, one at the taper's asymptote — mints
    // nothing, so a key never holds its own default.
    ...(reputation !== 0 ? { reputation } : {}),
    // STILL RESERVED, deliberately not stubbed (Slice 5, §15.4): `shareholders`, the
    // investor cap-table Part 2 asks to reserve. Documented rather than written as an
    // empty object, because an empty object on every venture is not a socket: it is
    // bytes in every save and in the determinism hash for a field nothing reads. The
    // omit-when-default discipline above is what makes adding it additive.
    // batchCarry: the per-good sub-unit carries (§5 rate-based rewrite, corrected
    // 10-08-26 build-review, §15.4). A refinery runs at a CONTINUOUS rate
    // (batches/tick may be fractional), but goods are integers (§15.2). So EVERY
    // good the line touches — each recipe input AND the output — carries its own
    // fractional remainder here, `{ [good]: fraction in [0,1) }`, all paced by the
    // one rate: each tick a good accrues rate × qty, the whole part is drawn (input)
    // or minted (output), the sub-unit part carried on. This is what makes the
    // recipe RATIO hold on average (the earlier output-only carry rounded inputs and
    // broke it). The carries are the sanctioned non-integers, fenced OFF the
    // conserved-goods ledger (units drawn/minted stay integer); a dedicated tick
    // tripwire (invariants.js) asserts every entry in [0, 1). Default {} (a fresh
    // venture has nothing carried). Advanced only by stepProduction (tick.js) — the
    // resolver reads it start-of-step and stays pure.
    batchCarry: { ...batchCarry },
    // NOTE: the old typeless `outputStockpile` scalar was retired in the
    // resource-representation slice (02-08-26). Produced goods are typed and go
    // straight into the owner guild's `stockpiles` — one home, no drift. There
    // is no market or shipping yet, so "produced-but-unsold sits on the
    // venture" carries no behaviour; when selling/shipping needs that state, it
    // returns deliberately. Producer attribution is preserved via the guild's
    // lifetimeProduced counter (§13).
    // §15.2: "every mutation records its tick." null until tick.js's
    // stepProduction first touches this venture -- there's been no
    // mutation to record yet at construction time.
    updatedAtTick: null,
  };
}

// Asset (OWNED, design.md §4 "Ventures and Ground Assets" / "Asset occupancy",
// 30-08-26) — the physical MACHINE a venture runs, as against the venture, which
// is the operating company around it. Exactly two kinds exist: a `miner` (on a
// resource node) and a `factory` (on a settlement slot); sim/assets.js pins the
// vocabulary.
//
// There is NO ownerGuildId and NO `isIdle` on purpose. Ownership is "the guild
// whose `assets` array holds it" (the same fact seen from the other end, §15.4),
// and idleness is DERIVED from whether any venture names it (invariant 5) — a
// stored copy of either could drift from the array that really holds it.
//
// There is also no `updatedAtTick`: §15.2's "every mutation records its tick"
// is followed HERE the way its siblings follow it — a venture stamps one because
// stepProduction mutates it every tick; nothing in this slice ever mutates an
// asset, so a stamp would be a field with nothing to record. It arrives with the
// mutation that needs it (decay, in the maintenance slice).
function createAsset({ id, kind, maintenanceCondition = ASSET_CONDITION_NEW }) {
  if (id === undefined) throw new Error('createAsset: id is required');
  if (kind === undefined) throw new Error('createAsset: kind is required');
  return {
    id,
    kind,
    // maintenanceCondition — a fraction, 1 = new/full, 0 = stopped (sim/assets.js
    // owns the constant and the scale). DESIGN-AHEAD AND INERT: nothing in this
    // slice reads it, nothing changes it, and it never reaches production. It is
    // carried and serialized now so the maintenance slice needs no migration.
    maintenanceCondition,
  };
}

// Vehicle (OWNED, design.md §15.4): "id, ownerGuildId, class, speed/capacity/
// defenseRating/fuelCostToRun, status." Only ONE class exists so far —
// `lightTransport` (design.md §4's simplest ship, no sensors/weapons) — so
// that's the default; anything else is a later addition, not invented here.
//
// speed/capacity/defenseRating/fuelCostToRun are REQUIRED, not defaulted —
// same discipline as createGuild's credits/fuelHoard. None of these numbers
// has a decided value anywhere in docs/phase-1-tuning.md yet; defaulting
// them to something plausible would be inventing a game-balance number
// silently (working practice #5). The caller must supply real numbers.
function createVehicle({
  id,
  ownerGuildId,
  class: vehicleClass = 'lightTransport',
  speed,
  capacity,
  defenseRating,
  fuelCostToRun,
  status = 'idle',
}) {
  if (id === undefined) throw new Error('createVehicle: id is required');
  if (ownerGuildId === undefined) throw new Error('createVehicle: ownerGuildId is required');
  if (speed === undefined) throw new Error('createVehicle: speed is required');
  if (capacity === undefined) throw new Error('createVehicle: capacity is required');
  if (defenseRating === undefined) throw new Error('createVehicle: defenseRating is required');
  if (fuelCostToRun === undefined) throw new Error('createVehicle: fuelCostToRun is required');

  return {
    id,
    ownerGuildId,
    class: vehicleClass,
    speed,
    capacity,
    defenseRating,
    fuelCostToRun,
    status,
    // §15.2: "every mutation records its tick." null until something (a
    // future consumption/movement step) first touches this vehicle.
    updatedAtTick: null,
  };
}

// Fuel Utility reserve (SHARED, design.md §15.4) — the subset the engine needs.
// `priceBand`/etc. are still left out until something reads them.
//
// `fuelPrice` — THE ONE MARKET PRICE of `deuterium_fuel`, in credits per unit
// (docs/fuel-supply-and-allocation.md §4.2, slice 5b-i). Real, serialized state, not
// a derivation: 5b-ii's reserve/flow controller sets NEXT cycle's price from THIS
// cycle's reserve and flows, so it has to survive from one cycle to the next. It is
// the sanctioned NON-INTEGER (§15.2) — it scales a quantity rather than counting one,
// exactly as the issuance modifier does — and invariants.js checks it as a float ≥ 0.
//
// ⚠ IT DEFAULTS, WHERE `reserveLevel` IS REQUIRED, and the difference is deliberate.
// A pool level is a galaxy-scale quantity that only a scenario can know, so leaving it
// out is a mistake worth throwing on. A price is STRUCTURAL: there is exactly one
// sensible opening value — `REFERENCE_FUEL_PRICE`, the calibration anchor itself
// (sim/fuel.js) — so a reserve created without one sits at the reference, which is
// also what 5b-i holds it at. That keeps every existing caller (the zero-state and
// every fixture, all of which pass `{ reserveLevel }` alone) valid and unchanged.
function createReserve({ reserveLevel, fuelPrice = REFERENCE_FUEL_PRICE }) {
  if (reserveLevel === undefined) throw new Error('createReserve: reserveLevel is required');
  return { reserveLevel, fuelPrice };
}

// The Syndicate's credit-conservation balancing account (design.md invariant
// 2). May be negative — see invariants.js's non-negativity exemption for it.
function createSyndicate({ ledger }) {
  if (ledger === undefined) throw new Error('createSyndicate: ledger is required');
  return { ledger };
}

// --- Assembly -------------------------------------------------------------

// Sum every guild's fuelHoard.
function sumFuelHoards(guilds) {
  return guilds.reduce((sum, g) => sum + g.fuelHoard, 0);
}

// Sum every guild's credits.
function sumCredits(guilds) {
  return guilds.reduce((sum, g) => sum + g.credits, 0);
}

// createState(scenario) — the one-time bootstrap.
//
// scenario shape:
//   {
//     guilds:    [ <args to createGuild>, ... ],
//     reserve:   <args to createReserve>,
//     syndicate: <args to createSyndicate>,
//   }
//
// Returns a full tick-0 state, including a freshly-computed `audit` block —
// NOT supplied by the scenario, because the audit totals must always equal
// whatever the assembled state actually contains (invariants.js checks the
// live totals against them). At tick 0, before any production or trade has
// happened: everything currently held (hoards + reserve) is the "total
// produced so far" and nothing has been consumed yet; the sanctioned credit
// total is just what guilds and the ledger currently hold, since nothing has
// moved yet either. Computing this here, rather than trusting the scenario to
// get it right by hand, is what makes createState's OUTPUT always pass the
// invariants immediately — regardless of what numbers the scenario contains.
function createState(scenario) {
  if (!scenario) throw new Error('createState: scenario is required');
  if (!Array.isArray(scenario.guilds)) {
    throw new Error('createState: scenario.guilds must be an array');
  }
  // NOTE: an EMPTY roster is legal -- it is the guild-less zero-state a fresh
  // server boots into and waits in until the owner founds the first guild
  // (scenarios/zero-state.js, actions.js foundGuild).

  const guilds = scenario.guilds.map(createGuild);
  const reserve = createReserve(scenario.reserve);
  const syndicate = createSyndicate(scenario.syndicate);

  const state = {
    tick: 0,
    guilds,
    reserve,
    syndicate,
    // windowN: the single engine-wide Syndicate-accrual window length in ticks (§5
    // Slice B-i). Present ONLY when the scenario sets it — a scenario with no
    // commitments needs no window, so omitting it keeps an unlicensed run's serialized
    // state byte-identical to pre-Slice-B (the resolver defaults it via the flagged
    // [FIRST-CUT] in sim/windows.js when a committed good is nonetheless resolved).
    ...(scenario.windowN === undefined ? {} : { windowN: scenario.windowN }),
    // dayAnchorTick: the per-galaxy offset that lines cycle boundaries up with SERVER
    // MIDNIGHT (docs/cycle-and-calendar.md §2). The boundary is
    // `(tick - dayAnchorTick) % N == 0`, so at the default 0 it is exactly the old
    // `tick % N == 0`. Present ONLY when the scenario sets it — same omit-when-absent
    // discipline as `windowN` above, and for the same reason: a state with no anchor
    // serializes byte-identically to pre-anchor, which is the determinism no-op guard
    // (invariant 9). Every reader defaults it with `== null ? 0`.
    //
    // It is FROZEN: set exactly once, from a single wall-clock read at galaxy creation
    // (sim/server.js), then persisted and never recomputed. Downtime does NOT re-anchor
    // (§3 — cycles stay exactly N ticks, drift is accepted); re-anchoring is a manual
    // future operator action. This is the only field in state derived from a clock, and
    // nothing on the tick path ever reads one.
    ...(scenario.dayAnchorTick === undefined ? {} : { dayAnchorTick: scenario.dayAnchorTick }),
    // utcOffsetMinutes: WHICH midnight the anchor above lines up with — the galaxy's
    // own UTC offset in minutes (docs/cycle-and-calendar.md §2), chosen once at
    // creation and defaulting to 0 = UTC. An integer in [-720, 840] (UTC-12:00 ..
    // UTC+14:00); a FIXED offset, never a named zone, so it does not follow daylight
    // saving. Present ONLY when the scenario sets it — same omit-when-absent
    // discipline as `dayAnchorTick` above, and for the same reason: an unconfigured
    // galaxy serializes byte-identically to pre-offset. Readers default it `== null ? 0`.
    //
    // It is FROZEN and persisted with the galaxy, exactly like the anchor: the tick
    // path never reads it (it is a DISPLAY and CREATION-TIME field, not an economy
    // one), and changing the offset affects only galaxies created afterwards (§3 —
    // re-anchoring an existing galaxy stays a manual future action).
    ...(scenario.utcOffsetMinutes === undefined ? {} : { utcOffsetMinutes: scenario.utcOffsetMinutes }),
    // world is an opaque reference the engine carries inert (tick/intake/assert
    // read none of it). The zero-state now sets it to { seed: <number> } — the
    // galaxy IS the seed (§15.3), referenced, not copied — replacing the old
    // placeholder node graph. A test may pass any shape or none. Real hex
    // geography stays Phase 4 (§2, §15.4). claims (SHARED territory rows) DO
    // carry weight: they reference real seed landmarks, guarded by invariants.js.
    world: scenario.world || {},
    claims: Array.isArray(scenario.claims) ? scenario.claims : [],
    // IN-FLIGHT (§15.1). Today's only occupant is the Syndicate BUY delivery
    // (design.md §6): `{ ownerGuildId, cargo, destinationSystemId, arrivalTick }`
    // — a pure schedule, deposited by tick.js's stepArrivals on its absolute
    // arrival tick. ALWAYS PRESENT, even empty: the field has been in every state
    // (and so in every committed golden hash) since the walking skeleton, so
    // emitting it unconditionally is what keeps a galaxy with no deliveries
    // byte-identical — omitting it when empty would move every one of those
    // hashes. Deep-cloned when a scenario or a restored save supplies one, so a
    // caller's array can never alias into engine state (the cloneStockpiles
    // discipline).
    shipments: cloneShipments(scenario.shipments),
    // prices: the Syndicate value per non-fuel good (docs/licence-and-price-system.md
    // Part 1; sim/prices.js owns the shape and the formula). Seeded here at every
    // good's [FIRST-CUT] base price so a fresh galaxy already posts a value, and
    // recomputed every tick by step 3. It is SERIALIZED state — it joins the save and
    // the determinism hash — because the EMA memory and the publish pipeline are real
    // memory the next tick reads, not derived telemetry that could be recomputed. Fuel
    // is never listed (design.md §8): `deuterium_fuel` has no row here, ever. Computed
    // rather than accepted from the scenario, like `audit` and `galacticSupply` below.
    prices: seedPrices(),
    // priceHistory: the rolling per-good rings of PAST posted values
    // (sim/price-history.js) — the graph's data, top-level beside `prices` because
    // the posted price is galaxy-wide, not a guild's. OMITTED when there is none,
    // exactly like `dayAnchorTick` above and for the same reason: a fresh galaxy has
    // no history (the first sample lands when the fine bucket closes at tick 15), so
    // it serializes byte-identically to pre-slice state. Deep-cloned when a scenario
    // or a restored save supplies one, so a caller's object can never alias into
    // engine state (the cloneStockpiles/cloneHistory discipline).
    ...(scenario.priceHistory === undefined
      ? {}
      : { priceHistory: clonePriceHistory(scenario.priceHistory) }),
    audit: {
      totalProduced: sumFuelHoards(guilds) + reserve.reserveLevel,
      totalConsumed: 0,
      expectedCreditTotal: sumCredits(guilds) + syndicate.ledger,
    },
    // Derived galactic-supply totals (the "resources section"). A CACHE for the
    // viewer/telemetry, re-derived and asserted every tick by invariants.js so
    // it can never silently drift from the guilds' actual stockpiles. Computed
    // here (not trusted from the scenario) so createState's output always
    // matches what it assembled — same discipline as `audit` above.
    galacticSupply: null, // set just below, once `state` is assembled
  };

  state.galacticSupply = computeGalacticSupply(state);

  return state;
}

module.exports = {
  createGuild,
  createVenture,
  createAsset,
  createVehicle,
  createReserve,
  createSyndicate,
  createState,
};
