'use strict';

// rebanded-goods-strip.js — the STRIP-AND-PROVE helper for the Tier-3 RE-BANDS (the same discipline as
// deep-scan-lane-strip.js and control-map-strip.js).
//
// A re-band gives a Tier-3 module that had none its ruled sub-tier (docs/phase-1-tuning.md "Tier-3 sub-tiers").
// Two have happened, each moving ONLY the goods it placed:
//   - 16-10-26, the Prefecture / claims slice (roadmap 2.5): claim_beacon → 3-2, habitation_module → 3-3, because
//     the Prefecture bill is the first to use them;
//   - 02-11-26, droid engine slice 1 (roadmap 2.6; docs/droids.md §11): drive_module → 3-2, droid_components → 3-2,
//     the droid bill's two parts.
// A re-band moves the good's seeded price rows — the posted price, the price history, the quote ring, and the
// snapshot's price fields — and, the good being newly TIMED, adds it to the snapshot's `tier3Contract`. Every one
// of those bytes sits under a key named for the good.
//
// So the two strips take those goods back out — every object key named for one, at any depth — and the rest of
// the bytes can be compared with a commit from before the re-band:
//   - withoutRebandedGoods(x)     — ALL FOUR goods, to compare with 79807db (the commit before either re-band);
//   - withoutDroidRebandGoods(x)  — ONLY the droid pair, to compare with 4bf6cbb (the commit before the droid one).
// Each keeps every other key in its order, so a JSON byte comparison stays meaningful too.
//
// Each REFUSES to be vacuous: a strip that did not find EVERY good it names took nothing (or not everything) away,
// and would prove nothing about the goods it missed — so it throws, naming them. (⤳ 02-11-26: it used to ask for
// at least one key; asking for each good is the stricter check, and every state and snapshot carries all four.)
//
// It uses only plain JavaScript, so it runs unchanged on a checkout of either old commit — which is how the
// digests the delta test pins were recorded.

const PREFECTURE_REBAND_GOODS = Object.freeze(['claim_beacon', 'habitation_module']); // 16-10-26
const DROID_REBAND_GOODS = Object.freeze(['drive_module', 'droid_components']);       // 02-11-26
const REBANDED_GOODS = Object.freeze([...PREFECTURE_REBAND_GOODS, ...DROID_REBAND_GOODS]);

// withoutGoods(value, goods) -> a COPY of `value` with every object key named in `goods` deleted, at any depth.
// Throws if any of `goods` was not found.
function withoutGoods(value, goods) {
  const found = new Set();
  const strip = (v) => {
    if (v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map(strip);
    const out = {};
    for (const k of Object.keys(v)) {
      if (goods.includes(k)) { found.add(k); continue; }
      out[k] = strip(v[k]);
    }
    return out;
  };
  const out = strip(value);
  const missing = goods.filter((good) => !found.has(good));
  if (missing.length > 0) {
    throw new Error(`rebanded-goods-strip: no ${missing.join(' / ')} key to strip — the strip would prove nothing`);
  }
  return out;
}

const withoutRebandedGoods = (value) => withoutGoods(value, REBANDED_GOODS);
const withoutDroidRebandGoods = (value) => withoutGoods(value, DROID_REBAND_GOODS);

module.exports = {
  withoutRebandedGoods, withoutDroidRebandGoods,
  REBANDED_GOODS, PREFECTURE_REBAND_GOODS, DROID_REBAND_GOODS,
};
