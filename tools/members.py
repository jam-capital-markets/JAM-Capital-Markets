#!/usr/bin/env python3
"""JAM Capital Markets: split members-only sections out of the dashboard page.

Every members page lives under /members/<slug>/ so one Cloudflare Access rule on /members covers all of them.
The public page keeps a short teaser card in each section's place, linking to the members page.

usage (standalone): python3 members.py <private index.html> <site dir>
    writes <site dir>/members/<slug>/index.html for every entry in MEMBERS
from build_page.py:  s, pages = members.split(s); ...; members.write(pages, site)

To add a members tab: give its sections ids, wrap its script in a block that starts with a unique marker comment,
and add an entry to MEMBERS below. Nothing changes on Cloudflare.
"""
import os, re, sys

MEMBERS = [
    dict(
        slug='portfolio',
        title='JAM Portfolio',
        tab='pred',  # dashboard tab the sections came from; its styling is reused
        sections=['portOv', 'portEq', 'portFi'],
        script='// ================= JAM PORTFOLIO =================',
        teaser=('The JAM model portfolio, with an equity sleeve and a fixed income sleeve solved for a target '
                'income return, is available to members.'),
        teaser_id='portOv',  # keeps old #portfolio deep links landing on the teaser
        hash='#portfolio',   # old in-page link; the public page forwards it to the members page
    ),
]

# Wording in members sections that refers to the private setup.
FIXES = [
    ('Prices are from the FMP connector', 'Prices are from Financial Modeling Prep (FMP)'),
    ('20-yr Treasury yield: FMP treasury rates', '20-yr Treasury yield: Financial Modeling Prep (FMP) treasury rates'),
]

PRIVATE = re.compile(r'(?i).{0,40}(torrington|jakemullaney|claude\.ai|window\.claude|claude\.use\().{0,40}')

MEMBER_CSS = """<style>
.mnav{border-bottom:1px solid var(--line);background:var(--surface)}
.mnav-in{max-width:1280px;margin:0 auto;padding:10px 24px;display:flex;flex-wrap:wrap;gap:8px 18px;align-items:center;font:600 14px Inter,sans-serif}
.mnav a{color:var(--muted);text-decoration:none;padding:4px 0;border-bottom:2px solid transparent}
.mnav a:hover{color:var(--ink)}
.mnav a[aria-current="page"]{color:var(--ink);border-bottom-color:var(--focus)}
.mnav .mback{margin-right:auto}
.mnav .mtag{font:700 11px Inter,sans-serif;letter-spacing:.14em;text-transform:uppercase;color:var(--muted)}
.mfoot{max-width:1280px;margin:0 auto;padding:22px 24px 40px;font-size:13px;color:var(--muted);border-top:1px solid var(--line)}
.mfoot a{color:inherit}
@media (max-width:600px){.mnav-in{padding:10px 14px}}
.mpage .cblock:first-of-type{margin-top:6px}
.mpage .row2 input{width:100%;min-width:0}
@media (max-width:600px){
  .mpage .row2{grid-template-columns:1fr}
  .mpage .outgrid{grid-template-columns:1fr}
}
</style>
"""


def _cut_section(s, sid):
    m = re.search(r'<section class="cblock" id="%s"[^>]*>.*?</section>\n*' % re.escape(sid), s, flags=re.S)
    if not m:
        sys.exit(f'members: section #{sid} not found')
    return m


def _cut_script(s, marker):
    i = s.find('<script>\n' + marker)
    if i < 0:
        sys.exit(f'members: script block {marker!r} not found')
    j = s.find('</script>', i)
    j += len('</script>')
    while s[j:j + 1] == '\n':
        j += 1
    return i, j


def _page(s, m, secs_html, script_html):
    head = s[:s.find('</head>')]
    head = re.sub(r'<title>[^<]*</title>', f'<title>{m["title"]} · JAM Capital Markets</title>', head, count=1)
    head = re.sub(r'\n<meta (?:name="description"|property="og:[a-z]+")[^>]*>', '', head)
    head = head.replace('<html lang="en">', f'<html lang="en" class="{"term" if m["tab"] == "pred" else ""}">', 1)
    head += '<meta name="robots" content="noindex,nofollow">\n' + MEMBER_CSS
    bar = s[s.find('<div class="tpi-bar">'):s.find('<div class="ticker"')]
    if not bar:
        sys.exit('members: header bar not found')
    bar = re.sub(r'<div class="rf" id="rfBox".*?</div>\n', '', bar, count=1, flags=re.S)
    links = ''.join(
        f'<a href="../{x["slug"]}/"{" aria-current=\"page\"" if x is m else ""}>{x["title"]}</a>' for x in MEMBERS)
    nav = (f'<nav class="mnav" aria-label="Members"><div class="mnav-in">'
           f'<a class="mback" href="../../">&larr; Back to the dashboard</a>'
           f'<span class="mtag">Members</span>{links}</div></nav>\n')
    body = f'<main class="wrap">\n<div id="tab-{m["tab"]}">\n<h1 class="sr">{m["title"]}</h1>\n{secs_html}</div>\n</main>\n'
    foot = ('<footer class="mfoot">For members of <a href="../../">JAM Capital Markets</a>. '
            'Figures can lag their sources and may contain errors. For information only, not investment advice.</footer>\n')
    return f'{head}</head>\n<body class="mpage">\n{bar}{nav}{body}{foot}{script_html}</body>\n</html>\n'


def split(s):
    """Remove members-only sections and scripts from the page; return (public page, {slug: members page})."""
    pages = {}
    for m in MEMBERS:
        hits = [_cut_section(s, sid) for sid in m['sections']]
        secs_html = ''.join(h.group(0) for h in hits)
        i, j = _cut_script(s, m['script'])
        script_html = s[i:j]
        for old, new in FIXES:
            secs_html = secs_html.replace(old, new)
        pages[m['slug']] = _page(s, m, secs_html, script_html)

        teaser = (f'<section class="cblock" id="{m["teaser_id"]}" data-title="{m["title"]}">\n'
                  f'  <h2>{m["title"]}</h2>\n  <p class="sub">{m["teaser"]}</p>\n'
                  f'  <a class="fwbtn" href="members/{m["slug"]}/">Open {m["title"]} &rarr;</a>\n</section>\n\n')
        # cut from the end backwards so earlier offsets stay valid
        cuts = sorted([(h.start(), h.end()) for h in hits] + [(i, j)], reverse=True)
        first = min(h.start() for h in hits)  # teaser goes where the first section was
        if i < first:
            sys.exit('members: script block must come after its sections')
        for a, b in cuts:
            s = s[:a] + s[b:]
        s = s[:first] + teaser + s[first:]
        s = s.replace('</head>', f'<script>if(location.hash.split("/")[0]==="{m["hash"]}")'
                                 f'location.replace("members/{m["slug"]}/");</script>\n</head>', 1)
    return s, pages


def write(pages, site):
    for slug, html in pages.items():
        left = [x.group(0) for x in PRIVATE.finditer(html)]
        if left:
            sys.exit(f'members: private reference left in {slug}:\n' + '\n'.join(left[:10]))
        d = os.path.join(site, 'members', slug)
        os.makedirs(d, exist_ok=True)
        tmp = os.path.join(d, 'index.html.tmp')
        open(tmp, 'w', encoding='utf-8').write(html)
        os.replace(tmp, os.path.join(d, 'index.html'))
        print('built', os.path.join(d, 'index.html'), len(html), 'bytes')


if __name__ == '__main__':
    src, site = sys.argv[1], sys.argv[2]
    s = open(src, encoding='utf-8').read()
    parts = re.split(r'(?i)<!doctype html>', s)
    if len(parts) >= 3:  # claude.ai wrapper: keep only the inner document
        s = '<!doctype html>' + parts[2]
        s = s[:s.find('</html>') + 7] + '\n'
    _, pages = split(s)
    write(pages, site)
