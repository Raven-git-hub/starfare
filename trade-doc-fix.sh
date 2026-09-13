#!/usr/bin/env bash
set -euo pipefail
# Starfare doc correction: player-allocated per-system SELL + BUY ruling.
# Run from the repo root: gitserver@gitserver:/mnt/git-server/starfare
# Requires HEAD to contain the earlier "Guild-wide" ruling (commit 8879f42). Does NOT push.
test -f docs/design.md || { echo "!! run me from the starfare repo root"; exit 1; }

# ---- 1. overwrite the mockup with the per-system version ----
cat > docs/mockups/trade-panel.html <<'STARFARE_TRADE_MOCKUP_EOF'
<title>Syndicate Trade</title>
<!-- DESIGN MOCKUP - the visual + interaction contract for the TRADE tab (docs/mockups). Not shipped as-is; the game renders this shape inside client/game.html's market tab, reading the live snapshot. Trader art = client/assets/mission/Trader.jpg. -->
<style>
  @import url('https://fonts.googleapis.com/css2?family=Cinzel:wght@500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap');

  :root{
    --void:#0d0f14; --panel:#14171e; --panel2:#181c24; --panel3:#1c212b;
    --ink:#E8DFC8; --ink2:#b7b09a; --ink3:#6f7687; --ink4:#454b58;
    --amber:#C9A227; --amber2:#e3c04a; --amber-dim:rgba(201,162,39,.30);
    --line:rgba(232,223,200,.10); --line2:rgba(232,223,200,.18);
    --up:#5fb98a; --down:#e0796b;
    --mono:'IBM Plex Mono',ui-monospace,'SF Mono',monospace;
    --serif:'Cinzel',Georgia,serif;
    --hero:236px;
    --thero:472px;
    --trader:url("../../client/assets/mission/Trader.jpg");
  }
  *{box-sizing:border-box}
  body{margin:0; background:
      radial-gradient(120% 80% at 80% -10%, rgba(201,162,39,.06), transparent 60%),
      var(--void);
    color:var(--ink); font-family:var(--mono); font-size:14px; line-height:1.45;
    -webkit-font-smoothing:antialiased; padding:22px; min-height:100vh;}
  .wrap{max-width:1440px; margin:0 auto;}

  .mast{display:flex; align-items:baseline; justify-content:space-between; padding-bottom:14px; border-bottom:1px solid var(--line);}
  .mast .brand{font-family:var(--serif); font-weight:600; letter-spacing:.14em; font-size:13px; color:var(--ink2); text-transform:uppercase;}
  .mast .brand b{color:var(--amber); font-weight:700;}
  .mast .ctx{font-size:10px; letter-spacing:.16em; text-transform:uppercase; color:var(--ink3);}
  .mast .ctx b{color:var(--amber2);}

  /* tier + resource nav */
  .nav{margin:16px 0 18px;}
  .tiers{display:flex; gap:2px; margin-bottom:12px;}
  .tier{font-family:var(--mono); font-size:12px; letter-spacing:.1em; text-transform:uppercase; color:var(--ink3);
    padding:7px 16px 8px; border:1px solid var(--line); border-bottom:none; border-radius:6px 6px 0 0;
    background:var(--panel); cursor:pointer; position:relative; top:1px; transition:.12s;}
  .tier .n{color:var(--ink2); font-weight:600; margin-right:7px;}
  .tier:hover{color:var(--ink2); border-color:var(--line2);}
  .tier.on{color:var(--ink); background:var(--panel2); box-shadow:0 -2px 0 var(--amber) inset;}
  .tier.on .n{color:var(--amber);}
  .tier.dim{opacity:.4; cursor:not-allowed;}
  .reslist{display:flex; flex-wrap:wrap; gap:7px; padding:13px; background:var(--panel2); border:1px solid var(--line); border-radius:0 8px 8px 8px;}
  .chip{font-size:12.5px; color:var(--ink2); padding:6px 12px; border:1px solid var(--line);
    border-radius:5px; background:var(--panel); cursor:pointer; white-space:nowrap; display:flex; align-items:center; gap:8px; transition:.12s;}
  .chip .dot{width:6px; height:6px; border-radius:50%; background:var(--ink4);}
  .chip:hover{border-color:var(--amber-dim); color:var(--ink);}
  .chip.on{border-color:var(--amber); color:var(--ink); background:#1d2230; box-shadow:inset 0 0 0 1px var(--amber-dim);}
  .chip.on .dot{background:var(--amber);}
  .chip .pr{color:var(--ink3); font-variant-numeric:tabular-nums;}
  .chip.on .pr{color:var(--amber2);}

  /* three-zone body: [inventory hero | trade center | trader hero] */
  .body{display:grid; grid-template-columns:var(--hero) minmax(0,1fr) var(--thero); gap:16px; align-items:stretch;}
  @media (max-width:1080px){ .body{grid-template-columns:1fr;} .hero{min-height:280px;} }

  .card{background:var(--panel2); border:1px solid var(--line); border-radius:10px;}
  .card-h{display:flex; align-items:center; justify-content:space-between; padding:13px 16px; border-bottom:1px solid var(--line);}
  .card-h .t{font-family:var(--mono); font-size:11px; letter-spacing:.16em; text-transform:uppercase; color:var(--ink2); font-weight:600;}
  .tag{font-size:9px; letter-spacing:.14em; text-transform:uppercase; padding:3px 8px; border-radius:20px; border:1px solid var(--line2); color:var(--ink3);}
  .tag.soon{color:var(--amber2); border-color:var(--amber-dim);}

  /* ---- heroes (left inventory, right trader art) ---- */
  .hero{background:var(--panel2); border:1px solid var(--line); border-radius:10px; overflow:hidden; display:flex; flex-direction:column;}
  .hero .zhead{font-family:var(--mono); font-size:9px; letter-spacing:.16em; text-transform:uppercase; color:var(--ink3); padding:13px 15px 4px;}
  .hero .zsub{font-size:12px; color:var(--ink2); padding:0 15px 12px; border-bottom:1px solid var(--line); letter-spacing:.02em;}
  .hero .zsub b{color:var(--ink);}

  /* left: inventory bars (mirrors the production console inventory) */
  .inv{padding:12px 13px 14px; overflow-y:auto; flex:1;}
  .inv-h{font-family:var(--mono); font-size:9px; letter-spacing:.16em; text-transform:uppercase; color:rgba(232,223,200,.42); margin:14px 0 6px;}
  .inv-grp:first-child .inv-h{margin-top:2px;}
  .inv-row{position:relative; display:flex; align-items:center; height:26px; margin-bottom:4px; padding:0 9px;
    background:rgba(232,223,200,.05); border:1px solid var(--line); border-radius:4px; overflow:hidden;}
  .inv-row i{position:absolute; left:0; top:0; bottom:0; background:rgba(201,162,39,.24); z-index:0;}
  .inv-row .nm{position:relative; z-index:1; flex:1; min-width:0; font-size:12px; color:var(--ink); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;}
  .inv-row .q{position:relative; z-index:1; font-size:12px; color:var(--ink); font-variant-numeric:tabular-nums; padding-left:8px;}
  .inv-row.zero .nm,.inv-row.zero .q{color:var(--ink4);}
  .inv-row.zero i{background:rgba(232,223,200,.03);}

  /* right: trader character art */
  .thero{position:relative; padding:0;}
  .thero .art{position:absolute; inset:0; background-image:var(--trader); background-size:cover; background-position:right bottom; z-index:0;}
  .thero .scrim{position:absolute; inset:0; z-index:1;
    background:linear-gradient(180deg, rgba(13,15,20,.82) 0%, rgba(13,15,20,.15) 34%, rgba(13,15,20,.05) 60%, rgba(13,15,20,.88) 100%);}
  .thero .tbody{position:absolute; z-index:2; top:50%; left:0; transform:translateY(-50%); padding:0 26px; text-align:left;}
  .thero .teye{font-family:var(--mono); font-size:9px; letter-spacing:.18em; text-transform:uppercase; color:var(--amber2); margin-bottom:5px;}
  .thero .tname{font-family:var(--serif); font-size:24px; font-weight:600; color:var(--ink); line-height:1.1; text-shadow:0 2px 14px rgba(13,15,20,.9), 0 1px 3px rgba(13,15,20,.95);}
  .thero .tflav{font-size:11px; color:var(--ink2); margin-top:8px; line-height:1.5;}
  .thero .ttop{position:relative; z-index:2; padding:13px 15px;}
  .thero .ttop .zhead{padding:0; color:var(--ink3);}

  /* ---- trade center: 2x2, rows equal height ---- */
  .trade{display:grid; grid-template-columns:1.45fr 1fr; grid-auto-rows:1fr; gap:16px; align-items:stretch;}
  @media (max-width:1080px){ .trade{grid-template-columns:1fr;} }
  .trade > .card{display:flex; flex-direction:column; min-width:0;}

  /* price graph */
  .g-head{display:flex; align-items:flex-start; justify-content:space-between; padding:15px 18px 6px;}
  .g-name{font-family:var(--serif); font-size:21px; font-weight:600; letter-spacing:.02em; color:var(--ink); line-height:1.1;}
  .g-sub{font-size:10px; letter-spacing:.14em; text-transform:uppercase; color:var(--ink3); margin-top:5px;}
  .g-price{text-align:right;}
  .g-price .now{font-family:var(--mono); font-size:29px; font-weight:600; color:var(--amber2); letter-spacing:.01em; font-variant-numeric:tabular-nums; line-height:1;}
  .g-price .now .c{font-size:16px; color:var(--amber); margin-right:2px;}
  .g-price .chg{font-size:12px; margin-top:6px; font-variant-numeric:tabular-nums;}
  .g-price .chg.up{color:var(--up);}
  .chart-wrap{position:relative; padding:6px 12px 0; flex:1; display:flex;}
  svg.chart{display:block; width:100%; height:100%; min-height:190px; overflow:visible;}
  .scales{display:flex; gap:6px; padding:8px 18px 8px; justify-content:flex-end;}
  .scale{font-size:11px; letter-spacing:.08em; color:var(--ink3); padding:5px 13px; border:1px solid var(--line); border-radius:5px; background:var(--panel); cursor:pointer; transition:.12s;}
  .scale:hover{color:var(--ink2); border-color:var(--line2);}
  .scale.on{color:var(--void); background:var(--amber); border-color:var(--amber); font-weight:600;}
  .g-foot{font-size:10px; letter-spacing:.04em; color:var(--ink4); padding:0 18px 14px; display:flex; justify-content:space-between;}

  /* syndicate trade */
  .mode{display:flex; gap:0;}
  .mbtn{font-size:11px; letter-spacing:.1em; text-transform:uppercase; padding:6px 15px; border:1px solid var(--line2); background:var(--panel); color:var(--ink3); cursor:pointer; transition:.12s;}
  .mbtn:first-child{border-radius:5px 0 0 5px;} .mbtn:last-child{border-radius:0 5px 5px 0; border-left:none;}
  .mbtn.on{background:var(--amber); color:var(--void); border-color:var(--amber); font-weight:600;}
  .mbtn.na{opacity:.45; cursor:not-allowed;}
  .syn-body{padding:16px 18px 18px; display:flex; flex-direction:column; gap:15px; flex:1; justify-content:center;}
  .hold{display:flex; align-items:baseline; justify-content:space-between; font-size:12px; color:var(--ink3); padding-bottom:13px; border-bottom:1px dashed var(--line2);}
  .hold b{color:var(--ink); font-weight:600; font-size:15px; font-variant-numeric:tabular-nums;}
  /* per-system sell allocation */
  .sellhead{display:flex; align-items:baseline; justify-content:space-between; padding-bottom:11px; border-bottom:1px dashed var(--line2);}
  .sellhead .sg{font-family:var(--serif); font-size:17px; font-weight:600; color:var(--ink);}
  .sellhead .sp{font-family:var(--mono); font-size:15px; color:var(--amber2); font-variant-numeric:tabular-nums;}
  .sellhead .sp .c{font-size:11px; color:var(--amber); margin-right:1px;} .sellhead .sp i{font-style:normal; font-size:10px; color:var(--ink3);}
  .sysalloc{display:flex; flex-direction:column; gap:8px;}
  .sysrow{display:grid; grid-template-columns:1fr auto auto; align-items:center; gap:10px;}
  .sysrow .snm{font-size:13px; color:var(--ink); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;}
  .sysrow .snm .sh{display:block; font-size:10px; color:var(--ink3); letter-spacing:.04em; margin-top:1px;}
  .sysrow .qtybox{width:104px;} .sysrow .qtybox input{font-size:15px; padding:8px 10px;}
  .sysrow .smax{font-size:10px; letter-spacing:.08em; text-transform:uppercase; color:var(--ink3); background:var(--panel); border:1px solid var(--line2); border-radius:5px; padding:8px 10px; cursor:pointer; transition:.12s;}
  .sysrow .smax:hover{color:var(--ink); border-color:var(--amber-dim);}
  .selltot{display:flex; justify-content:flex-end; gap:6px; font-size:11px; color:var(--ink3); letter-spacing:.04em;}
  .selltot b{color:var(--ink2); font-variant-numeric:tabular-nums;}
  .qtyrow{display:flex; align-items:stretch; gap:9px;}
  .qtybox{flex:1; display:flex; align-items:center; border:1px solid var(--line2); border-radius:7px; background:var(--void); overflow:hidden;}
  .qtybox input{flex:1; min-width:0; background:none; border:none; color:var(--ink); font-family:var(--mono); font-size:20px; font-weight:600; padding:11px 14px; outline:none; font-variant-numeric:tabular-nums;}
  .qtybox .u{font-size:11px; color:var(--ink3); padding-right:12px; letter-spacing:.06em;}
  .step{display:flex; flex-direction:column; border-left:1px solid var(--line2);}
  .step button{background:var(--panel3); border:none; color:var(--ink2); width:32px; flex:1; cursor:pointer; font-size:11px; padding:0;}
  .step button:hover{background:#242a36; color:var(--amber);}
  .step button:first-child{border-bottom:1px solid var(--line2);}
  .maxbtn{background:var(--panel); border:1px solid var(--line2); color:var(--ink2); border-radius:7px; padding:0 15px; font-size:11px; letter-spacing:.1em; cursor:pointer; text-transform:uppercase;}
  .maxbtn:hover{border-color:var(--amber-dim); color:var(--amber2);}
  .forline{display:flex; align-items:baseline; justify-content:space-between;}
  .forline .lbl{font-size:11px; letter-spacing:.12em; text-transform:uppercase; color:var(--ink3);}
  .forline .amt{font-family:var(--mono); font-size:26px; font-weight:600; color:var(--ink); font-variant-numeric:tabular-nums;}
  .forline .amt .c{color:var(--amber); font-size:17px; margin-right:2px;}
  .exec{width:100%; padding:14px; border:none; border-radius:8px; background:var(--amber); color:var(--void);
    font-family:var(--mono); font-weight:600; font-size:15px; letter-spacing:.14em; text-transform:uppercase; cursor:pointer; transition:.12s;}
  .exec:hover{background:var(--amber2);}
  .exec[disabled]{background:var(--panel3); color:var(--ink3); cursor:not-allowed; box-shadow:inset 0 0 0 1px var(--line2);}
  .fine{font-size:10.5px; color:var(--ink3); text-align:center; letter-spacing:.03em;}
  .fine b{color:var(--ink2); font-weight:500;}

  /* placeholders */
  .ph{opacity:.62;}
  .ph-body{padding:14px 16px 16px; display:flex; flex-direction:column; gap:9px; flex:1;}
  .filt{display:flex; align-items:center; gap:8px; font-size:10px; letter-spacing:.08em; text-transform:uppercase; color:var(--ink4); padding-bottom:4px;}
  .filt .tgl{color:var(--ink4); cursor:pointer;}
  .filt .tgl.on{color:var(--ink2);}
  .filt .sortlbl{margin-left:auto; color:var(--ink4);}
  .filt .sortbtn{font:inherit; letter-spacing:.08em; text-transform:uppercase; color:var(--ink3); background:var(--panel);
    border:1px solid var(--line); border-radius:5px; padding:4px 8px; cursor:pointer; display:inline-flex; align-items:center; gap:5px; transition:.12s;}
  .filt .sortbtn i{font-style:normal; font-size:8px; color:var(--ink4);}
  .filt .sortbtn:hover{border-color:var(--line2); color:var(--ink2);}
  .filt .sortbtn.on{color:var(--ink); border-color:var(--amber-dim); background:#1d2230;}
  .filt .sortbtn.on i{color:var(--amber2);}
  .list-scroll{display:flex; flex-direction:column; gap:9px; overflow-y:auto; flex:1 1 0; min-height:0; max-height:196px; padding-right:4px; margin-right:-4px;}
  .list-scroll::-webkit-scrollbar{width:7px;}
  .list-scroll::-webkit-scrollbar-thumb{background:var(--line2); border-radius:4px;}
  .listing{display:grid; grid-template-columns:1fr auto; gap:2px 10px; padding:9px 12px; border:1px solid var(--line); border-radius:6px; background:var(--panel); flex:none;}
  .listing .p{font-size:15px; color:var(--ink2); font-variant-numeric:tabular-nums; font-weight:600;}
  .listing .p .c{color:var(--ink3); font-size:11px;}
  .listing .q{font-size:11px; color:var(--ink3); grid-column:1; font-variant-numeric:tabular-nums;}
  .listing .who{font-size:10px; color:var(--ink4); text-align:right; grid-column:2; grid-row:1;}
  .listing .dist{font-size:10px; color:var(--ink4); text-align:right; grid-column:2; grid-row:2;}
  .listrow{display:flex; gap:9px; align-items:stretch;}
  .listrow .qtybox{flex:1;} .listrow .qtybox input{font-size:15px; padding:9px 12px;}
  .ph-note{font-size:11px; color:var(--ink4); line-height:1.5; border-top:1px solid var(--line); padding-top:11px; margin-top:auto;}
  .ph-note b{color:var(--amber2); font-weight:500;}

  .legend{margin-top:20px; padding-top:14px; border-top:1px solid var(--line); display:flex; flex-wrap:wrap; gap:8px 22px; font-size:10.5px; color:var(--ink3);}
  .legend .k{color:var(--ink2);}
  .legend .sw{display:inline-block; width:10px; height:10px; border-radius:2px; vertical-align:-1px; margin-right:6px;}
</style>

<div class="wrap">
  <div class="nav">
    <div class="tiers">
      <div class="tier"><span class="n">1</span>Raw</div>
      <div class="tier on"><span class="n">2</span>Processed</div>
      <div class="tier dim"><span class="n">3</span>Parts</div>
      <div class="tier dim"><span class="n">4</span>Constructed</div>
    </div>
    <div class="reslist" id="reslist"></div>
  </div>

  <div class="body">
    <!-- LEFT HERO: inventory -->
    <aside class="hero">
      <div class="zhead">Holdings</div>
      <div class="zsub"></div>
      <div class="inv" id="inv"></div>
    </aside>

    <!-- CENTER: trade 2x2 -->
    <div class="trade">
      <div class="card">
        <div class="g-head">
          <div>
            <div class="g-name" id="gName">Titanium Alloy</div>
            <div class="g-sub"></div>
          </div>
          <div class="g-price">
            <div class="now"><span class="c">&#162;</span><span id="gNow">22.10</span></div>
            <div class="chg up">&#9650; +121% &nbsp;<span style="color:var(--ink4)">30d</span></div>
          </div>
        </div>
        <div class="chart-wrap">
          <svg class="chart" id="chart" viewBox="0 0 620 210" preserveAspectRatio="none" aria-label="Price over time"></svg>
        </div>
        <div class="scales" id="scales">
          <button class="scale" data-s="3M">3M</button>
          <button class="scale" data-s="1M">1M</button>
          <button class="scale" data-s="2W">2W</button>
          <button class="scale on" data-s="3D">3D</button>
        </div>
        <div class="g-foot"><span></span><span id="gRange"></span></div>
      </div>

      <div class="card ph">
        <div class="card-h"><span class="t">Open Market</span><span class="tag soon">Later &middot; needs transport</span></div>
        <div class="ph-body">
          <div class="filt">
            <span class="tgl on">Sell offers</span><span class="tgl">Buy offers</span>
            <button class="sortbtn on" data-k="price" style="margin-left:auto">Price <i>&#9660;</i></button>
            <button class="sortbtn" data-k="dist">Distance <i>&#9660;</i></button>
          </div>
          <div class="list-scroll" id="mkt">
          <div class="listing"><div class="p"><span class="c">&#162;</span>19.40</div><div class="who">Kestrel Combine</div><div class="q">840&#8202;u</div><div class="dist">2 jumps</div></div>
          <div class="listing"><div class="p"><span class="c">&#162;</span>20.05</div><div class="who">Vane Holdings</div><div class="q">1,200&#8202;u</div><div class="dist">5 jumps</div></div>
          <div class="listing"><div class="p"><span class="c">&#162;</span>20.80</div><div class="who">Orrey Freeport</div><div class="q">300&#8202;u</div><div class="dist">9 jumps</div></div>
          <div class="listing"><div class="p"><span class="c">&#162;</span>21.15</div><div class="who">Halcyon Reach</div><div class="q">560&#8202;u</div><div class="dist">11 jumps</div></div>
          <div class="listing"><div class="p"><span class="c">&#162;</span>21.60</div><div class="who">Thorne &amp; Co.</div><div class="q">2,000&#8202;u</div><div class="dist">14 jumps</div></div>
          <div class="listing"><div class="p"><span class="c">&#162;</span>22.30</div><div class="who">Meridian Bloc</div><div class="q">180&#8202;u</div><div class="dist">18 jumps</div></div>
          </div>
          <div class="ph-note"></div>
        </div>
      </div>

      <div class="card">
        <div class="card-h">
          <span class="t">Syndicate Trade</span>
          <div class="mode" id="synMode">
            <button class="mbtn on" data-m="sell">Sell</button>
            <button class="mbtn na" data-m="buy" title="Buying needs the transport system - a later slice">Buy</button>
          </div>
        </div>
        <div class="syn-body">
          <div class="sellhead"><span class="sg">Titanium Alloy</span><span class="sp"><span class="c">&#162;</span>21.00 <i>/u</i></span></div>
          <div class="sysalloc" id="sysAlloc"></div>
          <div class="forline"><span class="lbl">You receive</span><span class="amt"><span class="c">&#162;</span><span id="proceeds">0</span></span></div>
          <button class="exec" id="sellBtn">Sell to Syndicate</button>
        </div>
      </div>

      <div class="card ph">
        <div class="card-h"><span class="t">Your Listings</span><span class="tag soon">Later</span></div>
        <div class="ph-body">
          <div class="filt"><span class="a">Sell</span><span>Buy</span></div>
          <div class="listrow">
            <div class="qtybox"><input type="text" value="250" disabled aria-label="List quantity"><span class="u">u</span></div>
            <div class="qtybox"><input type="text" value="21.00" disabled aria-label="List price"><span class="u">&#162;</span></div>
          </div>
          <button class="exec" style="letter-spacing:.14em;" disabled>List on Open Market</button>
          <div class="ph-note"></div>
        </div>
      </div>
    </div>

    <!-- RIGHT HERO: trader character -->
    <aside class="hero thero">
      <div class="art"></div>
      <div class="scrim"></div>
      <div class="tbody">
        <div class="tname">Syndicate Exchange</div>
      </div>
    </aside>
  </div>

</div>

<script>
(function(){
  "use strict";
  var NOW = 22.10, BASE = 10;
  function walk(n, seed, vol){
    var s = seed, out = [], v = BASE + 0.4;
    function rnd(){ s=(s*9301+49297)%233280; return s/233280; }
    for (var i=0;i<n;i++){ var t=i/(n-1); var target=BASE+(NOW-BASE)*Math.pow(t,1.35);
      v += (target-v)*0.28 + (rnd()-0.5)*vol; out.push(Math.max(BASE-0.6,v)); }
    out[out.length-1]=NOW; return out;
  }
  var SERIES={ "3D":walk(90,7,1.5), "2W":walk(120,31,1.1), "1M":walk(140,88,0.85), "3M":walk(120,205,0.7) };
  var RANGE={ "3D":"last 3 days","2W":"last 2 weeks","1M":"last month","3M":"last 3 months" };
  var W=620,H=210,PADT=12,PADB=14;
  function draw(scale){
    var data=SERIES[scale], lo=Math.min.apply(null,data), hi=Math.max.apply(null,data);
    lo=Math.min(lo,BASE); hi=hi+(hi-lo)*0.12+0.5; var n=data.length;
    function X(i){return (i/(n-1))*W;} function Y(v){return PADT+(1-(v-lo)/(hi-lo))*(H-PADT-PADB);}
    var line="";
    for(var i=0;i<n;i++){ line+=(i?"L":"M")+X(i).toFixed(1)+" "+Y(data[i]).toFixed(1)+" "; }
    var area="M0 "+Y(data[0]).toFixed(1)+" "+line.slice(1)+" L"+W+" "+H+" L0 "+H+" Z";
    var grid="";
    for(var g=1;g<4;g++){ var gy=(PADT+g/4*(H-PADT-PADB)).toFixed(1); grid+='<line x1="0" y1="'+gy+'" x2="'+W+'" y2="'+gy+'" stroke="rgba(232,223,200,.05)"/>'; }
    var baseY=Y(BASE).toFixed(1), ex=X(n-1).toFixed(1), ey=Y(NOW).toFixed(1);
    document.getElementById("chart").innerHTML=
      '<defs><linearGradient id="fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="rgba(201,162,39,.28)"/><stop offset="1" stop-color="rgba(201,162,39,0)"/></linearGradient></defs>'
      +grid
      +'<line x1="0" y1="'+baseY+'" x2="'+W+'" y2="'+baseY+'" stroke="rgba(232,223,200,.18)" stroke-dasharray="3 5"/>'
      +'<text x="4" y="'+(+baseY-5)+'" fill="#454b58" font-size="9" font-family="monospace">base &#162;10</text>'
      +'<path d="'+area+'" fill="url(#fill)"/>'
      +'<path d="'+line+'" fill="none" stroke="#C9A227" stroke-width="2" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>'
      +'<line x1="'+ex+'" y1="'+PADT+'" x2="'+ex+'" y2="'+(H-PADB)+'" stroke="rgba(227,192,74,.35)" stroke-dasharray="2 3"/>'
      +'<circle cx="'+ex+'" cy="'+ey+'" r="4.5" fill="#e3c04a" stroke="#0d0f14" stroke-width="1.5"/>'
      +'<text x="'+(+ex-6)+'" y="'+(+ey-9)+'" fill="#e3c04a" font-size="10" font-family="monospace" text-anchor="end">NOW</text>';
    document.getElementById("gRange").textContent="";
  }
  document.getElementById("scales").addEventListener("click",function(e){
    var b=e.target.closest(".scale"); if(!b) return;
    [].forEach.call(this.querySelectorAll(".scale"),function(x){x.classList.remove("on");});
    b.classList.add("on"); draw(b.dataset.s);
  });

  // Per-system sell allocation: the player sets how much of the selected good
  // comes from EACH system that holds it. Nothing drains automatically.
  var proceeds=document.getElementById("proceeds"), UNIT=21.00;
  var SELLSYS=[ ["Kepler Reach",920], ["Vane Drift",500] ];   // held per system (sums 1,420)
  function fmt(n){return Math.round(n).toLocaleString("en-US");}
  var sa=document.getElementById("sysAlloc"), sh="";
  SELLSYS.forEach(function(r,i){
    sh+='<div class="sysrow"><span class="snm">'+r[0]+'<span class="sh">holds '+fmt(r[1])+' u</span></span>'
      + '<div class="qtybox"><input id="sy'+i+'" type="text" value="0" inputmode="numeric" aria-label="Sell from '+r[0]+'"><span class="u">u</span></div>'
      + '<button class="smax" data-i="'+i+'">Max</button></div>';
  });
  sh+='<div class="selltot">Selling <b id="sellTot">0</b> u</div>';
  sa.innerHTML=sh;
  function clampRow(i){ var el=document.getElementById("sy"+i); var v=parseInt((el.value+"").replace(/[^0-9]/g,""),10); if(isNaN(v))v=0; if(v>SELLSYS[i][1])v=SELLSYS[i][1]; el.value=v; return v; }
  function recalc(){ var tot=0; SELLSYS.forEach(function(r,i){ tot+=clampRow(i); }); document.getElementById("sellTot").textContent=fmt(tot); proceeds.textContent=fmt(tot*UNIT); }
  SELLSYS.forEach(function(r,i){ document.getElementById("sy"+i).addEventListener("input",recalc); });
  Array.prototype.forEach.call(document.querySelectorAll(".smax"),function(b){ b.addEventListener("click",function(){ var i=+b.dataset.i; document.getElementById("sy"+i).value=SELLSYS[i][1]; recalc(); }); });
  document.getElementById("synMode").addEventListener("click",function(e){
    var b=e.target.closest(".mbtn"); if(!b||b.classList.contains("na")) return;
    [].forEach.call(this.querySelectorAll(".mbtn"),function(x){x.classList.remove("on");}); b.classList.add("on");
  });
  document.getElementById("sellBtn").addEventListener("click",function(){
    var tot=0; SELLSYS.forEach(function(r,i){ tot+=clampRow(i); }); var self=this;
    if(!tot) return;
    self.textContent="Sold "+fmt(tot)+"u  +&#162;"+fmt(tot*UNIT); self.style.background="#5fb98a";
    setTimeout(function(){ self.textContent="Sell to Syndicate"; self.style.background=""; },1400);
  });

  var GOODS=[["Titanium Alloy","22.10",1],["Battery Cells","10.00",0],["Carbon Fibre Weave","10.00",0],["Composite Resin","10.00",0],["Conductive Material","10.00",0],["Heat-Resistant Alloy","10.00",0],["Magnetic Assemblies","10.00",0],["Nanotube Cable","10.00",0],["Radiation Shielding","10.00",0],["Refrigerant Fluid","10.00",0],["Silicon Wafer","10.00",0]];
  var rl=document.getElementById("reslist");
  rl.innerHTML=GOODS.map(function(g){ return '<div class="chip'+(g[2]?" on":"")+'"><span class="dot"></span>'+g[0]+' <span class="pr">&#162;'+g[1]+'</span></div>'; }).join("");
  rl.addEventListener("click",function(e){ var c=e.target.closest(".chip"); if(!c) return; [].forEach.call(this.querySelectorAll(".chip"),function(x){x.classList.remove("on");}); c.classList.add("on"); });

  // holdings inventory (mirrors the production console inventory)
  var INV={ "Tier 1":[["Titanium",1180],["Carbon Products",640],["Copper",210],["Helium",150],["Lead",90],["Nitrogen",40]],
            "Tier 2":[["Titanium Alloy",1420],["Composite Resin",120],["Conductive Material",60],["Battery Cells",0],["Silicon Wafer",0]],
            "Tier 3":[["Small Reactor Engine",0],["Medium Reactor Engine",0],["Heavy Reactor Engine",0]] };
  var inv=document.getElementById("inv"), html="";
  Object.keys(INV).forEach(function(tier){
    var held=INV[tier].filter(function(r){return r[1]>0;});   // only resources the guild actually holds
    if(!held.length) return;                                   // drop the whole tier header if nothing held
    var max=Math.max.apply(null,held.map(function(r){return r[1];}))||1;
    html+='<div class="inv-grp"><div class="inv-h">'+tier+'</div>';
    held.slice().sort(function(a,b){return b[1]-a[1]||(a[0]<b[0]?-1:1);}).forEach(function(r){
      var pct=Math.round(r[1]/max*100);
      html+='<div class="inv-row"><i style="width:'+pct+'%"></i><span class="nm">'+r[0]+'</span><span class="q">'+r[1].toLocaleString("en-US")+'</span></div>';
    });
    html+='</div>';
  });
  inv.innerHTML=html;

  // ---- Open Market sort (Price / Distance, click to flip high<->low) ----
  var mkt=document.getElementById("mkt");
  var sortState={ key:"price", dir:{price:-1, dist:1} };   // -1 = high->low (v), +1 = low->high (^)
  function num(el,sel){ return parseFloat(el.querySelector(sel).textContent.replace(/[^0-9.]/g,""))||0; }
  function applySort(){
    var k=sortState.key, d=sortState.dir[k];
    var rows=[].slice.call(mkt.querySelectorAll(".listing"));
    rows.sort(function(a,b){
      var va=k==="price"?num(a,".p"):num(a,".dist"), vb=k==="price"?num(b,".p"):num(b,".dist");
      return (va-vb)*d;
    });
    rows.forEach(function(r){mkt.appendChild(r);});
    document.querySelectorAll(".sortbtn").forEach(function(btn){
      var on=btn.dataset.k===k; btn.classList.toggle("on",on);
      btn.querySelector("i").innerHTML = sortState.dir[btn.dataset.k]===-1 ? "&#9660;" : "&#9650;";
    });
  }
  document.querySelectorAll(".sortbtn").forEach(function(btn){
    btn.addEventListener("click",function(){
      var k=btn.dataset.k;
      if(sortState.key===k){ sortState.dir[k]*=-1; } else { sortState.key=k; }
      applySort();
    });
  });
  document.querySelectorAll(".filt .tgl").forEach(function(t){
    t.addEventListener("click",function(){
      document.querySelectorAll(".filt .tgl").forEach(function(x){x.classList.remove("on");});
      t.classList.add("on");
    });
  });
  applySort();

  draw("3D"); recalc();
})();
</script>
STARFARE_TRADE_MOCKUP_EOF

echo "e1c9fae99a521581b30b92485ad4f52136812e17bfcdb6dacd308ed3d9e12021  docs/mockups/trade-panel.html" | sha256sum -c -

# ---- 2. replace the design.md SELL ruling (fail-loud; base64 anchors) ----
python3 - <<'PYEOF'
import base64
old = base64.b64decode("KipTRUxMIEdPRVMgTElWRSDigJQgdGhlIGZpcnN0IGV4ZWN1dGFibGUgc2xpY2Ugb2YgdGhlIEV4Y2hhbmdlICooMjktMDgtMjYpKi4qKiBFdmVyeXRoaW5nIGFib3ZlIGlzIHRoZSBtaWNyb3N0cnVjdHVyZTsgdGhpcyBpcyB0aGUgZmlyc3QgcGllY2Ugb2YgaXQgdGhlIGVuZ2luZSBhY3R1YWxseSBydW5zOiBhIGd1aWxkICoqc2VsbGluZyBzdG9ja3BpbGUgZ29vZHMgdG8gdGhlIFN5bmRpY2F0ZSoqLiAoQlVZIGlzIGRlZmVycmVkIOKAlCBpdCBuZWVkcyB0aGUgdHJhbnNwb3J0IHN5c3RlbSwgwqc2IOKAlCBhbmQgdGhlIGd1aWxkLXRvLWd1aWxkIG9yZGVyIGJvb2sgc3RheXMgUGhhc2UgMy4pCgotICoqR3VpbGQtd2lkZSwgbm90IHBlci1zeXN0ZW0uKiogQSBzYWxlIGlzIHBsYWNlZCBhZ2FpbnN0IHRoZSBndWlsZCdzICp0b3RhbCogc3RvY2twaWxlIG9mIGEgZ29vZC4gVGhlIGdvb2RzIGRyYWluICoqbGFyZ2VzdC1waWxlLWZpcnN0KiogYWNyb3NzIHRoZSBndWlsZCdzIHN5c3RlbXMgKGRldGVybWluaXN0aWM7IHRpZXMgYnJva2VuIGJ5IHN5c3RlbSBpZCkuIFRoaXMgaXMgaW52aXNpYmxlIHRvIHRoZSBwbGF5ZXIgdG9kYXksIGJ1dCBpdCBpcyBhIHJlYWwgcnVsaW5nOiBpdCBkZWNpZGVzIHdoaWNoIHN5c3RlbSdzIHBlci1zeXN0ZW0gcGlsZSBzaHJpbmtzLCBhbmQgaXQgbXVzdCBiZSBkZXRlcm1pbmlzdGljIChpbnZhcmlhbnQgOSkuCi0gKipJbW1lZGlhdGUsIGF0IHRoZSBjdXJyZW50IHBvc3RlZCBwcmljZS4qKiBUaGUgc2FsZSBleGVjdXRlcyB0aGUgbW9tZW50IGl0IGlzIHBsYWNlZCwgYXQgYHBvc3RlZFByaWNlKGdvb2QpYCDigJQgdGhlIHNhbWUgcHVibGlzaGVkICgyLXRpY2stbGFnZ2VkKSB2YWx1ZSB0aGUgcGxheWVyIGlzIGxvb2tpbmcgYXQuIE5vIHByb2plY3Rpb24sIG5vIGF2ZXJhZ2luZyBhY3Jvc3MgdGhlIGZpbGwsIG5vIHNsaWRpbmcgKHJ1bGluZyAyOS0wOC0yNik6ICJnb29kcyBzb2xkIHRvIHRoZSBTeW5kaWNhdGUgZXhlY3V0ZSBhdCB0aGUgY3VycmVudCBwcmljZSBkdXJpbmcgdGhlIHRpY2ssIGVuZCBvZi4iCi0gKipDcmVkaXRzIOKAlCB0aGUgcnVsZWQgY29udmVudGlvbiwgbm90IGEgbmV3IG9uZS4qKiBgY3JlZGl0ZWQgPSByb3VuZChxdHkgw5cgcG9zdGVkUHJpY2UpYCDigJQgZGVjaXNpb24gKiojNDMqKiAoYHJvdW5kKHF0eSDDlyBwcmljZSlgLCBpZGVudGljYWwgb24gYm90aCBzaWRlcyksIHRoZSBzYW1lIGFyaXRobWV0aWMgdGhlIGNvbW1pdG1lbnQgc2FsZSBhbHJlYWR5IHVzZXMgKGBjb21taXRtZW50U2FsZWAsIGFib3ZlKS4gVGhlIFN5bmRpY2F0ZSAqKmxlZGdlciBmdW5kcyB0aGUgcGF5bWVudCoqIChgZ3VpbGQuY3JlZGl0cyArPSBjcmVkaXRlZDsgc3luZGljYXRlLmxlZGdlciAtPSBjcmVkaXRlZGApLCBzbyBpdCBpcyBjcmVkaXQtY29uc2VydmF0aW9uLWNsZWFuIOKAlCB0aGUgbWlycm9yIG9mIGBwYXlTeW5kaWNhdGVGZWVgLCBhbmQgaW52YXJpYW50IDIgaG9sZHMgZXhhY3RseS4KLSAqKlRoZSBnb29kcyBsZWF2ZSB0aGUgZWNvbm9teS4qKiBUaGV5IGFyZSBhYnNvcmJlZCBpbnRvIHRoZSBTeW5kaWNhdGUncyBpbmV4aGF1c3RpYmxlIHN0b2NrOyB0aGUgc2FsZSBkZXBvc2l0cyB0aGVtIG5vd2hlcmUuCi0gKipObyByZXNlcnZlIGd1YXJkLioqIEEgZ3VpbGQgbWF5IHNlbGwgaXRzICplbnRpcmUqIHN0b2NrcGlsZSBvZiBhIGdvb2QgaW4gYSBzaW5nbGUgb3JkZXIuIFRoZSBwbGF5ZXIgb3ducyB0aGUgY29uc2VxdWVuY2Ug4oCUIHRoZXJlIGlzIG5vIGZsb29yLCBubyAia2VlcCBzb21lIGJhY2siIHByb3RlY3Rpb24uCi0gKipNYXJrZXQgaW1wYWN0IGlzIE9OLCBhbmQgaXQgZmFsbHMgb3V0IGZvciBmcmVlLioqIERyYWluaW5nIHRoZSBzdG9ja3BpbGUgbG93ZXJzIHRoZSBsZXZlbCB0aGUgcHJpY2UgZW5naW5lIHJlYWRzLCBzbyB0aGUgbmV4dCByZWNvbXB1dGUgbG93ZXJzIHRoZSBwb3N0ZWQgdmFsdWU6IHNlbGxpbmcgaW50byB5b3VyIG93biBob2FyZCBtb3ZlcyB0aGUgcHJpY2UgYWdhaW5zdCB5b3UuIFRoZXJlIGlzIG5vIHNlcGFyYXRlIGltcGFjdCBjb2RlIOKAlCBpdCBpcyB0aGUgbGV2ZWwtYmFzZWQgcHJpY2luZyAoYGRvY3MvbGljZW5jZS1hbmQtcHJpY2Utc3lzdGVtLm1kYCkgZG9pbmcgaXRzIGpvYi4KLSAqKkZ1ZWwgaXMgbmV2ZXIgc29sZCBoZXJlKiogKG5ldmVyIHByaWNlZCwgwqc4KTogdGhlIHNlbGwgYWN0aW9uIHJlZnVzZXMgYSBmdWVsIGdvb2QsIGV4YWN0bHkgYXMgdGhlIEV4Y2hhbmdlIHJlZnVzZXMgdG8gbGlzdCBpdC4KClRoZSBzY3JlZW4gaXMgdGhlICoqVFJBREUgdGFiKiogKHJlbmFtZWQgZnJvbSAiU3luZGljYXRlIE1hcmtldHBsYWNlIik7IGl0cyB2aXN1YWwgKyBpbnRlcmFjdGlvbiBjb250cmFjdCBpcyBgZG9jcy9tb2NrdXBzL3RyYWRlLXBhbmVsLmh0bWxgLiBUaGUgcHJpY2UgZ3JhcGggcmVhZHMgdGhlIG11bHRpLXJlc29sdXRpb24gYHN0YXRlLnByaWNlSGlzdG9yeWAgKGl0cyBvd24gcHJpb3Igc2xpY2Ug4oCUIGl0IHNoaXBzIGZpcnN0IHNvIGhpc3RvcnkgaXMgYWxyZWFkeSBhY2NydWluZykuIEhvbGRpbmdzIG9uIHRoZSBwYW5lbCBsaXN0cyBvbmx5IGdvb2RzIHRoZSBndWlsZCBhY3R1YWxseSBob2xkcyAocXR5ID4gMCkuIEJVWSwgdGhlIHNoaXBtZW50L3RyYW5zcG9ydCBwYW5lbCwgYW5kIHRoZSBndWlsZC10by1ndWlsZCBib29rIHJlbWFpbiBkZWZlcnJlZCBhcyBhYm92ZS4K").decode("utf-8")
new = base64.b64decode("KipTRUxMIEdPRVMgTElWRSDigJQgdGhlIGZpcnN0IGV4ZWN1dGFibGUgc2xpY2Ugb2YgdGhlIEV4Y2hhbmdlICooMjktMDgtMjYpKi4qKiBFdmVyeXRoaW5nIGFib3ZlIGlzIHRoZSBtaWNyb3N0cnVjdHVyZTsgdGhpcyBpcyB0aGUgZmlyc3QgcGllY2Ugb2YgaXQgdGhlIGVuZ2luZSBhY3R1YWxseSBydW5zOiBhIGd1aWxkICoqc2VsbGluZyBzdG9ja3BpbGUgZ29vZHMgdG8gdGhlIFN5bmRpY2F0ZSoqLiAoQlVZIGlzIGRlZmVycmVkIOKAlCBpdCBuZWVkcyB0aGUgdHJhbnNwb3J0IHN5c3RlbSwgwqc2IOKAlCBhbmQgdGhlIGd1aWxkLXRvLWd1aWxkIG9yZGVyIGJvb2sgc3RheXMgUGhhc2UgMy4pCgotICoqUGxheWVyLWFsbG9jYXRlZCwgcGVyIHN5c3RlbSDigJQgbm8gYXV0b21hdGljIGRyYWluLioqIEEgc2FsZSBpcyAqY29tcG9zZWQgYnkgdGhlIHBsYXllcio6IGZvciB0aGUgZ29vZCBiZWluZyBzb2xkLCB0aGV5IHNldCB0aGUgcXVhbnRpdHkgdGFrZW4gZnJvbSAqKmVhY2ggc3lzdGVtIHRoYXQgaG9sZHMgaXQqKiAoMzAwIGZyb20gb25lIHN5c3RlbSwgMCBmcm9tIGFub3RoZXIpLiBUaGVyZSBpcyAqKm5vIGd1aWxkLXdpZGUgYXV0by1ydWxlKiog4oCUIHRoZSBlYXJsaWVyICJsYXJnZXN0LXBpbGUtZmlyc3QiIGlkZWEgaXMgKipleHBsaWNpdGx5IHJlamVjdGVkKiouIEJlY2F1c2UgcGVyLXN5c3RlbSBzdG9ja3BpbGVzIGZlZWQgbG9jYWwgcHJvZHVjdGlvbiAoYSBmYWN0b3J5IGRyYXdzIGl0cyBpbnB1dHMgZnJvbSAqaXRzIG93biogc3lzdGVtJ3MgcGlsZSksIHdoaWNoIHN5c3RlbSBhIHNhbGUgY29tZXMgb3V0IG9mIGlzIGEgcmVhbCBzdXBwbHktY2hhaW4gbGV2ZXI6IHB1bGxpbmcgc3RvY2sgb3V0IGZyb20gdW5kZXIgYSBmYWN0b3J5IG11c3QgYmUgdGhlIHBsYXllcidzIGRlbGliZXJhdGUgYWN0LCBuZXZlciBhIHN1cnByaXNlIHRoZSBlbmdpbmUgc3ByaW5ncy4gQSBzZWxsIGFjdGlvbiB0aGVyZWZvcmUgY2FycmllcyBhICoqc2V0IG9mIGB7c3lzdGVtSWQsIHF0eX1gIGFsbG9jYXRpb25zKiosIG5vdCBvbmUgZ3VpbGQtd2lkZSBxdWFudGl0eS4KLSAqKkltbWVkaWF0ZSwgbm8gdHJhbnNwb3J0LioqIFNlbGxpbmcgaXMgaW5zdGFudCBhbmQgZnJpY3Rpb25sZXNzIOKAlCB0aGUgY2FzaCBsYW5kcyB0aGUgbW9tZW50IHRoZSBzYWxlIGlzIHBsYWNlZCwgdGhlIGdvb2RzIGxlYXZlLCBhbmQgKip3YXlzdGF0aW9uIHByb3hpbWl0eSBpcyBpcnJlbGV2YW50KiogKG5vdGhpbmcgc2hpcHMpLiBUaGF0IGlzIGV4YWN0bHkgd2h5IHRoZSBwbGF5ZXIgbWF5IHBpY2stYW5kLW1peCBzb3VyY2Ugc3lzdGVtcyBmcmVlbHk6IHRoZXJlIGlzIG5vIHNoaXBtZW50IHRvIHJvdXRlLgotICoqQXQgdGhlIGN1cnJlbnQgcG9zdGVkIHByaWNlLioqIEVhY2ggYWxsb2NhdGlvbiBzZWxscyBhdCBgcG9zdGVkUHJpY2UoZ29vZClgIOKAlCB0aGUgcHVibGlzaGVkICgyLXRpY2stbGFnZ2VkKSB2YWx1ZSB0aGUgcGxheWVyIGlzIGxvb2tpbmcgYXQuIE5vIHByb2plY3Rpb24sIG5vIHNsaWRpbmcgKHJ1bGluZyAyOS0wOC0yNik6ICJnb29kcyBzb2xkIHRvIHRoZSBTeW5kaWNhdGUgZXhlY3V0ZSBhdCB0aGUgY3VycmVudCBwcmljZSBkdXJpbmcgdGhlIHRpY2ssIGVuZCBvZi4iCi0gKipDcmVkaXRzIOKAlCB0aGUgcnVsZWQgY29udmVudGlvbiwgbm90IGEgbmV3IG9uZS4qKiBgY3JlZGl0ZWQgPSByb3VuZCh0b3RhbFF0eSDDlyBwb3N0ZWRQcmljZSlgLCBzdW1tZWQgb3ZlciB0aGUgYWxsb2NhdGlvbnMgYW5kICoqcm91bmRlZCBvbmNlKiogb24gdGhlIHRvdGFsIOKAlCBkZWNpc2lvbiAqKiM0MyoqIChgcm91bmQocXR5IMOXIHByaWNlKWAsIGlkZW50aWNhbCBvbiBib3RoIHNpZGVzKSwgdGhlIHNhbWUgYXJpdGhtZXRpYyB0aGUgY29tbWl0bWVudCBzYWxlIHVzZXMgKGBjb21taXRtZW50U2FsZWAsIGFib3ZlKS4gVGhlIFN5bmRpY2F0ZSAqKmxlZGdlciBmdW5kcyB0aGUgcGF5bWVudCoqIChgZ3VpbGQuY3JlZGl0cyArPSBjcmVkaXRlZDsgc3luZGljYXRlLmxlZGdlciAtPSBjcmVkaXRlZGApLCBjcmVkaXQtY29uc2VydmF0aW9uLWNsZWFuIOKAlCB0aGUgbWlycm9yIG9mIGBwYXlTeW5kaWNhdGVGZWVgLCBpbnZhcmlhbnQgMiBob2xkcyBleGFjdGx5LgotICoqVGhlIGdvb2RzIGxlYXZlIHRoZSBlY29ub215LioqIFRoZXkgYXJlIGFic29yYmVkIGludG8gdGhlIFN5bmRpY2F0ZSdzIGluZXhoYXVzdGlibGUgc3RvY2s7IHRoZSBzYWxlIGRlcG9zaXRzIHRoZW0gbm93aGVyZS4gRWFjaCBuYW1lZCBzeXN0ZW0ncyBwaWxlIGRyb3BzIGJ5IGV4YWN0bHkgdGhlIHF1YW50aXR5IHRoZSBwbGF5ZXIgc2V0IGZvciBpdC4KLSAqKk5vIHJlc2VydmUgZ3VhcmQuKiogVGhlIHBsYXllciBtYXkgZW1wdHkgYW55IHN5c3RlbSdzIHBpbGUg4oCUIG9yIGV2ZXJ5IHN5c3RlbSdzIOKAlCBvZiB0aGUgZ29vZC4gVGhlIGNvbnNlcXVlbmNlIGlzIHRoZWlyczsgdGhlcmUgaXMgbm8gZmxvb3IsIG5vICJrZWVwIHNvbWUgYmFjay4iCi0gKipNYXJrZXQgaW1wYWN0IGlzIE9OLCBhbmQgaXQgZmFsbHMgb3V0IGZvciBmcmVlLioqIERyYWluaW5nIGEgc3RvY2twaWxlIGxvd2VycyB0aGUgbGV2ZWwgdGhlIHByaWNlIGVuZ2luZSByZWFkcywgc28gdGhlIG5leHQgcmVjb21wdXRlIGxvd2VycyB0aGUgcG9zdGVkIHZhbHVlOiBzZWxsaW5nIGludG8geW91ciBvd24gaG9hcmQgbW92ZXMgdGhlIHByaWNlIGFnYWluc3QgeW91LiBObyBzZXBhcmF0ZSBpbXBhY3QgY29kZSDigJQgaXQgaXMgdGhlIGxldmVsLWJhc2VkIHByaWNpbmcgKGBkb2NzL2xpY2VuY2UtYW5kLXByaWNlLXN5c3RlbS5tZGApIGRvaW5nIGl0cyBqb2IuCi0gKipGdWVsIGlzIG5ldmVyIHNvbGQgaGVyZSoqIChuZXZlciBwcmljZWQsIMKnOCk6IHRoZSBzZWxsIGFjdGlvbiByZWZ1c2VzIGEgZnVlbCBnb29kLCBleGFjdGx5IGFzIHRoZSBFeGNoYW5nZSByZWZ1c2VzIHRvIGxpc3QgaXQuCgoqKkJVWSDigJQgb25lIHNoaXBtZW50LCBvbmUgZGVzdGluYXRpb24gKGRlZmVycmVkIHRvIHRoZSB0cmFuc3BvcnQgc2xpY2UsIGJ1dCBydWxlZCBub3csIGJlY2F1c2UgaXQgaXMgZGVsaWJlcmF0ZWx5ICphc3ltbWV0cmljKiB3aXRoIFNFTEwpLioqIEJ1eWluZyBpcyB0cmFuc3BvcnRlZCwgc28g4oCUIHVubGlrZSBhIHNlbGwg4oCUIGEgcHVyY2hhc2UgaXMgYSAqKnNpbmdsZSBzaGlwbWVudCB0byBhIHNpbmdsZSBkZXN0aW5hdGlvbiBzeXN0ZW0qKiB0aGUgcGxheWVyIGNob29zZXMgKGxhdGVyLCBhbiBvdXRwb3N0KS4gVGhhdCBkZXN0aW5hdGlvbiBmaXhlcyB0aGUgKipuZWFyZXN0IFN5bmRpY2F0ZSB3YXlzdGF0aW9uKiosIHdoaWNoIGZpeGVzIHRoZSAqKmRpcmVjdC1saW5lIHRyYXZlbCB0aW1lKio7IHRoZSBjYXNoIGRlYml0cyBpbW1lZGlhdGVseSwgdGhlIGdvb2RzIHRyYXZlbCwgYW5kIHRoZXkgKiphdXRvLWRlcG9zaXQgaW50byB0aGF0IG9uZSBkZXN0aW5hdGlvbidzIHN0b2NrcGlsZSBvbiB0aGUgYXJyaXZhbCB0aWNrKiouIEEgcHVyY2hhc2UgKipjYW5ub3QgYmUgc3BsaXQgYWNyb3NzIGRlc3RpbmF0aW9ucyoqIChhIHNlbGwgY2FuIGJlIHNwbGl0IGFjcm9zcyBzb3VyY2VzOyBhIGJ1eSBjYW5ub3Qg4oCUIHRoYXQgaXMgdGhlIGFzeW1tZXRyeSkuIFRoZSB3YXlzdGF0aW9uIGlzIGEgKip0aW1lIHJlZmVyZW5jZSwgbm90IGFuIGludmVudG9yeSoqLiBCVVkgYnVpbGRzIHdpdGggdGhlIHNoaXBtZW50IHN1YnN5c3RlbSAowqc2KTsgdGhpcyBzbGljZSBzaGlwcyAqKlNFTEwgb25seSoqLgoKVGhlIHNjcmVlbiBpcyB0aGUgKipUUkFERSB0YWIqKiAocmVuYW1lZCBmcm9tICJTeW5kaWNhdGUgTWFya2V0cGxhY2UiKTsgaXRzIHZpc3VhbCArIGludGVyYWN0aW9uIGNvbnRyYWN0IGlzIGBkb2NzL21vY2t1cHMvdHJhZGUtcGFuZWwuaHRtbGAg4oCUIHdob3NlIFN5bmRpY2F0ZS1UcmFkZSBjYXJkIGlzIHRoZSAqKnBlci1zeXN0ZW0gYWxsb2NhdGlvbiB0YWJsZSoqIHRoaXMgcnVsaW5nIGRlc2NyaWJlcy4gVGhlIHByaWNlIGdyYXBoIHJlYWRzIHRoZSBtdWx0aS1yZXNvbHV0aW9uIGBzdGF0ZS5wcmljZUhpc3RvcnlgIChpdHMgb3duIHByaW9yIHNsaWNlIOKAlCBpdCBzaGlwcyBmaXJzdCBzbyBoaXN0b3J5IGlzIGFscmVhZHkgYWNjcnVpbmcpLiBIb2xkaW5ncyBvbiB0aGUgcGFuZWwgbGlzdHMgb25seSBnb29kcyB0aGUgZ3VpbGQgYWN0dWFsbHkgaG9sZHMgKHF0eSA+IDApLiBCVVksIHRoZSBzaGlwbWVudC90cmFuc3BvcnQgcGFuZWwsIGFuZCB0aGUgZ3VpbGQtdG8tZ3VpbGQgYm9vayByZW1haW4gZGVmZXJyZWQgYXMgYWJvdmUuCg==").decode("utf-8")
p = "docs/design.md"; s = open(p, encoding="utf-8").read()
assert s.count(old) == 1, f"design.md old-ruling anchor count={s.count(old)} (expected 1) - repo not at the expected commit"
s2 = s.replace(old, new, 1)
assert s2 != s and s2.count("Player-allocated, per system") == 1 and "Guild-wide, not per-system" not in s2, "design.md replace failed"
open(p, "w", encoding="utf-8").write(s2)
print("design.md: SELL/BUY ruling corrected")
PYEOF

# ---- 3. commit (NO push) ----
git add docs/design.md docs/mockups/trade-panel.html
git commit -m "docs: correct Syndicate SELL to player-allocated per-system; rule BUY

Supersede the just-committed guild-wide / largest-pile-first sell. Selling is now
composed by the player per system ({systemId, qty} allocations) with no automatic
drain, so pulling stock out from under a factory is always deliberate - the supply-
chain lever the cascade gameplay needs, not a surprise. Credits round(totalQty*price)
once (#43), ledger-funded, invariant 2 holds; immediate, no transport. Also rule BUY
(still deferred): one shipment to one player-chosen destination, the nearest waystation
sets travel time, auto-deposit on arrival, no splitting - deliberately asymmetric with
SELL. Update docs/mockups/trade-panel.html: the Syndicate-Trade card is now the
per-system allocation table. Doc-only; code lands via Claude Code."

echo; echo "Done. Review:  git show HEAD   then push:  git push origin main"
