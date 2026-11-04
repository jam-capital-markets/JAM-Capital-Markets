"""Render every tab of the built public site, in a desktop and a phone viewport, and report problems.
usage: python3 test_site.py <site dir> <out dir> [lib dir with d3.min.js and topojson.min.js]"""
import asyncio, os, sys, json, threading, http.server, functools, re
from playwright.async_api import async_playwright

site, out = sys.argv[1], sys.argv[2]
lib = sys.argv[3] if len(sys.argv) > 3 else None
os.makedirs(out, exist_ok=True)
H = functools.partial(http.server.SimpleHTTPRequestHandler, directory=site)
H.log_message = lambda *a: None
srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), H)
threading.Thread(target=srv.serve_forever, daemon=True).start()
URL = f'http://127.0.0.1:{srv.server_port}/'
TABS = ['week', 'cap', 're', 'local', 'news', 'cal', 'home', 'mig', 'gov', 'pred']
BAD = re.compile(r'(?i:torrington|claude\.ai|\bFMP\b|connector|sign in|draft with claude)|\bNaN\b|\bundefined\b|\[object')

async def main():
    report = {}
    async with async_playwright() as p:
        b = await p.chromium.launch()
        for vw, tag in [((1280, 900), 'd'), ((390, 844), 'm')]:
            ctx = await b.new_context(viewport={'width': vw[0], 'height': vw[1]})
            pg = await ctx.new_page()
            errs = []
            pg.on('pageerror', lambda e: errs.append('pageerror: ' + str(e)))
            pg.on('console', lambda m: errs.append('console: ' + m.text) if m.type == 'error' else None)
            if lib:
                async def lib_route(route):
                    u = route.request.url
                    f = 'd3.min.js' if '/d3/' in u else 'topojson.min.js'
                    await route.fulfill(path=os.path.join(lib, f), content_type='application/javascript')
                await pg.route('https://cdnjs.cloudflare.com/**', lib_route)
                await pg.route('https://fonts.googleapis.com/**', lambda r: r.fulfill(body='', content_type='text/css'))
            await pg.goto(URL, wait_until='load')
            await pg.wait_for_timeout(1500)
            boot = await pg.evaluate("(()=>{const b=document.getElementById('bootMsg');return b&&!b.hidden?b.textContent:''})()")
            for t in TABS:
                await pg.evaluate(f"showTab('{t}')")
                await pg.wait_for_timeout(900)
                info = await pg.evaluate(f"""(()=>{{
                  const root=document.getElementById('tab-{t}'); if(!root) return {{missing:true}};
                  const txt=root.innerText;
                  const empties=[...root.querySelectorAll('section')].filter(s=>!s.hidden&&s.offsetParent!==null&&s.innerText.trim().length<40).map(s=>s.id||s.dataset.title);
                  const blankSvg=[...root.querySelectorAll('svg')].filter(s=>s.offsetParent!==null&&s.getBoundingClientRect().height>60&&s.childElementCount===0).map(s=>s.id||s.getAttribute('class'));
                  const over=document.documentElement.scrollWidth>window.innerWidth+2?[...document.querySelectorAll('body *')].filter(e=>{{const r=e.getBoundingClientRect();return r.right>window.innerWidth+2&&r.width>0&&!e.closest('.scroll,.tk-viewport,.tabs,table')&&getComputedStyle(e).position!=='fixed';}}).slice(0,4).map(e=>e.tagName+'#'+e.id+'.'+String(e.className).slice(0,40)+' w'+Math.round(e.getBoundingClientRect().right)):false;
                  return {{len:txt.length, empties, blankSvg, over}};
                }})()""")
                txt = await pg.evaluate(f"document.getElementById('tab-{t}').innerText")
                info['bad'] = sorted(set(txt[max(0,m.start()-70):m.end()+50].replace('\n',' ') for m in BAD.finditer(txt)))[:8]
                report[f'{tag}:{t}'] = info
                if tag == 'd' or t in ('pred', 'gov', 'week'):
                    await pg.screenshot(path=os.path.join(out, f'{tag}_{t}.png'), full_page=(tag == 'd'))
            hdr = await pg.evaluate("document.querySelector('.tpi-bar').innerText+' | '+document.title+' | '+(document.querySelector('.site-foot')||{}).innerText")
            report[f'{tag}:header'] = hdr
            report[f'{tag}:errors'] = errs[:20]
            report[f'{tag}:boot'] = boot
            await ctx.close()
        await b.close()
    print(json.dumps(report, indent=1))

asyncio.run(main())
