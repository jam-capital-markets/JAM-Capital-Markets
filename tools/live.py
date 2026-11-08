#!/usr/bin/env python3
"""JAM Capital Markets: live market widgets for the public page.

TradingView's free widgets are served from TradingView's servers under their own data licence, so live prices
reach visitors without this site fetching, storing or republishing any market data. Each widget carries
TradingView's credit link, which is the condition of using them for free.

  - Site-wide ticker: live index, commodity, currency and bitcoin quotes, plus daily Treasury yields
  - Capital markets tab: official daily Treasury yields (3-month to 30-year) above the Cost of capital chart
  - Trading tab: live S&P 500 / Nasdaq-100 / Dow 30 heat map in place of the end-of-day snapshot

usage (standalone): python3 live.py <page.html>        patches the page in place
from build_page.py:  s = live.patch(s)
"""
import json, sys

MARK = '<!-- jam:live-widgets -->'

TAPE = [  # proName, label
    ('FOREXCOM:SPXUSD', 'S&P 500'), ('FOREXCOM:NSXUSD', 'Nasdaq-100'), ('FOREXCOM:DJI', 'Dow 30'),
    ('FRED:DGS2', '2-yr Treasury'), ('FRED:DGS10', '10-yr Treasury'), ('FRED:DGS30', '30-yr Treasury'),
    ('TVC:UKOIL', 'Brent crude'), ('TVC:GOLD', 'Gold'), ('FX_IDC:EURUSD', 'EUR/USD'), ('BITSTAMP:BTCUSD', 'Bitcoin'),
]
# TradingView's live yield symbols (TVC:US10Y etc.) are not licensed for free widgets; FRED's official daily
# H.15 closes are, and TradingView updates them each business day.
YIELDS = [('FRED:DGS3MO', '3-mo T-bill'), ('FRED:DGS2', '2-yr Treasury'), ('FRED:DGS5', '5-yr Treasury'),
          ('FRED:DGS10', '10-yr Treasury'), ('FRED:DGS30', '30-yr Treasury')]
HEAT = {'sp': 'SPX500', 'nq': 'NASDAQ100', 'dj': 'DJDJI'}

CREDIT = ('<p class="tv-credit">Live data by <a href="https://www.tradingview.com/" rel="noopener nofollow" '
          'target="_blank">TradingView</a>. Quotes can be delayed by the exchange.</p>')

CSS = """<style>
.tv-tape{flex:1;min-width:0;height:46px;overflow:hidden}
.tv-yields{min-height:76px;margin:0 0 14px}
.tv-heat{height:620px;border-radius:12px;overflow:hidden;border:1px solid var(--line);background:var(--surface)}
.tv-credit{font-size:12px;color:var(--muted);margin:6px 0 0}
.tv-credit a{color:inherit}
.tv-old{display:none!important}
@media (max-width:700px){.tv-heat{height:520px}}
</style>
"""

JS = """<script>
// TradingView widgets: mounted when their tab is first shown (a hidden container renders at zero size)
// and re-mounted when the site's light/dark theme changes.
(function(){
  const SRC='https://s3.tradingview.com/external-embedding/embed-widget-';
  const TAPE=%(tape)s, YIELDS=%(yields)s, HEAT=%(heat)s;
  const mq=matchMedia('(prefers-color-scheme: dark)');
  const theme=()=>{ const t=document.documentElement.getAttribute('data-theme'); return t==='light'||t==='dark'?t:(mq.matches?'dark':'light'); };
  let ix='sp';
  function mount(el,kind,cfg){
    if(!el) return;
    el.innerHTML='';
    const box=document.createElement('div'); box.className='tradingview-widget-container'; box.style.height='100%%';
    const w=document.createElement('div'); w.className='tradingview-widget-container__widget'; w.style.height='100%%';
    const s=document.createElement('script'); s.src=SRC+kind+'.js'; s.async=true;
    s.text=JSON.stringify(Object.assign({colorTheme:theme(),locale:'en',isTransparent:false},cfg));
    box.append(w,s); el.append(box); el.dataset.on=theme();
  }
  const defs={
    tvTape:()=>mount(document.getElementById('tvTape'),'ticker-tape',{symbols:TAPE,showSymbolLogo:false,displayMode:'adaptive'}),
    tvYields:()=>mount(document.getElementById('tvYields'),'tickers',{symbols:YIELDS,showSymbolLogo:false}),
    tvHeat:()=>mount(document.getElementById('tvHeat'),'stock-heatmap',{dataSource:HEAT[ix],grouping:'sector',
      blockSize:'market_cap_basic',blockColor:'change',exchanges:[],symbolUrl:'',hasTopBar:false,isDataSetEnabled:false,
      isZoomEnabled:true,hasSymbolTooltip:true,isMonoSize:false,isTransparent:false,width:'100%%',height:'100%%'})
  };
  const visible=el=>el&&el.offsetParent!==null;
  function sync(force){
    Object.keys(defs).forEach(id=>{ const el=document.getElementById(id);
      if(visible(el)&&(force||el.dataset.on!==theme())) defs[id](); });
  }
  const seg=document.getElementById('hmSeg');
  if(seg) seg.addEventListener('click',e=>{ const b=e.target.closest('button[data-ix]'); if(!b||!HEAT[b.dataset.ix]) return;
    ix=b.dataset.ix; seg.querySelectorAll('button').forEach(x=>x.setAttribute('aria-pressed',x===b)); defs.tvHeat(); });
  new MutationObserver(()=>sync(false)).observe(document.documentElement,{attributes:true,attributeFilter:['data-theme']});
  document.querySelectorAll('[id^="tab-"]').forEach(t=>new MutationObserver(()=>sync(false)).observe(t,{attributes:true,attributeFilter:['hidden']}));
  mq.addEventListener('change',()=>sync(false));
  addEventListener('load',()=>sync(false));
  sync(false);
})();
</script>
"""


def _rep(s, old, new):
    n = s.count(old)
    if n != 1:
        sys.exit(f'live: anchor found {n}x (expected 1): {old[:90]!r}')
    return s.replace(old, new)


def patch(s):
    if MARK in s:
        return s
    sym = lambda pairs: json.dumps([{'proName': p, 'title': t} for p, t in pairs])
    # site-wide ticker: TradingView tape in place of the snapshot ticker (the old track stays, hidden, for its script)
    s = _rep(s, '<div class="tk-label">MARKET PULSE</div><div class="tk-viewport"><div class="tk-track" id="tkTrack"></div></div>',
             '<div class="tk-label">LIVE</div><div class="tv-tape" id="tvTape"></div>'
             '<div class="tk-viewport tv-old"><div class="tk-track" id="tkTrack"></div></div>')
    # capital markets: live yields above the Cost of capital chart
    s = _rep(s, '<h2 data-ds="@rates">Cost of capital</h2>',
             '<h2 data-ds="@rates">Cost of capital</h2>\n  <div class="tv-yields" id="tvYields"></div>')
    # trading tab: live heat map; the snapshot heat map stays in the page, hidden, so its script runs unchanged
    s = _rep(s, '<h2 data-ds="HEATMAP">Index heat map</h2>', '<h2>Index heat map</h2>')
    s = _rep(s, '<span class="mon-status" id="hmStatus"></span>', '<span class="mon-status tv-old" id="hmStatus"></span>')
    for old in ['<div class="kpis pd-kpis" id="hmKpis"></div>', '<div class="hm-box" id="hmBox"',
                '<div class="tip" id="hmTip"', '<div class="hm-leg">', '<p class="note" id="hmNote"></p>']:
        s = _rep(s, old, old.replace('class="', 'class="tv-old ', 1))
    s = _rep(s, '<p class="tv-old note" id="hmNote"></p>', '<p class="tv-old note" id="hmNote"></p>\n  <div class="tv-heat" id="tvHeat"></div>\n  ' + CREDIT)
    s = _rep(s, "Tile size is the stock's weight in the index", "Tile size is the company's market value")
    s = _rep(s, '<div class="tv-yields" id="tvYields"></div>', '<div class="tv-yields" id="tvYields"></div>\n  '
             '<p class="tv-credit" style="margin:-8px 0 14px">Official daily Treasury yields (Federal Reserve H.15 via FRED), '
             'updated each business day by <a href="https://www.tradingview.com/" rel="noopener nofollow" target="_blank">TradingView</a>.</p>')
    s = _rep(s, '<div class="sf-legal">', '<div class="sf-legal">Live quotes, the index heat map and daily Treasury yields are provided by '
             '<a href="https://www.tradingview.com/" rel="noopener nofollow" target="_blank">TradingView</a>. ')
    s = _rep(s, '</head>', CSS + '</head>')
    s = _rep(s, '</body>', MARK + '\n' + JS % dict(tape=sym(TAPE), yields=sym(YIELDS), heat=json.dumps(HEAT)) + '</body>')
    return s


if __name__ == '__main__':
    p = sys.argv[1]
    s = open(p, encoding='utf-8').read()
    out = patch(s)
    if out == s:
        print('live: already patched')
    else:
        open(p, 'w', encoding='utf-8').write(out)
        print('live: patched', p)
