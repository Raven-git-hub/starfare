# Asset Recipes — the Tier-3 module catalog & Tier-4 asset bills

**Design-ahead, 11-09-26 (the reserved 2.1 asset-economy / build-yard thread).**
The repo wins over this file. This is the settled output of the ship/asset recipe
design session: the vocabulary and the input **sets** are the decided part; every
**quantity** is `[FIRST-CUT]` (see `docs/phase-1-tuning.md`) and will be retuned
after physical tests. Nothing here is built yet — this is the spec the 2.1a
catalog engine slice and the 2.1b build yard read.

## The grammar: parts → modules → assets

The manufacturing tree stays exactly four tiers (design.md §15.2), fitting the
tier-general factory engine (three modes: refine 1→2, manufacture 2→3, construct
3→4) with **no new mechanism**:

- **Tier 3 = modules.** Each module is a tradable stockpile good, manufactured in
  **one** 2→3 step from Tier-2 processed goods (never a module-inside-a-module —
  that would be a fifth step). A module is the mid-tier market good a guild can
  specialise in: a Power-Cells maker sells to shipwrights and factory-builders
  alike.
- **Tier 4 = assets.** Each asset is **constructed (3→4) from 4–8 modules**. This
  is the one step whose output is not a stockpile good but an asset / Vehicle
  entity (the reserve-and-wait build yard, 2.1b). Tier 4 is deliberately the
  widest recipe in the game — the convergence tier.

**Construction is a discrete project, not a continuous line.** A Tier-4 build
reserves its whole bill, waits, and emits one finished asset (2.1b: single-slot
FIFO, reserve-and-wait). This is what lets the bills be rich — a wide bill is fun
logistics rather than a line that is perpetually starved on one of fifteen inputs
under the `min`-across-inputs resolver.

**Two load-bearing splits fall straight out of the bills:**

- **Power.** Ships carry a `*_reactor_engine` (integrated deuterium core + drive)
  + `fuel_tank`; ground/installation assets carry a `photovoltaic_array` and no
  fuel tank. Movement burns fuel (the space-folding engines); sitting at a site
  does not — the reactor's own trickle is beneath notice, so a `reactor_housing`
  on an installation is just its containment shell, not a fuel sink. This keeps
  §3's fuel-is-for-movement feel without a §3 revision.
- **Mobility.** Ships move on their reactor engine; **droids** move on an electric
  `drive_module` (no fuel), mirroring the power split.

**Differentiation is by new component TYPE, not just bigger numbers** (design.md
§4): up the hauler ladder each class swaps in a bigger reactor engine AND gains a
new capability module — Medium gains sensors, Heavy gains cargo + armour, and the
Spy branches off with stealth as its signature.

**Weapons do not feature in the game.** `defence_system` is the only protective
part — hardened point-defence, not an offensive arsenal. (A future
maintenance-points-style "security points" dial has not had a design pass; nothing
here builds it.)

## New Tier-2 good

The module catalog needs one new processed good (§3's own Tier-2 list is a
"starting shape", so this is in-bounds):

| Tier-2 good | Recipe `[FIRST-CUT]` |
|---|---|
| `luminite_glass` | 2 silica · 1 carbon_products · 1 xenon → 1 |

Transparent carbon-silica armour-glass — optics and viewports (control rooms,
sensors, habitats). This is the "Glass" §3 flagged and never catalogued.

## Tier-3 module catalog (2→3 recipes)

Each module recipe outputs **1** module. All quantities `[FIRST-CUT]`.

| Module | Recipe |
|---|---|
| `chassis` | 3 titanium_alloy · 2 carbon_fiber_weave · 2 composite_resin · 1 nanotube_cable |
| `control_module` | 2 silicon_wafer · 2 conductive_material · 1 battery_cells · 1 luminite_glass |
| `power_cells` | 3 battery_cells · 2 conductive_material · 1 composite_resin |
| `sensor_suite` | 2 silicon_wafer · 2 luminite_glass · 1 magnetic_assemblies · 1 conductive_material |
| `reactor_housing` | 3 radiation_shielding · 2 titanium_alloy · 2 tungsten · 2 heat_resistant_alloy |
| `small_reactor_engine` | 2 heat_resistant_alloy · 2 magnetic_assemblies · 2 conductive_material · 1 titanium_alloy |
| `medium_reactor_engine` | 3 heat_resistant_alloy · 3 magnetic_assemblies · 3 conductive_material · 2 titanium_alloy |
| `heavy_reactor_engine` | 4 heat_resistant_alloy · 5 magnetic_assemblies · 4 conductive_material · 3 titanium_alloy · 2 tungsten |
| `fuel_tank` | 2 radiation_shielding · 2 refrigerant_fluid · 2 titanium_alloy |
| `life_support_module` | 2 composite_resin · 2 refrigerant_fluid · 1 battery_cells · 1 conductive_material |
| `habitation_module` | 3 composite_resin · 2 carbon_fiber_weave · 2 luminite_glass · 1 refrigerant_fluid |
| `photovoltaic_array` | 3 silicon_wafer · 2 conductive_material · 1 composite_resin |
| `cargo_module` | 2 nanotube_cable · 2 carbon_fiber_weave · 1 magnetic_assemblies · 1 titanium_alloy |
| `cargo_handling_system` | 2 magnetic_assemblies · 2 nanotube_cable · 2 conductive_material · 1 titanium_alloy |
| `hull_plating` | 3 titanium_alloy · 2 radiation_shielding · 1 heat_resistant_alloy |
| `stealth_module` | 3 radiation_shielding · 3 refrigerant_fluid · 2 magnetic_assemblies · 1 silicon_wafer |
| `drive_module` | 2 magnetic_assemblies · 2 conductive_material · 1 heat_resistant_alloy |
| `extraction_head` | 3 tungsten · 2 titanium_alloy · 2 heat_resistant_alloy · 1 magnetic_assemblies |
| `fabrication_line` | 3 heat_resistant_alloy · 2 magnetic_assemblies · 2 radiation_shielding · 2 refrigerant_fluid · 2 conductive_material |
| `comms_array` | 2 magnetic_assemblies · 2 conductive_material · 1 silicon_wafer |
| `claim_beacon` | 2 conductive_material · 2 magnetic_assemblies · 2 battery_cells · 1 radiation_shielding |
| `interdiction_projector` | 4 magnetic_assemblies · 2 battery_cells · 2 radiation_shielding · 2 conductive_material |
| `deep_scan_mast` | 4 silicon_wafer · 2 magnetic_assemblies · 2 luminite_glass · 2 refrigerant_fluid · 2 conductive_material |
| `defence_system` | 3 magnetic_assemblies · 2 radiation_shielding · 2 heat_resistant_alloy · 1 conductive_material |
| `droid_components` | 2 titanium_alloy · 1 carbon_fiber_weave · 1 composite_resin · 1 magnetic_assemblies |

These modules **join `STOCKPILE_GOODS`** at build time, retiring the three inert
`*_reactor_engine` placeholders in `resources.js` (which now become real,
sized recipes above).

## Tier-4 asset bills (3→4 recipes) — FINAL *(RULED 27-09-26; supersedes the earlier FINAL table)*

Each recipe outputs **1** asset. These bills are **small and literal** — believable part
lists, not padded to a price %. The %-of-base target is retired (it was a signpost, now
spent). Module **prices** are in `docs/phase-1-tuning.md`; module **production timers** and
the build model are in `docs/tier3-timed-production.md`. **Build time = the dockyard
assembly `BUILD_TICKS`** (parts must all be present first — produced on the timers, or
**bought from the Syndicate**); the times below are those assembly floors.

| Asset | Assembly | Module bill (final) |
|---|---|---|
| **Light transport** | 6 h | 1 chassis · 1 control_module · 1 life_support_module · 1 small_reactor_engine · 2 fuel_tank · 2 power_cells |
| **Miner** | 12 h | 1 extraction_head · 2 chassis · 1 control_module · 1 cargo_handling_system · 1 defence_system · 2 photovoltaic_array · 6 cargo_module · 6 power_cells |
| **Factory** | 16 h | 1 fabrication_line · 2 chassis · 1 control_module · 1 sensor_suite · 1 cargo_handling_system · 3 photovoltaic_array · 8 power_cells |
| **Medium transport** | 16 h | 2 medium_reactor_engine · 2 chassis · 1 control_module · 1 life_support_module · 1 sensor_suite · 2 reactor_housing · 6 fuel_tank · 6 power_cells |
| **Heavy transport** | 7 d | 5 heavy_reactor_engine · 14 chassis · 2 life_support_module · 2 control_module · 2 defence_system · 10 hull_plating · 10 cargo_module · 10 fuel_tank |
| **Spycraft** | 7 d | 1 stealth_module · 1 control_module · 3 sensor_suite · 2 chassis · 1 life_support_module · 2 small_reactor_engine · 6 power_cells *(build-only; not Syndicate-traded)* |
| **Deep Scan Array** | 7 d | 2 deep_scan_mast · 4 sensor_suite · 2 control_module · 2 chassis · 3 comms_array · 6 power_cells |
| **Toll Gate** | 6 d | 4 interdiction_projector · 1 deep_scan_mast · 2 defence_system · 2 chassis · 4 comms_array · 8 power_cells · 8 hull_plating |
| **Outpost** (depot) | 9 d | 20 chassis · 20 cargo_handling_system · 6 control_module · 4 defence_system · 16 photovoltaic_array · 200 cargo_module · 200 hull_plating · 200 power_cells *(bulk — a big, plain station)* |
| **Droid** | — | design-ahead, no entity yet (droid_components, drive_module — unclassified) |

Assembly `BUILD_TICKS`: light/miner/factory/medium/heavy/spy are the existing values
(`sim/asset-recipes.js`); **outpost 9 d, deep scan array 7 d, toll gate 6 d are set here**
(all `[FIRST-CUT]`). The Outpost is a depot (design.md §4): no production, bulk structure +
storage + power; its large counts are correct for a big plain station.

*(**AS-BUILT 27-09-26 — Slice 1 of the Tier-3 economy build (data/pricing only).** All nine
bills are in `sim/asset-recipes.js`, lifted verbatim from the table above, in three catalogs:
`ASSET_BILLS` (miner, factory), `VEHICLE_BILLS` (the four transports) and a new
`INSTALLATION_BILLS` (outpost, deep scan array, toll gate). **The three installation bills are
data only:** none of the three has a build path yet (the outpost entity exists but is placed by
the operator, not built; the deep scan array and toll gate have no entity), so they are
deliberately kept out of `ALL_BILLS` / `BUILDABLE_KINDS` — `assetBill` returns null for them, a
dockyard refuses them and the Syndicate cannot price them. Their kind names (`outpost`,
`deep_scan_array`, `toll_gate`) are spelled once, in `sim/asset-recipes.js`. `BUILD_TICKS` gains
**outpost 12,960 (9 d), deep_scan_array 10,080 (7 d), toll_gate 8,640 (6 d)**, inert until those
kinds are buildable; the other six are unchanged. The load-time Tier-3 tripwire
(`assertBillModulesAreTier3`) covers all three catalogs. `sim/tests/asset-recipes-final.test.js`
reads this table **from this file** and checks every bill part-for-part and every assembly time
against `BUILD_TICKS`, so a drift on either side fails loudly. At rest, every buildable kind's
parts cost × 0.8 stays below its purchase baseline, so a fresh galaxy's Syndicate buy prices are
unchanged (a test pins that). No build or assembly flow moved. The Droid row has no bill in
code.)*

## Reconciliation with design.md §3's eight-part sketch

The eight parts map into modules with no loss: Structural Frames → `chassis`;
Reactor Core Housings → `reactor_housing` (now a sibling module, not an engine
ingredient); Power Storage Units → `power_cells`; Microchips/Sensors →
`sensor_suite`; Computers → folded into `control_module`; Engine Components +
Motors/Generators → `*_reactor_engine` (ships) / `drive_module` (droids) /
`extraction_head` (miners); Life Support Machines → `life_support_module`. The
depth §3 hid (silica → wafer → microchip → computer → ship, five steps) collapses
into one manufacture step per module; breadth now comes from the module COUNT, not
chain depth.

## Failure mode logged on paper (survival rule 7)

`magnetic_assemblies` is the tree's dominant chokepoint — it feeds ~14 of the 25
modules and is itself the expensive Tier-2 good (neodymium + gold + xenon +
lithium). Mostly a feature (cornering rare metals becomes a real supply-chain
weapon — the §3 dream), but a lever to watch: if playtesting shows everything
bottlenecks on it and the tree feels one-dimensional, spread a few counts onto
`conductive_material` (the cheap workhorse). Recorded, not fixed — a tuning-pass
call.
