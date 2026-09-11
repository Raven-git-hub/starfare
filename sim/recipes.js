'use strict';

// recipes.js — the canonical recipe catalog: the fixed set of conversions a
// factory venture may run — raw->processed refines (Tier 2) AND, as of 2.1a, the
// 25 processed->module manufactures (Tier 3, docs/asset-recipes.md). Where
// resources.js is the one source of truth for "what goods exist," this is the one
// source for "what conversions exist." A venture names a `recipeId` and the engine
// looks it up here — a caller can NOT invent an arbitrary conversion (no turning 3
// titanium into 1000 gold), exactly as a mining venture can't mine a good a node
// doesn't hold. The engine is tier-blind: a module manufacture is resolved by the
// same batch/throttle path as a refine, so no new mechanism is added by the Tier-3
// entries — only catalog data.
//
// A recipe is a BATCH: it consumes `qty` of EACH good in `inputs` and produces
// `output.qty` of `output.good`. A refining venture runs up to its
// `productionRate` batches per tick, throttled by the SCARCEST input — the
// fewest batches any single input can afford (tick.js's production step). Every
// input good and the output must be a legal stockpile good (resources.js) — a
// drift-style test asserts that, so a recipe can't reference a good that
// doesn't exist. `inputs` is an ARRAY, so a recipe may require several goods.
//
// [PLACEHOLDER] ratios: EVERY quantity below is provisional and unbalanced —
// they exist so each recipe FUNCTIONS and can be tested, NOT because they're
// tuned. Real numbers get set through the live recipe editor (next slice) and
// then baked back into this file. The catalog SHAPE — a fixed, id-addressed set
// of multi-input batches, one per processed good — is the settled part; the
// numbers are the open part. New recipes seed at all-1s; titanium_alloy keeps
// its earlier 3:1 titanium cut. The input SETS come from the design list
// (04-08-26), which deliberately keeps process gases (helium/xenon/nitrogen) as
// manufacturing consumables, not just structural inputs.

// recipe(id, inputs, outputGood, outputQty) -> a frozen recipe.
// `inputs` is a list of [good, qty] pairs, kept as a compact table below so the
// whole catalog can be read at a glance. Everything is frozen so a recipe can
// never be mutated at runtime (determinism, invariant 9).
function recipe(id, inputs, outputGood, outputQty) {
  return Object.freeze({
    id,
    inputs: Object.freeze(inputs.map(([good, qty]) => Object.freeze({ good, qty }))),
    output: Object.freeze({ good: outputGood, qty: outputQty }),
  });
}

const RECIPES = Object.freeze({
  //        id                     inputs: [[good, qty], ...]                                          -> output good           qty
  battery_cells:        recipe('battery_cells',        [['lithium', 1], ['polymers', 1], ['nitrogen', 1]],               'battery_cells', 1),
  carbon_fiber_weave:   recipe('carbon_fiber_weave',   [['carbon_products', 1], ['polymers', 1]],                        'carbon_fiber_weave', 1),
  composite_resin:      recipe('composite_resin',      [['polymers', 1], ['nitrogen', 1]],                               'composite_resin', 1),
  conductive_material:  recipe('conductive_material',  [['copper', 1], ['silica', 1]],                                   'conductive_material', 1),
  heat_resistant_alloy: recipe('heat_resistant_alloy', [['tungsten', 1], ['helium', 1], ['carbon_products', 1]],         'heat_resistant_alloy', 1),
  luminite_glass:       recipe('luminite_glass',       [['silica', 2], ['carbon_products', 1], ['xenon', 1]],            'luminite_glass', 1),
  magnetic_assemblies:  recipe('magnetic_assemblies',  [['neodymium', 1], ['xenon', 1], ['gold', 1], ['lithium', 1]],    'magnetic_assemblies', 1),
  nanotube_cable:       recipe('nanotube_cable',       [['carbon_products', 1], ['nitrogen', 1], ['silica', 1]],         'nanotube_cable', 1),
  radiation_shielding:  recipe('radiation_shielding',  [['lead', 1], ['titanium', 1], ['xenon', 1]],                     'radiation_shielding', 1),
  refrigerant_fluid:    recipe('refrigerant_fluid',    [['ammonia', 1], ['nitrogen', 1]],                                'refrigerant_fluid', 1),
  silicon_wafer:        recipe('silicon_wafer',        [['silica', 1], ['silver', 1], ['palladium', 1]],                 'silicon_wafer', 1),
  titanium_alloy:       recipe('titanium_alloy',       [['titanium', 3], ['carbon_products', 1]],                        'titanium_alloy', 1),

  // --- Tier 3: the 25 module manufacture recipes (2->3), docs/asset-recipes.md ---
  // Each outputs 1 module; inputs are Tier-2 processed goods and/or `luminite_glass`
  // (and raw `tungsten` where the spec lists it). Every quantity is [FIRST-CUT] from
  // the asset-recipes spec — copied, not tuned (docs/phase-1-tuning.md). The engine is
  // tier-blind: a factory runs one of these exactly as it runs a raw->processed refine,
  // throttled by its scarcest input. Alphabetical by module id, like the group above.
  cargo_handling_system:  recipe('cargo_handling_system',  [['magnetic_assemblies', 2], ['nanotube_cable', 2], ['conductive_material', 2], ['titanium_alloy', 1]],                          'cargo_handling_system', 1),
  cargo_module:           recipe('cargo_module',           [['nanotube_cable', 2], ['carbon_fiber_weave', 2], ['magnetic_assemblies', 1], ['titanium_alloy', 1]],                            'cargo_module', 1),
  chassis:                recipe('chassis',                [['titanium_alloy', 3], ['carbon_fiber_weave', 2], ['composite_resin', 2], ['nanotube_cable', 1]],                                'chassis', 1),
  claim_beacon:           recipe('claim_beacon',           [['conductive_material', 2], ['magnetic_assemblies', 2], ['battery_cells', 2], ['radiation_shielding', 1]],                       'claim_beacon', 1),
  comms_array:            recipe('comms_array',            [['magnetic_assemblies', 2], ['conductive_material', 2], ['silicon_wafer', 1]],                                                   'comms_array', 1),
  control_module:         recipe('control_module',         [['silicon_wafer', 2], ['conductive_material', 2], ['battery_cells', 1], ['luminite_glass', 1]],                                  'control_module', 1),
  deep_scan_mast:         recipe('deep_scan_mast',         [['silicon_wafer', 4], ['magnetic_assemblies', 2], ['luminite_glass', 2], ['refrigerant_fluid', 2], ['conductive_material', 2]],  'deep_scan_mast', 1),
  defence_system:         recipe('defence_system',         [['magnetic_assemblies', 3], ['radiation_shielding', 2], ['heat_resistant_alloy', 2], ['conductive_material', 1]],                'defence_system', 1),
  drive_module:           recipe('drive_module',           [['magnetic_assemblies', 2], ['conductive_material', 2], ['heat_resistant_alloy', 1]],                                            'drive_module', 1),
  droid_components:       recipe('droid_components',       [['titanium_alloy', 2], ['carbon_fiber_weave', 1], ['composite_resin', 1], ['magnetic_assemblies', 1]],                           'droid_components', 1),
  extraction_head:        recipe('extraction_head',        [['tungsten', 3], ['titanium_alloy', 2], ['heat_resistant_alloy', 2], ['magnetic_assemblies', 1]],                                'extraction_head', 1),
  fabrication_line:       recipe('fabrication_line',       [['heat_resistant_alloy', 3], ['magnetic_assemblies', 2], ['radiation_shielding', 2], ['refrigerant_fluid', 2], ['conductive_material', 2]], 'fabrication_line', 1),
  fuel_tank:              recipe('fuel_tank',              [['radiation_shielding', 2], ['refrigerant_fluid', 2], ['titanium_alloy', 2]],                                                    'fuel_tank', 1),
  habitation_module:      recipe('habitation_module',      [['composite_resin', 3], ['carbon_fiber_weave', 2], ['luminite_glass', 2], ['refrigerant_fluid', 1]],                             'habitation_module', 1),
  heavy_reactor_engine:   recipe('heavy_reactor_engine',   [['heat_resistant_alloy', 4], ['magnetic_assemblies', 5], ['conductive_material', 4], ['titanium_alloy', 3], ['tungsten', 2]],    'heavy_reactor_engine', 1),
  hull_plating:           recipe('hull_plating',           [['titanium_alloy', 3], ['radiation_shielding', 2], ['heat_resistant_alloy', 1]],                                                 'hull_plating', 1),
  interdiction_projector: recipe('interdiction_projector', [['magnetic_assemblies', 4], ['battery_cells', 2], ['radiation_shielding', 2], ['conductive_material', 2]],                       'interdiction_projector', 1),
  life_support_module:    recipe('life_support_module',    [['composite_resin', 2], ['refrigerant_fluid', 2], ['battery_cells', 1], ['conductive_material', 1]],                             'life_support_module', 1),
  medium_reactor_engine:  recipe('medium_reactor_engine',  [['heat_resistant_alloy', 3], ['magnetic_assemblies', 3], ['conductive_material', 3], ['titanium_alloy', 2]],                     'medium_reactor_engine', 1),
  photovoltaic_array:     recipe('photovoltaic_array',     [['silicon_wafer', 3], ['conductive_material', 2], ['composite_resin', 1]],                                                       'photovoltaic_array', 1),
  power_cells:            recipe('power_cells',            [['battery_cells', 3], ['conductive_material', 2], ['composite_resin', 1]],                                                       'power_cells', 1),
  reactor_housing:        recipe('reactor_housing',        [['radiation_shielding', 3], ['titanium_alloy', 2], ['tungsten', 2], ['heat_resistant_alloy', 2]],                                'reactor_housing', 1),
  sensor_suite:           recipe('sensor_suite',           [['silicon_wafer', 2], ['luminite_glass', 2], ['magnetic_assemblies', 1], ['conductive_material', 1]],                            'sensor_suite', 1),
  small_reactor_engine:   recipe('small_reactor_engine',   [['heat_resistant_alloy', 2], ['magnetic_assemblies', 2], ['conductive_material', 2], ['titanium_alloy', 1]],                     'small_reactor_engine', 1),
  stealth_module:         recipe('stealth_module',         [['radiation_shielding', 3], ['refrigerant_fluid', 3], ['magnetic_assemblies', 2], ['silicon_wafer', 1]],                         'stealth_module', 1),
});

// getRecipe(id) -> the recipe, or null if no such recipe exists. The
// referential-integrity check a dangling recipeId fails (the occupancy invariant
// uses this the way it uses getSite for a siteId).
function getRecipe(id) {
  return Object.prototype.hasOwnProperty.call(RECIPES, id) ? RECIPES[id] : null;
}

// listRecipes() -> every recipe, for a UI recipe-picker or a scenario.
function listRecipes() {
  return Object.values(RECIPES);
}

module.exports = { RECIPES, getRecipe, listRecipes };
