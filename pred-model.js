/* TPI Predictions & Trading model, v1.
   One file, used by the dashboard page (window.PredModel) and by the weekday refresh (node).
   Inputs:
     PX  = { d: [ISO dates ascending], s: { GSPC, IXIC, RUT, VIX, BRENT, GOLD, EURUSD, T3M, T2Y, T10, T30 } }
           each series is an array aligned to d (null where missing)
     ext = { hy: high-yield spread in bp (number|null), hyAsof, fw: FW_PATH rows [[label, prob], ...] }
   Everything here is transparent rules, not a fitted model. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PredModel = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const VERSION = '1.1';
  const CFG = {
    smaLong: 218,          // TQQQ: Nasdaq BELOW this average = downtrend (buy zone)
    emaFast: 21,           // TQQQ: EMA turning down = direction rolling over
    emaSlopeDays: 5,       // EMA is "turning down" when today's EMA is below its value this many sessions ago
    vixElevated: 25,       // TQQQ: fear threshold to start accumulating
    vixExtreme: 30,        // TQQQ: extreme fear, add heavier
    rsiHot: 77,            // SQQQ tactical trigger
    rsiCold: 30
  };

  // ---------- helpers
  const isNum = v => typeof v === 'number' && isFinite(v);
  const clamp = (x, lo = -1, hi = 1) => Math.max(lo, Math.min(hi, x));
  function lastIdx(a, upto) { for (let i = (upto == null ? a.length - 1 : upto); i >= 0; i--) if (isNum(a[i])) return i; return -1; }
  function valAt(a, i) { const j = lastIdx(a, i); return j < 0 ? null : a[j]; }
  function back(a, i, k) { // value k trading rows before row i (using last valid at or before)
    const j = i - k; if (j < 0) return null; return valAt(a, j);
  }
  function pct(a, i, k) { const now = valAt(a, i), then = back(a, i, k); return isNum(now) && isNum(then) && then ? now / then - 1 : null; }
  function smaAt(a, n, i) {
    let s = 0, c = 0;
    for (let j = i; j >= 0 && c < n; j--) { if (isNum(a[j])) { s += a[j]; c++; } }
    return c === n ? s / n : null;
  }
  function emaSeries(a, n) {
    const out = new Array(a.length).fill(null), k = 2 / (n + 1); let e = null, seed = [], started = false;
    for (let i = 0; i < a.length; i++) {
      const v = a[i]; if (!isNum(v)) { out[i] = e; continue; }
      if (!started) { seed.push(v); if (seed.length === n) { e = seed.reduce((x, y) => x + y, 0) / n; started = true; } }
      else e = v * k + e * (1 - k);
      out[i] = started ? e : null;
    }
    return out;
  }
  function macdSeries(a) {
    const e12 = emaSeries(a, 12), e26 = emaSeries(a, 26);
    const line = a.map((_, i) => isNum(e12[i]) && isNum(e26[i]) ? e12[i] - e26[i] : null);
    const sig = emaSeries(line, 9);
    return { line, sig, hist: line.map((v, i) => isNum(v) && isNum(sig[i]) ? v - sig[i] : null) };
  }
  function rsiSeries(a, n = 14) { // Wilder
    const out = new Array(a.length).fill(null); let ag = 0, al = 0, c = 0, prev = null;
    for (let i = 0; i < a.length; i++) {
      const v = a[i]; if (!isNum(v)) continue;
      if (prev != null) {
        const ch = v - prev, g = Math.max(ch, 0), l = Math.max(-ch, 0);
        if (c < n) { ag += g; al += l; c++; if (c === n) { ag /= n; al /= n; out[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al); } }
        else { ag = (ag * (n - 1) + g) / n; al = (al * (n - 1) + l) / n; out[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al); }
      }
      prev = v;
    }
    return out;
  }
  function normCdf(x) { // Abramowitz-Stegun 7.1.26
    const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
    const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x / 2);
    return x >= 0 ? (1 + y) / 2 : (1 - y) / 2;
  }
  function parseHy(bondKpi) {
    if (!Array.isArray(bondKpi)) return null;
    const row = bondKpi.find(r => /high-?yield spread/i.test(r[0] || ''));
    const m = row && String(row[1]).match(/([\d.]+)/); return m ? +m[1] : null;
  }
  function addTradingDays(iso, n) { // calendar estimate, skips weekends only
    const d = new Date(iso + 'T12:00:00Z'); let k = 0;
    while (k < n) { d.setUTCDate(d.getUTCDate() + 1); const w = d.getUTCDay(); if (w !== 0 && w !== 6) k++; }
    return d.toISOString().slice(0, 10);
  }

  // EMA change over CFG.emaSlopeDays sessions, as a fraction (negative = turning down)
  function emaSlope(X, i) { const a = X.emaF[i], b = i - CFG.emaSlopeDays >= 0 ? X.emaF[i - CFG.emaSlopeDays] : null; return isNum(a) && isNum(b) && b ? a / b - 1 : null; }
  // Jake's four TQQQ accumulation conditions at row i
  function tqqqConds(PX, X, i) {
    const ix = valAt(PX.s.IXIC, i), sm = X.smaL[i], sl = emaSlope(X, i), ml = X.macd.line[i], vx = valAt(PX.s.VIX, i);
    return [
      { k: 'trend', name: 'Trend', label: `Nasdaq below its ${CFG.smaLong}-day average`, ok: isNum(sm) && isNum(ix) && ix < sm, val: isNum(sm) && isNum(ix) ? ix / sm - 1 : null },
      { k: 'ema', name: 'Direction', label: `${CFG.emaFast}-day EMA turning down`, ok: isNum(sl) && sl < 0, val: sl },
      { k: 'macd', name: 'Momentum', label: 'MACD below zero', ok: isNum(ml) && ml < 0, val: ml },
      { k: 'vix', name: 'Fear', label: `VIX at or above ${CFG.vixElevated}`, ok: isNum(vx) && vx >= CFG.vixElevated, val: vx }
    ];
  }

  // ---------- derived series (computed once per PX)
  function derive(PX) {
    const s = PX.s, n = PX.d.length;
    const sma200 = s.GSPC.map((_, i) => smaAt(s.GSPC, 200, i));
    const sma50 = s.GSPC.map((_, i) => smaAt(s.GSPC, 50, i));
    const smaL = s.IXIC.map((_, i) => smaAt(s.IXIC, CFG.smaLong, i));
    const emaF = emaSeries(s.IXIC, CFG.emaFast);
    const macd = macdSeries(s.IXIC);
    const rsi = rsiSeries(s.IXIC, 14);
    const curve = s.T10.map((v, i) => isNum(v) && isNum(s.T3M[i]) ? +(v - s.T3M[i]).toFixed(2) : null);
    const rel = s.RUT.map((v, i) => isNum(v) && isNum(s.GSPC[i]) ? v / s.GSPC[i] : null);
    return { n, sma200, sma50, smaL, emaF, macd, rsi, curve, rel };
  }

  // ---------- regime components
  function regimeAt(PX, X, i, ext) {
    const s = PX.s, C = [];
    const add = (key, name, w, value, fmt, score, read) => C.push({ key, name, w, value, fmt, score: isNum(score) ? +clamp(score).toFixed(3) : null, read });
    const g = valAt(s.GSPC, i), m200 = X.sma200[i];
    const dist = isNum(g) && isNum(m200) ? g / m200 - 1 : null;
    add('trend', 'S&P 500 vs 200-day average', 0.20, dist, 'pct', isNum(dist) ? dist / 0.05 : null,
      dist == null ? 'Not enough history' : dist > 0.02 ? 'Uptrend intact' : dist > -0.02 ? 'Sitting on the trend line' : 'Below trend');
    const m1 = pct(s.GSPC, i, 21);
    add('mom', 'S&P 500, 1-month change', 0.10, m1, 'pct', isNum(m1) ? m1 / 0.04 : null,
      m1 == null ? '' : m1 > 0.02 ? 'Positive momentum' : m1 > -0.02 ? 'Flat' : 'Losing momentum');
    const vix = valAt(s.VIX, i);
    add('vol', 'VIX', 0.20, vix, 'num', isNum(vix) ? (20 - vix) / 7 : null,
      vix == null ? '' : vix < 15 ? 'Calm, complacent' : vix < 20 ? 'Normal' : vix < 27 ? 'Elevated' : 'Stress');
    const hy = ext && isNum(ext.hy) ? ext.hy : null;
    add('credit', 'High-yield spread', 0.15, hy, 'bp', isNum(hy) ? (400 - hy) / 150 : null,
      hy == null ? 'No reading' : hy < 300 ? 'Very tight, no stress' : hy < 400 ? 'Tight, no stress' : hy < 550 ? 'Widening' : 'Credit stress');
    const r3 = (() => { const a = pct(s.RUT, i, 63), b = pct(s.GSPC, i, 63); return isNum(a) && isNum(b) ? a - b : null; })();
    add('breadth', 'Small caps vs S&P 500, 3 months', 0.10, r3, 'pct', isNum(r3) ? r3 / 0.05 : null,
      r3 == null ? '' : r3 > 0.02 ? 'Broad rally' : r3 > -0.03 ? 'In line' : 'Narrow market, small caps lagging');
    const t10 = valAt(s.T10, i), t10b = back(s.T10, i, 21), dT = isNum(t10) && isNum(t10b) ? Math.round((t10 - t10b) * 100) : null;
    add('rates', '10-year yield, 1-month change', 0.10, dT, 'bpch', isNum(dT) ? -dT / 40 : null,
      dT == null ? '' : dT > 15 ? 'Rates pushing higher' : dT < -15 ? 'Rates easing' : 'Range-bound');
    const oil = pct(s.BRENT, i, 63);
    add('energy', 'Brent crude, 3-month change', 0.10, oil, 'pct', isNum(oil) ? -oil / 0.3 : null,
      oil == null ? '' : oil > 0.2 ? 'Energy shock' : oil > 0.05 ? 'Firm' : oil > -0.1 ? 'Stable' : 'Falling');
    const eur = pct(s.EURUSD, i, 63);
    add('dollar', 'Dollar, 3 months (via EUR/USD)', 0.05, isNum(eur) ? -eur : null, 'pct', isNum(eur) ? eur / 0.03 : null,
      eur == null ? '' : eur < -0.015 ? 'Dollar strengthening, tighter conditions' : eur > 0.015 ? 'Dollar weakening, looser conditions' : 'Dollar steady');
    let ws = 0, wt = 0; C.forEach(c => { if (isNum(c.score)) { ws += c.w * c.score; wt += c.w; } });
    const score = wt ? Math.round(50 + 50 * ws / wt) : null;
    const label = score == null ? 'No reading' : score >= 65 ? 'Supportive' : score >= 50 ? 'Mixed' : score >= 35 ? 'Fragile' : 'Stressed';
    return { score, label, components: C, coverage: +wt.toFixed(2) };
  }

  // ---------- hypothesis rules
  // cond(PX, X, i, ctx) -> boolean; each claim is checked against prices h trading days later.
  const RULES = [
    { id: 'vix_spike', sym: 'GSPC', dir: 'up', h: 10, thr: 0, conf: 0.6,
      name: 'Volatility spike inside an uptrend',
      text: c => `VIX jumped ${c.vixJump}% to ${c.vix} while the S&P 500 holds above its 200-day average. The rule bets the spike fades. Expect the S&P 500 to be higher in 10 trading days.`,
      cond: (PX, X, i) => { const v = PX.s.VIX, j = pct(v, i, 1), g = valAt(PX.s.GSPC, i); return isNum(j) && j >= 0.15 && valAt(v, i) >= 18 && isNum(X.sma200[i]) && g > X.sma200[i]; } },
    { id: 'tqqq_entry', sym: 'IXIC', dir: 'up', h: 20, thr: 0, conf: 0.6,
      name: 'TQQQ accumulation: all four bear-market conditions met',
      text: c => `Nasdaq is below its ${CFG.smaLong}-day average, the ${CFG.emaFast}-day EMA is falling, MACD is negative and VIX is ${c.vix}. All four TQQQ accumulation conditions are met. Expect the Nasdaq to be higher in 20 trading days.`,
      cond: (PX, X, i) => tqqqConds(PX, X, i).every(c => c.ok) },
    { id: 'dip_uptrend', sym: 'IXIC', dir: 'up', h: 20, thr: 0, conf: 0.55,
      name: 'Pullback inside the long-term uptrend',
      text: () => `Nasdaq is above its ${CFG.smaLong}-day average but MACD has turned negative, a pullback inside the trend. Expect the Nasdaq to be higher in 20 trading days.`,
      cond: (PX, X, i) => { const p = valAt(PX.s.IXIC, i); return isNum(X.smaL[i]) && p > X.smaL[i] && isNum(X.macd.line[i]) && X.macd.line[i] < 0 && !(valAt(PX.s.VIX, i) >= CFG.vixElevated); } },
    { id: 'overbought', sym: 'IXIC', dir: 'down', h: 15, thr: 0, conf: 0.55,
      name: 'SQQQ trigger: Nasdaq overbought',
      text: c => `Nasdaq 14-day RSI is ${c.rsi}, above ${CFG.rsiHot}. Expect the Nasdaq to be lower in 15 trading days (the SQQQ window is capped at 2–3 weeks).`,
      cond: (PX, X, i) => isNum(X.rsi[i]) && X.rsi[i] > CFG.rsiHot },
    { id: 'oversold', sym: 'IXIC', dir: 'up', h: 10, thr: 0, conf: 0.6,
      name: 'Nasdaq oversold',
      text: c => `Nasdaq 14-day RSI is ${c.rsi}, below ${CFG.rsiCold}. Expect a bounce: Nasdaq higher in 10 trading days.`,
      cond: (PX, X, i) => isNum(X.rsi[i]) && X.rsi[i] < CFG.rsiCold },
    { id: 'smallcap_lag', sym: 'REL', dir: 'down', h: 20, thr: 0, conf: 0.55,
      name: 'Small caps keep lagging while the 10-year sits above 5%',
      text: c => `Small caps trail the S&P 500 by ${c.relGap} points over 3 months with the 10-year at ${c.t10}%. Floating-rate borrowers stay squeezed. Expect the Russell 2000 to keep underperforming the S&P 500 over 20 trading days.`,
      cond: (PX, X, i) => { const a = pct(PX.s.RUT, i, 63), b = pct(PX.s.GSPC, i, 63); return isNum(a) && isNum(b) && a - b < -0.05 && valAt(PX.s.T10, i) >= 5.0; } },
    { id: 'risk_off', sym: 'GSPC', dir: 'down', h: 20, thr: 0, conf: 0.55,
      name: 'Regime score in Stressed territory',
      text: c => `The regime score fell to ${c.score}. Expect the S&P 500 to be lower in 20 trading days.`,
      cond: (PX, X, i, ctx) => ctx && ctx.score != null && ctx.score < 35 },
    { id: 'risk_on', sym: 'GSPC', dir: 'up', h: 20, thr: 0, conf: 0.6,
      name: 'Regime score firmly Supportive',
      text: c => `The regime score rose to ${c.score}. Expect the S&P 500 to be higher in 20 trading days.`,
      cond: (PX, X, i, ctx) => ctx && ctx.score != null && ctx.score >= 70 }
  ];
  const SYMNAME = { GSPC: 'S&P 500', IXIC: 'Nasdaq Composite', RUT: 'Russell 2000', REL: 'Russell 2000 vs S&P 500', T10: '10-year yield' };

  function symSeries(PX, X, sym) { return sym === 'REL' ? X.rel : PX.s[sym]; }

  // In-sample check: first day of each streak where the rule fired, scored h days later.
  function backtest(PX, X, rule) {
    if (rule.cond.length > 3) return null; // regime rules need history of credit data we do not keep
    const a = symSeries(PX, X, rule.sym); let n = 0, hit = 0, prev = false; const last = PX.d.length - 1;
    for (let i = 1; i <= last; i++) {
      let c = false; try { c = !!rule.cond(PX, X, i); } catch (e) { c = false; }
      if (c && !prev && i + rule.h <= last) {
        const p0 = valAt(a, i), p1 = valAt(a, i + rule.h);
        if (isNum(p0) && isNum(p1)) { n++; const ch = p1 / p0 - 1; if (rule.dir === 'up' ? ch > rule.thr : ch < -rule.thr) hit++; }
      }
      prev = c;
    }
    return { n, hit };
  }

  function grade(PX, X, hyp) {
    const i0 = PX.d.indexOf(hyp.made); const a = symSeries(PX, X, hyp.sym);
    if (i0 < 0) return { status: 'pending', change: null };
    const iEnd = i0 + hyp.h, last = PX.d.length - 1, iNow = Math.min(iEnd, last);
    const p0 = isNum(hyp.base) ? hyp.base : valAt(a, i0), pNow = valAt(a, iNow);
    const change = isNum(p0) && isNum(pNow) ? pNow / p0 - 1 : null;
    if (iEnd > last) return { status: 'open', change, daysLeft: iEnd - last };
    const ok = hyp.dir === 'up' ? change > (hyp.thr || 0) : change < -(hyp.thr || 0);
    return { status: ok ? 'hit' : 'miss', change, resolved: PX.d[iEnd] };
  }

  // ---------- main
  function compute(PX, ext, log) {
    const s = PX.s, X = derive(PX), i = PX.d.length - 1, asof = PX.d[i];
    const reg = regimeAt(PX, X, i, ext);

    // recession odds: NY Fed-style probit on the 10y minus 3m spread (12 months ahead)
    const spread = X.curve[lastIdx(X.curve, i)];
    const pRec = isNum(spread) ? normCdf(-0.5333 - 0.6330 * spread) : null;
    let minSp = null, minDate = null;
    for (let j = Math.max(0, i - 252); j <= i; j++) if (isNum(X.curve[j]) && (minSp == null || X.curve[j] < minSp)) { minSp = X.curve[j]; minDate = PX.d[j]; }
    const sp3m = back(X.curve, i, 63);

    // rates
    const t10 = valAt(s.T10, i), t2 = valAt(s.T2Y, i), t30 = valAt(s.T30, i), t3m = valAt(s.T3M, i);
    const d5 = isNum(back(s.T10, i, 5)) ? Math.round((t10 - back(s.T10, i, 5)) * 100) : null;
    const d21 = isNum(back(s.T10, i, 21)) ? Math.round((t10 - back(s.T10, i, 21)) * 100) : null;
    const d63 = isNum(back(s.T10, i, 63)) ? Math.round((t10 - back(s.T10, i, 63)) * 100) : null;
    const avg20 = smaAt(s.T10, 20, i), avg60 = smaAt(s.T10, 60, i);
    let lean = 'Range-bound', leanWhy = '10-year is near its 20-day and 60-day averages.';
    if (isNum(avg20) && isNum(avg60)) {
      if (t10 > avg20 && avg20 > avg60 && d21 > 10) { lean = 'Drifting higher'; leanWhy = '10-year is above a rising 20-day average.'; }
      else if (t10 < avg20 && avg20 < avg60 && d21 < -10) { lean = 'Drifting lower'; leanWhy = '10-year is below a falling 20-day average.'; }
      else if (t10 < avg20 && d5 <= -8) { lean = 'Pulling back'; leanWhy = `10-year fell ${-d5} bp in a week but the 60-day trend is still ${avg20 > avg60 ? 'up' : 'flat'}.`; }
      else if (t10 > avg20 && d5 >= 8) { lean = 'Pushing higher'; leanWhy = `10-year rose ${d5} bp in a week.`; }
    }
    const fw = (ext && Array.isArray(ext.fw)) ? ext.fw.filter(r => r[0] !== 'Now').slice(0, 4) : [];

    // TQQQ / SQQQ signals
    const ix = valAt(s.IXIC, i), smaL = X.smaL[i], ml = X.macd.line[i], ms = X.macd.sig[i], r = X.rsi[i], vix = valAt(s.VIX, i);
    const ema = X.emaF[i], slope = emaSlope(X, i);
    const conds = tqqqConds(PX, X, i);
    const nMet = conds.filter(c => c.ok).length;
    const entryMet = nMet === 4;
    // stop adding once trend, direction and momentum have all neutralized
    const neutral = isNum(smaL) && ix > smaL && isNum(slope) && slope > 0 && isNum(ml) && ml > 0;
    const state = entryMet ? (vix >= CFG.vixExtreme ? 'accumulate_heavy' : 'accumulate') : nMet === 3 ? 'watch' : neutral ? 'hold' : 'wait';
    const sqqq = { ok: isNum(r) && r > CFG.rsiHot, rsi: r };
    // sessions on the current side of the 218-day average
    let streak = 0; for (let j = i; j >= 0; j--) { const a = valAt(s.IXIC, j), b = X.smaL[j]; if (!isNum(b)) break; if ((a > b) === (ix > smaL)) streak++; else break; }
    // last date all four conditions were met
    let lastEntry = null; for (let j = i; j >= 0; j--) { if (!isNum(X.smaL[j])) break; if (tqqqConds(PX, X, j).every(c => c.ok)) { lastEntry = PX.d[j]; break; } }

    // context for rule text
    const ctx = {
      score: reg.score, vix: isNum(vix) ? vix.toFixed(1) : '', rsi: isNum(r) ? r.toFixed(0) : '',
      vixJump: isNum(pct(s.VIX, i, 1)) ? Math.round(pct(s.VIX, i, 1) * 100) : '',
      t10: isNum(t10) ? t10.toFixed(2) : '',
      relGap: (() => { const a = pct(s.RUT, i, 63), b = pct(s.GSPC, i, 63); return isNum(a) && isNum(b) ? ((b - a) * 100).toFixed(1) : ''; })()
    };

    const rules = RULES.map(R => {
      let firing = false; try { firing = !!R.cond(PX, X, i, ctx); } catch (e) {}
      return { id: R.id, name: R.name, sym: R.sym, dir: R.dir, h: R.h, conf: R.conf, firing, bt: backtest(PX, X, R) };
    });

    // grade the log
    const graded = (log || []).map(h => Object.assign({}, h, grade(PX, X, h)));
    const done = graded.filter(h => h.status === 'hit' || h.status === 'miss');
    const score = { total: graded.length, open: graded.filter(h => h.status === 'open' || h.status === 'pending').length,
      resolved: done.length, hits: done.filter(h => h.status === 'hit').length };

    // chart series
    const tail = (a, k) => a.slice(Math.max(0, a.length - k));
    const charts = {
      ixic: { d: tail(PX.d, 130), p: tail(s.IXIC, 130), sma: tail(X.smaL, 130), ema: tail(X.emaF, 130) },
      ema: { d: tail(PX.d, 65), p: tail(s.IXIC, 65), ema: tail(X.emaF, 65) },
      macd: { d: tail(PX.d, 130), line: tail(X.macd.line, 130), sig: tail(X.macd.sig, 130), hist: tail(X.macd.hist, 130) },
      vix: { d: tail(PX.d, 130), v: tail(s.VIX, 130) },
      rsi: { d: tail(PX.d, 130), v: tail(X.rsi, 130) },
      curve: { d: tail(PX.d, 260), v: tail(X.curve, 260) },
      regime: (() => { const out = []; for (let j = Math.max(0, i - 125); j <= i; j++) { const rr = regimeAt(PX, X, j, ext); out.push([PX.d[j], rr.score, rr.coverage]); } return out; })()
    };

    return {
      version: VERSION, asof, cfg: CFG,
      regime: reg,
      recession: { p: pRec, spread, spread3mAgo: sp3m, minSpread12m: minSp, minDate },
      rates: { t3m, t2, t10, t30, d5, d21, d63, avg20, avg60, lean, leanWhy, fw },
      signals: { ix, smaL, ema, emaSlope: slope, macd: ml, macdSig: ms, hist: X.macd.hist[i], rsi: r, vix, conds, nMet, entryMet, neutral, state, lastEntry, sqqq, streak },
      rules, log: graded, score, charts, ctx
    };
  }

  // New hypotheses for the latest row: rules firing today with no open hypothesis from the same rule.
  function newHypotheses(PX, ext, log) {
    const res = compute(PX, ext, log), X = derive(PX), i = PX.d.length - 1, out = [];
    const openRules = new Set(res.log.filter(h => h.status === 'open' || h.status === 'pending').map(h => h.rule));
    for (const R of RULES) {
      const f = res.rules.find(r => r.id === R.id);
      if (!f || !f.firing || openRules.has(R.id)) continue;
      const a = symSeries(PX, X, R.sym), base = valAt(a, i);
      out.push({ id: R.id + ':' + PX.d[i], rule: R.id, made: PX.d[i], name: R.name, text: R.text(res.ctx), sym: R.sym, dir: R.dir,
        h: R.h, thr: R.thr, base: isNum(base) ? +base.toFixed(R.sym === 'REL' ? 6 : 2) : null, conf: R.conf,
        bt: f.bt, due: addTradingDays(PX.d[i], R.h) });
    }
    return out;
  }

  return { VERSION, CFG, RULES, SYMNAME, compute, newHypotheses, parseHy, derive };
});
