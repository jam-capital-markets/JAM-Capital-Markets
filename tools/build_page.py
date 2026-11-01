#!/usr/bin/env python3
"""JAM Capital Markets: turn the private dashboard page into the public site page.

usage: python3 build_page.py <private index.html> <site dir>

Every patch names an exact anchor. If any anchor is missing (the private page changed), the build stops
and the previous public page is left in place, so the live site never breaks silently.
"""
import os, re, sys

src, site = sys.argv[1], sys.argv[2]
here = os.path.dirname(os.path.abspath(__file__))
s = open(src, encoding='utf-8').read()

# The claude.ai wrapper puts the real document inside a second <!doctype html>; keep only that document.
parts = re.split(r'(?i)<!doctype html>', s)
if len(parts) >= 3:
    s = '<!doctype html>' + parts[2]
    s = s[:s.find('</html>') + 7] + '\n'

def rep(old, new, count=1, regex=False):
    global s
    n = len(re.findall(old, s)) if regex else s.count(old)
    if n != count:
        sys.exit(f'build_page: anchor found {n}x (expected {count}): {old[:90]!r}')
    s = re.sub(old, new, s) if regex else s.replace(old, new)

MARK = ('<svg class="jam-mark" viewBox="0 0 64 64" aria-hidden="true"><rect x="2" y="2" width="60" height="60" rx="10" '
        'fill="none" stroke="currentColor" stroke-width="3.5"/><text x="32" y="41" text-anchor="middle" '
        'font-family="Georgia,serif" font-size="22" font-weight="700" fill="currentColor" letter-spacing="1">JAM</text></svg>')
FAVICON = ("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' "
           "rx='12' fill='%23001C47'/%3E%3Ctext x='32' y='41' text-anchor='middle' font-family='Georgia,serif' font-size='22' "
           "font-weight='700' fill='white'%3EJAM%3C/text%3E%3C/svg%3E")
DESC = ('Free dashboard of U.S. capital markets, rates, inflation, federal spending and Boston / New Hampshire real estate, '
        'built from public data and updated automatically.')

# ---- identity
rep('<title>TPI Capital Markets Dashboard</title>',
    f'<title>JAM Capital Markets</title>\n<meta name="description" content="{DESC}">\n'
    f'<meta property="og:title" content="JAM Capital Markets">\n<meta property="og:description" content="{DESC}">\n'
    f'<meta property="og:type" content="website">\n<link rel="icon" href="{FAVICON}">')
rep(r'<img class="tpi-mark" src="data:image/png;base64,[A-Za-z0-9+/=]+" alt="Torrington"><span>Capital Markets</span>',
    MARK + '<span>JAM Capital Markets</span>', regex=True)

# ---- data layer: static JSON instead of the claude.ai database
shim = open(os.path.join(here, 'shim.js'), encoding='utf-8').read()
rep('<script>\n// ================= LOADER: data lives in the artifact\'s database =================',
    '<script>\n' + shim + '</script>\n<script>\n// ================= LOADER: data lives in ./data =================')
rep("bootMsg('Sign in to claude.ai with your Torrington account to load the dashboard data.',true)",
    "bootMsg('The dashboard data could not be loaded. Reload the page to try again.',true)")
rep("bootMsg('This dashboard loads its data from claude.ai. Open it from its claude.ai link to see the latest numbers.',true)",
    "bootMsg('The dashboard data could not be loaded. Reload the page to try again.',true)")
rep("Ask Claude to run the Friday refresh.", "Check back shortly; the data is refreshed automatically.")
rep("Ask Claude to check the latest refresh.", "Reload the page to try again.")

# ---- owner-only controls off
rep('</head>', '<style>#rfBox,#ask,#wkDraft,#wkEdit,#wkSave,#wkFinal,#wkStatus,#hmLiveBtn,#hmLiveMsg{display:none!important}\n'
    '.jam-mark{width:44px;height:44px;flex:none;color:#fff}\n@media (max-width:760px){.jam-mark{width:36px;height:36px}}\n'
    '.jam-foot{max-width:1280px;margin:0 auto;padding:22px 24px 40px;font-size:13px;color:var(--muted);border-top:1px solid var(--line)}\n'
    '.jam-foot a{color:inherit}</style>\n</head>')
rep("const st=dd?(dd.status==='final'?'':' (draft)'):' (not started)';", "const st=dd?'':' (coming Friday)';")

# ---- wording that referred to the private setup
rep('with a note on why each matters for the portfolio.', 'with a note on why each matters for commercial real estate.')
rep('data-note="Snapshot: daily closes for the past year. With FMP connected, the page checks for newer closes each time it opens."',
    'data-note="Daily Treasury constant-maturity yields from the Federal Reserve\'s H.15 release, updated each weekday."')
rep("data-note=\"CME's data is licensed and can't be pulled live into this page; ask Claude to refresh the snapshot, or use the button for live odds.\"",
    "data-note=\"Odds are a weekly snapshot from public prediction markets and published FedWatch readings; use the button for CME's live tool.\"")

# ---- trading tab: derived series only (no raw index levels)
rep("`Nasdaq ${n0(sig.ix)} vs average ${n0(sig.smaL)}. ${sig.streak?`${sig.streak} sessions ${tr.val<0?'below':'above'} it.`:''}`",
    "`${sig.streak?`${sig.streak} sessions ${tr.val<0?'below':'above'} the average.`:''}`")
rep("pdLine(document.getElementById('pdC-trend'),{x:C.ixic.d,series:[{v:C.ixic.sma,color:'var(--gB)',w:2,dash:'5 4'},{v:C.ixic.p,color:'var(--ink)',w:2,end:v=>Math.round(v).toLocaleString()}],yf:v=>(v/1000).toFixed(1)+'k'});",
    "pdLine(document.getElementById('pdC-trend'),{x:C.ixic.d,zero:true,series:[{v:C.ixic.dist,color:'var(--ink)',w:2.2,end:v=>(v>0?'+':'')+v.toFixed(1)+'%'}],yf:v=>(v>0?'+':'')+v.toFixed(0)+'%'});")
rep("`EMA ${n0(sig.ema)}, now ${em.ok?'falling':'rising'}. Nasdaq is ${above?'above':'below'} it at ${n0(sig.ix)}.`",
    "`The EMA is now ${em.ok?'falling':'rising'}. Nasdaq is ${(C.ema.dist[C.ema.dist.length-1]||0)>0?'above':'below'} it by ${Math.abs(C.ema.dist[C.ema.dist.length-1]||0).toFixed(1)}%.`")
rep("const em=byK.ema, above=sig.ix>sig.ema;", "const em=byK.ema;")
rep("pdLine(document.getElementById('pdC-ema'),{x:C.ema.d,series:[{v:C.ema.p,color:'var(--muted)',w:1.5},{v:C.ema.ema,color:'var(--gM)',w:2.5,end:v=>Math.round(v).toLocaleString()}],yf:v=>(v/1000).toFixed(1)+'k'});",
    "pdLine(document.getElementById('pdC-ema'),{x:C.ema.d,zero:true,series:[{v:C.ema.dist,color:'var(--gM)',w:2.5,end:v=>(v>0?'+':'')+v.toFixed(1)+'%'}],yf:v=>(v>0?'+':'')+v.toFixed(0)+'%'});")
rep('aria-label="Nasdaq Composite and its 218-day moving average, last six months"', 'aria-label="Nasdaq Composite, percent above or below its 218-day moving average, last six months"')
rep('aria-label="Nasdaq Composite and its 21-day exponential moving average, last three months"', 'aria-label="Nasdaq Composite, percent above or below its 21-day exponential moving average, last three months"')
rep('<div class="pd-legend"><span><i style="background:var(--muted)"></i>Nasdaq Composite</span><span><i style="background:var(--gM)"></i>21-day EMA</span></div>',
    '<div class="pd-legend"><span><i style="background:var(--gM)"></i>Nasdaq vs its 21-day EMA, % (0 = on the line)</span></div>')
s2 = re.sub(r'<div class="pd-legend">(?:(?!</div>).)*218-day(?:(?!</div>).)*</div>',
            '<div class="pd-legend"><span><i style="background:var(--ink)"></i>Nasdaq vs its 218-day average, % (below 0 = condition met)</span></div>', s, count=1, flags=re.S)
if s2 == s: sys.exit('build_page: 218-day legend not found')
s = s2
# model runs offline; the page reads its published outputs
rep("const inp=predInputs();\n  if(!window.PredModel||!inp){",
    "const inp=D.PRED_R?{ext:{hyAsof:META.BOND_KPI&&META.BOND_KPI.asof},log:[]}:predInputs();\n  if(!D.PRED_R&&(!window.PredModel||!inp)){")
rep("let R; try{ R=PredModel.compute(inp.PX,inp.ext,inp.log); PRED=R; }",
    "let R; try{ R=D.PRED_R||PredModel.compute(inp.PX,inp.ext,inp.log); PRED=R; }")
rep("High-yield spread as of ${fmtD(inp.ext.hyAsof)} (weekly). ", "")
rep("<p><b>Data.</b> Daily closes for the S&amp;P 500, Nasdaq Composite, Russell 2000, VIX, Brent crude, gold and EUR/USD, plus Treasury yields, from the FMP connector. The high-yield spread and Fed odds come from this dashboard's weekly datasets.</p>",
    "<p><b>Data.</b> Daily closes for the S&amp;P 500, Nasdaq Composite, Russell 2000, VIX (Cboe), Brent crude, gold and EUR/USD, plus Treasury yields (Federal Reserve H.15). Index providers do not allow their price histories to be republished, so this page shows only what the model derives from them: distances from moving averages, momentum readings, signals and the percent results of each call. Fed odds come from public prediction markets.</p>")

# ---- live-data wording (live connectors never run on the public site)
rep("setLive(null,snapMsg+' · connect FMP in claude.ai to refresh on open')", "setLive(null,snapMsg)")
rep("'Rates live from FMP':'Rates from last save'", "'Treasury yields: latest close':'Treasury yields: latest close'")
rep("'Add the FMP connector in claude.ai Settings → Connectors to load live prices.'", "'Live prices are not available on this site.'")
rep(",['earn','Earnings']", "")
rep('</head>', '<style>#earnStatus{display:none!important}\n@media (max-width:600px){.srcs li{white-space:normal}.seg{max-width:100%;overflow-x:auto;scrollbar-width:none}.seg::-webkit-scrollbar{display:none}.seg button{flex:none;white-space:nowrap}}</style>\n</head>')

# ---- footer
rep('</body>', '<footer class="jam-foot"><b>JAM Capital Markets</b> · Built from public data: U.S. Treasury, Federal Reserve, BLS, BEA, EIA, Freddie Mac, Census, '
    'company and agency releases, and the news sources linked on each section. Updated automatically. For information only, not investment advice. '
    '<span id="jamBuilt"></span></footer>\n<script>fetch(\'data/build.json\',{cache:\'no-cache\'}).then(r=>r.json()).then(b=>{ '
    'const e=document.getElementById(\'jamBuilt\'); if(e&&b.built) e.textContent=\'Last updated \'+new Date(b.built).toLocaleString(\'en-US\','
    '{month:\'short\',day:\'numeric\',year:\'numeric\',hour:\'numeric\',minute:\'2-digit\',timeZoneName:\'short\'})+\'.\'; }).catch(()=>{});</script>\n</body>')

# ---- the public page reads only its own data layer (window.jamData), never a host's hooks
s = s.replace('window.claude', 'window.jamData')
if re.search(r'(?<![.\w])claude\.use\(', s): sys.exit('build_page: bare claude.use( call left')

# ---- scrub private strings that live only in code paths the public page never runs
s = re.sub(r"trig_[A-Za-z0-9]{8,}", "trig_disabled", s)
s = s.replace('TPI Capital Markets Dashboard', 'JAM Capital Markets')
s = s.replace('an internal market dashboard at Torrington Properties (Boston commercial real estate: multifamily, office, retail, student housing in Massachusetts and New Hampshire)',
              'a public market dashboard focused on Boston and New Hampshire commercial real estate')
s = s.replace('at Torrington Properties, a Boston commercial', 'for a Boston commercial')
left = [m.group(0) for m in re.finditer(r'(?i).{0,40}(torrington|jakemullaney|claude\.ai/(?:code/)?artifact).{0,40}', s)]
if left:
    sys.exit('build_page: private reference left in page:\n' + '\n'.join(left[:10]))

os.makedirs(site, exist_ok=True)
tmp = os.path.join(site, 'index.html.tmp')
open(tmp, 'w', encoding='utf-8').write(s)
os.replace(tmp, os.path.join(site, 'index.html'))
print('built', os.path.join(site, 'index.html'), len(s), 'bytes')
