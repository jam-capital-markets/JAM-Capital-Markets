/* JAM Predictions & Trading model, v2 (v1 rules + v2 forecast engine).
   One file, used by the dashboard page (window.PredModel) and by the weekday refresh (node).
   Inputs:
     PX  = { d: [ISO dates ascending], s: { GSPC, IXIC, RUT, VIX, BRENT, GOLD, EURUSD, T3M, T2Y, T10, T30 } }
           each series is an array aligned to d (null where missing)
     ext = { hy: high-yield spread in bp (number|null), hyAsof, fw: FW_PATH rows [[label, prob], ...],
             cal: ds/PRED_CAL (v2 calibration, optional), macro: ds/PRED_MACRO (v2 monthly macro inputs, optional) }
   v1 parts are transparent rules. v2 parts use constants fitted offline and scored walk-forward (see PRED_CAL). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PredModel = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const VERSION = '2.0';
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
  // realized volatility: std of daily log returns over n sessions, annualized, in vol points (like VIX)
  function rvSeries(a, n = 21) {
    const out = new Array(a.length).fill(null), r = a.map((v, i) => i && isNum(v) && isNum(a[i - 1]) && a[i - 1] > 0 ? Math.log(v / a[i - 1]) : null);
    for (let i = n; i < a.length; i++) {
      const w = r.slice(i - n + 1, i + 1).filter(isNum); if (w.length < n - 2) continue;
      const m = w.reduce((x, y) => x + y, 0) / w.length, v = w.reduce((x, y) => x + (y - m) ** 2, 0) / (w.length - 1);
      out[i] = Math.sqrt(v * 252) * 100;
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
    // v2: per-index series for the tactical-state engine
    const gRsi = rsiSeries(s.GSPC, 14), gRv = rvSeries(s.GSPC, 21), nRv = rvSeries(s.IXIC, 21);
    const nSma200 = s.IXIC.map((_, i) => smaAt(s.IXIC, 200, i));
    return { n, sma200, sma50, smaL, emaF, macd, rsi, curve, rel,
      ix: { GSPC: { sma200, rsi: gRsi, rv: gRv }, IXIC: { sma200: nSma200, rsi, rv: nRv } } };
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
      cond: (PX, X, i, ctx) => ctx && ctx.score != null && ctx.score >= 70 },
    { id: 'tac_washout', sym: 'GSPC', dir: 'up', h: 21, thr: 0, conf: 0.75, lt: ['washout', 'h21'],
      name: 'Forecast engine: washout inside an uptrend',
      text: c => `The S&P 500 is above its 200-day average but just had a sharp shakeout (${c.tacWhy}). This state beat the normal odds in every period tested since 1991 (up a month later 67–79% of the time). Expect the S&P 500 to be higher in 21 trading days.`,
      cond: (PX, X, i) => tacStateAt(PX, X, 'GSPC', i) === 'washout' }
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

  // =====================================================================================
  // v2 FORECAST ENGINE
  // Short term (1 week to 3 months): tactical market state + volatility-calibrated ranges.
  // Long term (12 months to 10 years): multi-factor recession model, growth/inflation regime, CAPE valuation.
  // All constants come from ds/PRED_CAL, which is built offline from 2007-2026 daily data and 1960-2026 FRED-MD,
  // with every model scored walk-forward (only data available at the time). See the "How the forecasts are built" section.
  // =====================================================================================
  const TAC = { fear: 25, vrp: 6, wash5: -0.03, rsiLo: 30, stretch: 0.08 };
  const TAC_INFO = {
    capitulation: { label: 'Capitulation', tone: 'neutral', short: 'Below the 200-day average with VIX 25+',
      what: 'A fear-driven break: the index is under its long-term trend and options are pricing real stress. Odds a month out have been about normal to slightly better, three months out mixed, and the swings are very wide. No reliable edge either way.' },
    quiet_downtrend: { label: 'Quiet downtrend', tone: 'bad', short: 'Below the 200-day average with VIX under 25',
      what: 'A slow bleed without panic. This was the weakest state in every period tested (1991–2006, 2007–16, 2017–26): about a coin flip a month out with a negative average return. Quiet breakdowns tend to keep leaking until fear finally shows up.' },
    washout: { label: 'Washout in an uptrend', tone: 'good', short: 'Above the 200-day average after a sharp drop, RSI under 30 or VIX 25+',
      what: 'A shakeout inside a healthy trend. This beat the normal odds in every period tested since 1991, and by the most at three months (up 85% of the time vs about 70% normally).' },
    fear_priced: { label: 'Uptrend, fear priced in', tone: 'neutral', short: 'Above the 200-day average, VIX at least 6 points over realized volatility',
      what: 'Options are charging an unusually high premium for protection while the market itself is calm. That premium has tended to be paid back to stock holders: odds slightly better than normal in every period tested.' },
    stretched: { label: 'Stretched', tone: 'neutral', short: 'More than 8% above the 200-day average',
      what: 'The trend is strong but extended. Since 2007 returns were below normal, but in 1991–2006 they were above normal, so there is no reliable edge. Pullbacks to the average are common.' },
    steady: { label: 'Steady uptrend', tone: 'neutral', short: 'Above the 200-day average, no stress and not extended',
      what: 'The most common state. Odds and returns sit close to the long-run average for stocks.' }
  };
  function tacInputs(PX, X, sym, i) {
    const s = PX.s[sym], p = valAt(s, i), Z = X.ix[sym], sma = Z.sma200[i], vix = valAt(PX.s.VIX, i), rv = Z.rv[i], r5 = pct(s, i, 5), rsi = Z.rsi[i];
    return { p, sma, trend: isNum(p) && isNum(sma) ? p / sma - 1 : null, vix, rv, vrp: isNum(vix) && isNum(rv) ? vix - rv : null, ret5: r5, rsi };
  }
  function tacStateAt(PX, X, sym, i) {
    const t = tacInputs(PX, X, sym, i);
    if (!isNum(t.trend) || !isNum(t.vix)) return null;
    const below = t.trend < 0, fear = t.vix >= TAC.fear, wash = (isNum(t.ret5) && t.ret5 < TAC.wash5) || (isNum(t.rsi) && t.rsi < TAC.rsiLo);
    if (below) return fear ? 'capitulation' : 'quiet_downtrend';
    if (wash || fear) return 'washout';
    if (isNum(t.vrp) && t.vrp >= TAC.vrp) return 'fear_priced';
    if (t.trend > TAC.stretch) return 'stretched';
    return 'steady';
  }
  const sig = x => 1 / (1 + Math.exp(-x));
  function lastNum(a) { for (let i = a.length - 1; i >= 0; i--) if (isNum(a[i])) return i; return -1; }
  function ffill(a) { let l = null; return a.map(v => isNum(v) ? (l = v) : l); }
  function monthAdd(ym, k) { let [y, m] = ym.split('-').map(Number); m += k; while (m > 12) { m -= 12; y++; } while (m < 1) { m += 12; y--; } return `${y}-${String(m).padStart(2, '0')}`; }

  function forecast(PX, X, i, ext, regScore) {
    const cal = ext && ext.cal, mac = ext && ext.macro; if (!cal || !cal.tac) return null;
    const asof = PX.d[i], out = { ver: cal.ver, built: cal.built, asof };
    // ---------- short term: state + ranges for each index
    const g = tacInputs(PX, X, 'GSPC', i);
    // Nasdaq vol relative to S&P over ~3 months scales the VIX-based range for the Nasdaq
    const rvRatio = (() => { const a = [], b = []; for (let j = Math.max(0, i - 62); j <= i; j++) { if (isNum(X.ix.IXIC.rv[j]) && isNum(X.ix.GSPC.rv[j])) { a.push(X.ix.IXIC.rv[j]); b.push(X.ix.GSPC.rv[j]); } }
      return a.length > 10 ? a.reduce((x, y) => x + y, 0) / b.reduce((x, y) => x + y, 0) : 1.25; })();
    out.tac = {};
    for (const sym of ['GSPC', 'IXIC']) {
      const t = tacInputs(PX, X, sym, i), st = tacStateAt(PX, X, sym, i);
      if (!st) { out.tac[sym] = null; continue; }
      const S = cal.tac.states[st], volMult = sym === 'IXIC' ? rvRatio : 1, ranges = {};
      for (const h of [5, 21, 63]) {
        const V = cal.vol['h' + h], base = (isNum(g.vix) ? g.vix : 18) / 100 * Math.sqrt(h / 252) * volMult;
        const s68 = V.k68 * base, s90 = 1.645 * V.k90 * base;
        ranges['h' + h] = { s68, s90, lo68: t.p * Math.exp(-s68), hi68: t.p * Math.exp(s68), lo90: t.p * Math.exp(-s90), hi90: t.p * Math.exp(s90) };
      }
      // streak in the current state
      let streak = 0; for (let j = i; j >= 0; j--) { if (tacStateAt(PX, X, sym, j) === st) streak++; else break; }
      out.tac[sym] = { sym, state: st, info: TAC_INFO[st], inputs: t, stats: S, base: cal.tac.base, ranges, streak, volMult };
    }
    // ---------- long term: recession model
    if (mac && mac.m && mac.s && cal.rec) {
      const M = mac.m, s = mac.s, n = M.length, R = cal.rec;
      const ff = k => ffill(s[k] || []);
      const U = ff('UNRATE'), PER = ff('PERMIT'), BAA = ff('BAA'), G10 = ff('GS10'), WTI = ff('WTI'), SPX = s.SPX || [];
      const last = k => { const a = ff(k); const j = lastNum(a); return j; };
      // Sahm gap: 3-month average unemployment vs its low over the prior 12 months
      const ju = last('UNRATE'); const u3 = U.map((_, j) => j >= 2 && isNum(U[j]) && isNum(U[j - 1]) && isNum(U[j - 2]) ? (U[j] + U[j - 1] + U[j - 2]) / 3 : null);
      let mn = Infinity; for (let j = Math.max(0, ju - 12); j <= ju; j++) if (isNum(u3[j])) mn = Math.min(mn, u3[j]);
      const sahm = isNum(u3[ju]) ? Math.min(u3[ju] - mn, 5) : null;
      const jc = Math.min(last('BAA'), last('GS10')); const cr = j => isNum(BAA[j]) && isNum(G10[j]) ? BAA[j] - G10[j] : null;
      const dcredit = jc >= 6 && isNum(cr(jc)) && isNum(cr(jc - 6)) ? cr(jc) - cr(jc - 6) : null;
      const jp = last('PERMIT'); const permits = jp >= 12 && PER[jp] > 0 && PER[jp - 12] > 0 ? Math.log(PER[jp] / PER[jp - 12]) : null;
      const jo = last('WTI'); let omax = -Infinity; for (let j = Math.max(0, jo - 36); j < jo; j++) if (isNum(WTI[j])) omax = Math.max(omax, WTI[j]);
      const oil = isNum(WTI[jo]) && omax > 0 ? Math.max(0, Math.log(WTI[jo] / omax)) : null;
      // The model was fitted on FRED's monthly GS10 minus TB3MS. The daily feed (10-year minus 3-month CMT) runs on a slightly
      // different basis, so the daily spread is shifted by the average gap between the two over the latest overlapping months.
      const curveDaily = X.curve[lastIdx(X.curve, i)];
      const curveBasis = (() => { const by = {}; PX.d.forEach((d, j) => { const c = X.curve[j]; if (!isNum(c)) return; const k = d.slice(0, 7); (by[k] = by[k] || []).push(c); });
        const G = ff('GS10'), B3 = s.TB3MS || [], gaps = [];
        for (let j = M.length - 1; j >= 0 && gaps.length < 6; j--) { const a = by[M[j]]; if (!a || a.length < 10 || !isNum((s.GS10 || [])[j]) || !isNum(B3[j])) continue;
          gaps.push(a.reduce((x, y) => x + y, 0) / a.length - (s.GS10[j] - B3[j])); }
        return gaps.length ? gaps.reduce((x, y) => x + y, 0) / gaps.length : 0; })();
      const curve = isNum(curveDaily) ? curveDaily - curveBasis : null;
      const m6 = monthAdd(asof.slice(0, 7), -6), k6 = M.indexOf(m6), spxNow = valAt(PX.s.GSPC, i);
      const spx6 = k6 >= 0 && isNum(SPX[k6]) && isNum(spxNow) ? Math.log(spxNow / SPX[k6]) : null;
      const vals = { curve, sahm, dcredit, permits, spx6, oil };
      const NAMES = { curve: ['Yield curve', '10-year minus 3-month, pts', v => (v > 0 ? '+' : '') + v.toFixed(2)],
        sahm: ['Unemployment trend (Sahm gap)', '3-mo avg jobless rate vs 12-mo low, pts', v => '+' + v.toFixed(2)],
        dcredit: ['Credit spread, 6-month change', 'Moody’s Baa minus 10-year, pts', v => (v > 0 ? '+' : '') + v.toFixed(2)],
        permits: ['Building permits, 12-month change', 'housing leads the cycle', v => (v > 0 ? '+' : '') + (v * 100).toFixed(1) + '%'],
        spx6: ['S&P 500, 6-month change', 'markets price recessions early', v => (v > 0 ? '+' : '') + (v * 100).toFixed(1) + '%'],
        oil: ['Oil shock (WTI vs 3-year high)', 'Hamilton net oil price increase', v => v > 0 ? '+' + (v * 100).toFixed(1) + '% above' : 'No shock'] };
      let lo = R.b, ok = true; const contrib = [];
      R.feats.forEach((f, k) => { const v = vals[f]; if (!isNum(v)) { ok = false; return; } const z = (v - R.mu[k]) / R.sd[k], c = R.w[k] * z; lo += c;
        contrib.push({ key: f, name: NAMES[f][0], sub: NAMES[f][1], value: v, fmt: NAMES[f][2](v), z, c }); });
      const p = ok ? sig(lo) : null;
      const bucket = p == null ? null : R.buckets.find(b => p >= b.lo && p < b.hi);
      const hist = R.hist || (R.hv ? R.hv.map((v, k) => [monthAdd(R.hs, k), v]) : []);
      out.rec = { p, logit: lo, contrib, vals, bucket, buckets: R.buckets, oos: R.oos, oosCurve: R.oosCurve, hist, recessions: R.recessions,
        asofMacro: { UNRATE: M[ju], PERMIT: M[jp], BAA: M[jc], WTI: M[jo] }, curveDaily, curveBasis, curveOnly: isNum(curveDaily) ? normCdf(-0.5333 - 0.6330 * curveDaily) : null };
      // ---------- growth x inflation regime
      const IP = ff('INDPRO'), CPI = ff('CPI'), jg = last('INDPRO'), ji = last('CPI');
      const gr = IP.map((v, j) => j >= 6 && v > 0 && IP[j - 6] > 0 ? Math.log(v / IP[j - 6]) * 200 : null);
      const gwin = gr.slice(Math.max(0, jg - 59), jg + 1).filter(isNum);
      const yoy = CPI.map((v, j) => j >= 12 && v > 0 && CPI[j - 12] > 0 ? Math.log(v / CPI[j - 12]) * 100 : null);
      const i6 = ji >= 6 ? Math.log(CPI[ji] / CPI[ji - 6]) * 200 : null;
      const iwin = yoy.slice(Math.max(0, ji - 11), ji + 1).filter(isNum);
      if (gwin.length >= 48 && iwin.length >= 10 && isNum(gr[jg]) && isNum(i6)) {
        const gt = gwin.reduce((a, b) => a + b, 0) / gwin.length, it = iwin.reduce((a, b) => a + b, 0) / iwin.length;
        const up = gr[jg] > gt, hot = i6 > it;
        const name = up ? (hot ? 'Reflation' : 'Goldilocks') : (hot ? 'Stagflation' : 'Deflation');
        // the last 12 months of regime readings, for a strip
        const trail = []; for (let j = Math.max(12, jg - 11); j <= jg; j++) {
          const gw = gr.slice(Math.max(0, j - 59), j + 1).filter(isNum), iw = yoy.slice(Math.max(0, j - 11), j + 1).filter(isNum);
          if (gw.length < 36 || iw.length < 10 || !isNum(gr[j]) || !(CPI[j] > 0 && CPI[j - 6] > 0)) continue;
          const g2 = gw.reduce((a, b) => a + b, 0) / gw.length, i2 = iw.reduce((a, b) => a + b, 0) / iw.length, ii = Math.log(CPI[j] / CPI[j - 6]) * 200;
          trail.push([M[j], gr[j] > g2 ? (ii > i2 ? 'Reflation' : 'Goldilocks') : (ii > i2 ? 'Stagflation' : 'Deflation')]);
        }
        out.regime = { name, growth: gr[jg], gtrend: gt, infl: i6, itrend: it, month: M[jg], cpiMonth: M[ji], table: cal.regimes, trail };
      }
    }
    // ---------- 10-year valuation
    if (cal.cape) {
      const A = (mac && mac.cape) || cal.cape.anchor, spxNow = valAt(PX.s.GSPC, i);
      if (A && isNum(spxNow)) {
        const cape = A.cape * spxNow / A.spx, er = cal.cape.a + cal.cape.b * Math.log(cape);
        out.cape = { cape, anchor: A, real10: er, lo: er - cal.cape.sd, hi: er + cal.cape.sd, r2: cal.cape.r2, r2oos: cal.cape.r2oos, q: cal.cape.q, max: cal.cape.max };
      }
    }
    // ---------- horizon ladder
    const T = out.tac.GSPC, L = [];
    if (T) {
      const hs = [['1 week', 'h5'], ['1 month', 'h21'], ['3 months', 'h63']];
      for (const [lab, k] of hs) { const s2 = T.stats[k].all, b = cal.tac.base[k], r = T.ranges[k];
        L.push({ h: lab, key: k, up: s2.up, avg: s2.avg, baseUp: b.up, baseAvg: b.avg, n: s2.n, s68: r.s68, lo68: r.lo68, hi68: r.hi68, src: 'state' }); }
    }
    if (out.rec && out.rec.bucket) { const b = out.rec.bucket; L.push({ h: '12 months', key: 'h252', up: b.up, avg: b.avg, dd: b.dd, p10: b.p10, n: b.n, src: 'rec' }); }
    if (out.cape) L.push({ h: '10 years', key: 'h10y', real: out.cape.real10, lo: out.cape.lo, hi: out.cape.hi, src: 'cape' });
    out.ladder = L;
    return out;
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

    const fe = (() => { try { return forecast(PX, X, i, ext, reg.score); } catch (e) { return { error: String(e && e.message || e) }; } })();
    ctx.tacWhy = (() => { const t = tacInputs(PX, X, 'GSPC', i); const a = [];
      if (isNum(t.ret5) && t.ret5 < TAC.wash5) a.push(`down ${(-t.ret5 * 100).toFixed(1)}% in a week`);
      if (isNum(t.rsi) && t.rsi < TAC.rsiLo) a.push(`RSI ${t.rsi.toFixed(0)}`);
      if (isNum(t.vix) && t.vix >= TAC.fear) a.push(`VIX ${t.vix.toFixed(1)}`); return a.join(', ') || 'a sharp drop'; })();
    const ltOf = R => { const c = ext && ext.cal && ext.cal.tac; if (!R.lt || !c) return null; const st = c.states[R.lt[0]]; const x = st && st[R.lt[1]] && st[R.lt[1]].all;
      return x ? { n: x.n, up: x.up, from: c.sample[0].slice(0, 4), to: c.sample[1].slice(0, 4) } : null; };
    const rules = RULES.map(R => {
      let firing = false; try { firing = !!R.cond(PX, X, i, ctx); } catch (e) {}
      return { id: R.id, name: R.name, sym: R.sym, dir: R.dir, h: R.h, conf: R.conf, firing, bt: backtest(PX, X, R), lt: ltOf(R) };
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
      rules, log: graded, score, charts, ctx, fe
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
        bt: f.bt, lt: f.lt, due: addTradingDays(PX.d[i], R.h) });
    }
    return out;
  }

  return { VERSION, CFG, RULES, SYMNAME, TAC, TAC_INFO, compute, newHypotheses, parseHy, derive, tacStateAt };
});
