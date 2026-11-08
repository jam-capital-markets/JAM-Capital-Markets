# JAM Capital Markets

A free dashboard of U.S. capital markets, rates, inflation, federal spending and Boston / New Hampshire real estate,
built from public data and updated automatically.

## How it updates
The site is a static page (`index.html`) that reads JSON files in `data/`. Scheduled tasks refresh the data in the
private working copy of the dashboard, then run:

```
python3 tools/build_page.py <private index.html> .     # rebrands the page and switches it to ./data
node tools/export.js <database dump dir> .               # writes data/*.json (public data only; ds, cm, weekly, daily)
```

and commit the result here. GitHub Pages serves the repository root.

## Data rules
- Raw price histories for the S&P 500, Nasdaq and Russell 2000 are not published (index providers require approval).
  The trading model runs privately; only its derived outputs are published.
- ICE BofA credit index figures are not published.
- Treasury yields are the official Federal Reserve H.15 series (public domain). Other data is credited to its
  original publisher on each section.

For information only. Not investment advice.

## Live market widgets
The site-wide ticker, the live Treasury yields on Capital markets and the Trading tab's index heat map are
TradingView widgets (`tools/live.py`, applied by `build_page.py`). TradingView serves those prices from its own
servers under its own licence, so they update live during market hours with no refresh runs and nothing is
republished from this repository. Their credit links must stay on the page.

## Members pages
Members-only tabs live under `/members/<name>/` (today: `/members/portfolio/`). `tools/members.py` cuts their
sections out of the dashboard page; `build_page.py` calls it first, so the public page only ever carries a teaser
card linking to the members page. One Cloudflare Access rule on `/members` protects every members page.

To add a members tab, give its sections ids, start its script with a unique marker comment, and add an entry to
`MEMBERS` in `tools/members.py`. No Cloudflare change is needed.

Hosting: the site is meant to run on Cloudflare Pages (connected to this repository), not GitHub Pages, because
GitHub Pages would serve `/members/` with no lock. `_headers` keeps members pages out of caches and search results.
