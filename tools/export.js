#!/usr/bin/env node
/* JAM Capital Markets: build the public data files from a dump of the private dashboard's database.
   usage: node export.js <dump dir with ds/ cm/ weekly/ daily/ subfolders of <id>.json> <site dir>
   Each dump file is either {v,asof,label,tier} or {id,data:{...},version}. Writes <site>/data/ds.json, cm.json, weekly.json, daily.json.
   Rules (keep in sync with the README):
   - Raw stock-index price histories (S&P 500, Nasdaq, Russell 2000) and gold are never published: index providers
     require pre-approval to republish them. The trading model runs here on the private data and only its derived
     outputs are published (signals, distances from averages, momentum indicators, calls and their % results).
   - ICE BofA credit index figures (IG/HY yields and spreads) are removed: FRED marks them "pre-approval required".
   - FMP-only data with no public equivalent (the earnings calendar) is dropped.
   - Treasury yields are published as the official U.S. Treasury / Federal Reserve H.15 series (public domain).
   The build fails if a private reference is found in the output. */
'use strict';
const fs=require('fs'), path=require('path');
const [dump, site]=process.argv.slice(2);
if(!dump||!site){ console.error('usage: node export.js <dumpdir> <sitedir>'); process.exit(2); }
const M=require(path.resolve(site,'pred-model.js'));
const readDir=c=>{ const d=path.join(dump,c), o={}; if(!fs.existsSync(d)) return o;
  for(const f of fs.readdirSync(d)) if(f.endsWith('.json')){ let x=JSON.parse(fs.readFileSync(path.join(d,f),'utf8')); if(x&&x.data&&!('v' in x)) x=x.data; o[f.slice(0,-5)]=x; }
  return o; };
const ds=readDir('ds'), cm=readDir('cm'), weekly=readDir('weekly'), daily=readDir('daily');
const notes=[];

// ---- drop / scrub datasets
// HEATMAP: the public page shows TradingView's live heat map, so the vendor snapshot isn't needed
const DROP=['EARNINGS','PRED_PX','PRED_LOG','HEATMAP'];
const px=ds.PRED_PX&&ds.PRED_PX.v, log=(ds.PRED_LOG&&ds.PRED_LOG.v)||[];
DROP.forEach(k=>{ if(ds[k]){ delete ds[k]; notes.push('dropped '+k); } });
const ICE=/^(IG corporate yield|IG spread|High-yield spread|HY yield)/i;
if(ds.BOND_KPI&&Array.isArray(ds.BOND_KPI.v)){
  const before=ds.BOND_KPI.v.length; ds.BOND_KPI.v=ds.BOND_KPI.v.filter(r=>!ICE.test(String(r[0])));
  notes.push(`BOND_KPI: removed ${before-ds.BOND_KPI.v.length} ICE BofA rows`);
}
if(ds.PULSE&&Array.isArray(ds.PULSE.v)) ds.PULSE.v=ds.PULSE.v.filter(r=>!/HIGH-YIELD SPREAD|IG SPREAD|ICE BOFA/i.test(String(r[1])+String(r[3])));
if(ds.SRC&&ds.SRC.v){ const S=ds.SRC.v;
  if(S.fmp) S.fmp={...S.fmp,p:'Federal Reserve Board (H.15) via FRED',t:'Treasury constant-maturity yields, daily (public domain)',u:'https://fred.stlouisfed.org/series/DGS10'};
  ['fredhy','igindex'].forEach(k=>delete S[k]);
  for(const [k,x] of Object.entries(S)) if(/claude|your FMP|FMP connector/i.test(JSON.stringify(x))) S[k]={...x,t:String(x.t).replace(/,? via your FMP connector/i,'')};
}
if(ds.RATES) ds.RATES.label='U.S. Treasury constant-maturity yields (Federal Reserve H.15 via FRED, public domain): date,3m,2y,10y,30y';

// ---- trading model: run on the private closes, publish derived outputs only
if(px&&px.d&&px.s){
  const bkFull=readDir('ds').BOND_KPI, fw=ds.FW_PATH;
  const R=M.compute(px,{hy:M.parseHy(bkFull&&bkFull.v),hyAsof:bkFull&&bkFull.asof,fw:fw&&fw.v},log);
  const C=R.charts, pct=(a,b)=>a.map((p,i)=>p==null||b[i]==null?null:+((p/b[i]-1)*100).toFixed(3));
  C.ixic={d:C.ixic.d, dist:pct(C.ixic.p,C.ixic.sma)};
  C.ema={d:C.ema.d, dist:pct(C.ema.p,C.ema.ema)};
  ['ix','smaL','ema'].forEach(k=>{ R.signals[k]=null; });
  R.log=R.log.map(h=>{ const o={...h}; delete o.base; delete o.thr; delete o.p0; delete o.p1; return o; });
  delete R.ctx;
  ds.PRED_R={v:R, asof:R.asof, label:'Trading model outputs (signals, regime, recession odds, calls). Derived from daily closes; raw index levels are not published.', tier:'daily'};
  const pn=ds.PRED_NOTE; if(pn&&pn.v&&pn.v.summary){ /* summary is prose built from derived numbers; keep */ }
  notes.push(`PRED_R: model ${R.version} as of ${R.asof}, ${R.log.length} calls`);
}

// ---- weekly recaps (every written week)
const wk={}; const ids=Object.keys(weekly).sort();
ids.forEach(id=>{ const d=weekly[id]; if(d&&(d.summary||d.items)) wk[id]=d; });

// ---- strip data-vendor attributions left in prose (the facts are cited to their original publishers)
const scrub=x=>typeof x==='string'?x.replace(/\s*\((?:via )?FMP\)/g,'').replace(/\s*\/\s*FMP\b/g,'').replace(/\s+via FMP\b/g,'').replace(/\bFMP\b\s*\/\s*/g,'')
  :Array.isArray(x)?x.map(scrub):(x&&typeof x==='object')?Object.fromEntries(Object.entries(x).map(([k,v])=>[k,scrub(v)])):x;
for(const k of Object.keys(ds)) if(k!=='PRED_R') ds[k]=scrub(ds[k]);
for(const k of Object.keys(cm)) cm[k]=scrub(cm[k]);
for(const k of Object.keys(wk)) wk[k]=scrub(wk[k]);
const dy={}; Object.keys(daily).sort().forEach(id=>{ const d=daily[id]; if(d&&(d.summary||d.headline)) dy[id]=scrub(d); });
{ const left=(JSON.stringify({ds,cm,wk,dy}).match(/.{0,60}\bFMP\b.{0,30}/g)||[]); if(left.length) notes.push('note: FMP still mentioned '+left.length+'x, e.g. '+left[0]); }

// ---- privacy check
const out={ds,cm,weekly:wk,daily:dy};
const text=JSON.stringify(out);
const BAD=[/trig_[A-Za-z0-9]{8,}/,/claude\.ai\/(code\/)?artifact/i,/jakemullaney/i,/requestedBy/];
const hit=BAD.find(re=>re.test(text)); if(hit){ console.error('privacy check failed: '+hit); process.exit(1); }

fs.mkdirSync(path.join(site,'data'),{recursive:true});
for(const [k,v] of Object.entries(out)) fs.writeFileSync(path.join(site,'data',k+'.json'),JSON.stringify(v));
const stamp=Object.values(ds).map(x=>x&&x.asof).filter(Boolean).sort().pop();
fs.writeFileSync(path.join(site,'data','build.json'),JSON.stringify({built:new Date().toISOString(),dataThrough:stamp,datasets:Object.keys(ds).length}));
console.log(notes.join('\n')); console.log(`wrote ${Object.keys(ds).length} datasets, ${Object.keys(cm).length} commentary blocks, ${Object.keys(wk).length} weekly recaps, ${Object.keys(dy).length} daily wraps`);
