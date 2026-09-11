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

## Tier-4 asset bills (3→4 recipes)

Each asset recipe outputs **1** asset. All quantities `[FIRST-CUT]`.
`buildable` = ground-asset yard output this thread; the rest are design-ahead
(ships need 2.1/2.3 usability rulings; installations are blocked on 2.2/2.5).

| Asset | Module bill | Status |
|---|---|---|
| **Light transport** | chassis · small_reactor_engine · fuel_tank · power_cells · control_module · life_support_module | ship (design-ahead) |
| **Medium transport** | 2 chassis · medium_reactor_engine · reactor_housing · 2 fuel_tank · power_cells · control_module · 2 life_support_module · sensor_suite | ship (design-ahead) |
| **Heavy transport** | 3 chassis · heavy_reactor_engine · reactor_housing · 2 fuel_tank · power_cells · control_module · 2 life_support_module · sensor_suite · 2 cargo_module · cargo_handling_system · 2 hull_plating · defence_system | ship (design-ahead) |
| **Spy / spycraft** | chassis · small_reactor_engine · 2 fuel_tank · 2 power_cells · control_module · life_support_module · 2 sensor_suite · stealth_module | ship (design-ahead) |
| **Miner** | 2 chassis · reactor_housing · photovoltaic_array · power_cells · control_module · extraction_head · cargo_module · cargo_handling_system · defence_system | **buildable** |
| **Factory** | 3 chassis · reactor_housing · 2 photovoltaic_array · 2 power_cells · control_module · 2 fabrication_line · sensor_suite · cargo_handling_system · defence_system | **buildable** |
| **Outpost** (depot) | chassis · reactor_housing · photovoltaic_array · power_cells · control_module · claim_beacon · habitation_module · life_support_module · cargo_module · cargo_handling_system · defence_system | design-ahead |
| **Deep Scan Array** | chassis · reactor_housing · photovoltaic_array · 2 power_cells · control_module · 2 deep_scan_mast · comms_array · 2 habitation_module · 2 life_support_module · defence_system | design-ahead |
| **Toll Gate** | 2 chassis · reactor_housing · photovoltaic_array · 2 power_cells · control_module · sensor_suite · interdiction_projector · comms_array · defence_system | design-ahead |
| **Droid** | droid_components · control_module · sensor_suite · drive_module · power_cells | design-ahead (no entity yet) |

**The Outpost is a depot, not a factory** (refines design.md §4): no production
function, but a **limited depot capacity** — a manned drop-off/pickup node that
makes outside trade less fuel-intensive by shortening hauls. Hence its habitation,
life support, cargo handling, and defence. §4's "no production; flag on a stick"
line narrows to "no production; limited depot capacity."

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
