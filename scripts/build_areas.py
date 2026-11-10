"""Build the public "areas" pages from web/areas/areas.json.

One page per operational area (web/areas/<slug>/index.html) and an index (web/areas/index.html).
The JSON is the single source of truth for what each module does, who uses it, what it records,
its KPIs and its roadmap month. Edit the JSON, then run:  python scripts/build_areas.py
The generated pages are committed (the site has no build step at serve time).
"""
import html, json, pathlib, re

ROOT = pathlib.Path(__file__).resolve().parent.parent / "web"
DATA = ROOT / "areas" / "areas.json"
OUT = ROOT / "areas"

GROUP_ORDER = [
    "Patient flow and clinical services",
    "Infrastructure and support",
    "People, quality and governance",
    "Finance and digital",
    "System, community and resilience",
    "Across every area",
]
MONTHS = ["Nov 2026", "Dec 2026", "Jan 2027", "Feb 2027", "Mar 2027"]
# Areas with something to click today.
LIVE = {
    "A3": ("Open the bed board demo", "../../demo/bed-board/"),
    "X1": ("Open the process mapping demo", "../../demo/process-map/"),
    "B1": ("Open the app (engineering)", "../../app/#/engineering"),
    "B3": ("Open the cleaning and portering preview", "../../demo/support-tasks/"),
    "C2": ("Open the incidents and actions preview", "../../demo/actions/"),
    "B4": ("Open the stores and stock preview", "../../demo/stores-stock/"),
    "X2": ("Open the daily operations report preview", "../../demo/daily-report/"),
    "D4": ("Open the daily operations report preview", "../../demo/daily-report/"),
    "A4": ("Open the theatres preview", "../../demo/theatres/"),
    "A1": ("Open the outpatient clinics preview", "../../demo/clinics/"),
    "B2": ("Open the facilities preview", "../../demo/facilities/"),
    "A2": ("Open the emergency department preview", "../../demo/ed-flow/"),
}

e = lambda s: html.escape(str(s), quote=True)


def logo():
    src = (ROOT / "demo" / "index.html").read_text(encoding="utf-8")
    return re.search(r'<svg class="logo".*?</svg>', src, re.S).group(0)


def status(a):
    if a["id"] in LIVE:
        return '<span class="st live">Preview</span>'
    return f'<span class="st">{e(a["month"])}</span>'


CSS = """
:root { --navy:#0B2F4E; --sea:#0A9396; --mango:#EE9B00; --coral:#E0583E; --foam:#94D2BD; --sand:#F6F1E7; --ink:#0B2F4E; --soft:#44607A; --line:#E2DACB; --wash:#E6F3EF; }
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body { margin: 0; background: var(--sand); color: var(--ink); font: 17px/1.55 'Nunito', 'Segoe UI', system-ui, sans-serif; }
.wrap { max-width: 1100px; margin: 0 auto; padding: 0 max(16px, env(safe-area-inset-left, 0px)); }
header { background: #fff; border-bottom: 1px solid var(--line); }
header .wrap { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding-block: 8px; }
.logo { height: 44px; width: auto; display: block; }
header nav { display: flex; gap: 16px; flex-wrap: wrap; justify-content: flex-end; }
header nav a { color: var(--ink); font-weight: 700; text-decoration: none; border-bottom: 2px solid var(--coral); }
a { color: var(--ink); }
a:focus-visible, summary:focus-visible { outline: 3px solid var(--sea); outline-offset: 3px; }
.crumb { font-size: 0.85rem; color: var(--soft); margin: 22px 0 0; }
.crumb a { color: var(--soft); }
h1 { font-size: clamp(1.8rem, 4vw, 2.6rem); font-weight: 800; line-height: 1.12; margin: 10px 0 10px; letter-spacing: -0.02em; }
h2 { font-size: 1.2rem; margin: 0 0 10px; }
h3 { font-size: 1rem; margin: 0 0 4px; }
.lead { color: var(--soft); max-width: 44em; margin: 0 0 14px; font-size: 1.08rem; }
.st { display: inline-block; font-size: 0.7rem; font-weight: 800; letter-spacing: 0.1em; text-transform: uppercase; padding: 3px 9px; border-radius: 999px; border: 1px dashed #CFC5B2; color: var(--soft); background: #fff; }
.st.live { border: 0; background: var(--wash); color: var(--ink); }
.go { display: inline-block; background: var(--coral); color: #fff; text-decoration: none; font-weight: 800; padding: 11px 18px; border-radius: 999px; min-height: 44px; }
.ba { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin: 18px 0 8px; }
.ba div { background: #fff; border: 1px solid var(--line); border-radius: 14px; padding: 16px; }
.ba .lbl { display: block; font-size: 0.72rem; font-weight: 800; letter-spacing: 0.1em; text-transform: uppercase; color: var(--soft); margin-bottom: 4px; }
.ba .then { border-left: 4px solid var(--sea); }
.ba .now { border-left: 4px solid #E7A08D; }
.grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }
.card { background: #fff; border: 1px solid var(--line); border-radius: 14px; padding: 18px; min-width: 0; }
.card ul { margin: 0; padding-left: 18px; }
.card li { margin: 0 0 6px; }
.people { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 10px; }
.person { background: var(--sand); border-radius: 12px; padding: 10px 12px; }
.person b { display: block; }
.person span { color: var(--soft); font-size: 0.92rem; }
table { width: 100%; border-collapse: collapse; font-size: 0.92rem; }
th, td { text-align: left; padding: 8px 6px; border-bottom: 1px solid var(--line); vertical-align: top; }
th { font-size: 0.75rem; letter-spacing: 0.08em; text-transform: uppercase; color: var(--soft); }
.tw { overflow-x: auto; }
code { font-size: 0.85rem; background: var(--sand); padding: 1px 5px; border-radius: 5px; overflow-wrap: anywhere; }
section.block { margin: 22px 0; }
.not { background: #FDF1DC; border-radius: 12px; padding: 12px 14px; font-size: 0.95rem; }
.chips { display: flex; flex-wrap: wrap; gap: 8px; }
.chips a { background: #fff; border: 1px solid var(--line); border-radius: 999px; padding: 6px 12px; text-decoration: none; font-weight: 700; font-size: 0.9rem; min-height: 36px; display: inline-flex; align-items: center; }
.foot { color: var(--soft); font-size: 0.85rem; padding: 26px 0 48px; }
.groups { display: grid; gap: 18px; padding-bottom: 20px; }
.group h2 { margin: 18px 0 10px; }
.areas { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
.area { background: #fff; border: 1px solid var(--line); border-radius: 14px; padding: 16px; text-decoration: none; display: flex; flex-direction: column; gap: 6px; min-height: 44px; }
.area:hover { border-color: var(--sea); }
.area h3 { font-size: 1.02rem; }
.area p { margin: 0; color: var(--soft); font-size: 0.92rem; }
.legend { font-size: 0.88rem; color: var(--soft); margin: 0 0 10px; }
@media (max-width: 900px) { .areas { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 640px) { .ba, .grid, .areas { grid-template-columns: minmax(0, 1fr); } body { font-size: 16px; } h1 { margin-top: 6px; } }
"""


def page(title, desc, depth, body):
    up = "../" * depth
    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>{e(title)}</title>
<meta name="description" content="{e(desc)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Ospeli">
<meta property="og:title" content="{e(title)}">
<meta property="og:description" content="{e(desc)}">
<meta property="og:image" content="https://ospeli.com/og.png">
<meta name="twitter:card" content="summary_large_image">
<meta name="theme-color" content="#0B2F4E">
<link rel="icon" href="{up}favicon.svg" type="image/svg+xml">
<link rel="alternate icon" href="{up}favicon.ico">
<link rel="stylesheet" href="{up}fonts/nunito.css">
<style>{CSS}</style>
</head>
<body>
<header><div class="wrap"><a href="{up}" aria-label="Ospeli home">{LOGO}</a><nav><a href="{up}areas/">All areas</a><a href="{up}demo/">Demos</a></nav></div></header>
<main class="wrap">
{body}
<p class="foot">Ospeli is in development and launches in the first quarter of 2027. Demos use a fictional hospital and invented data. People decide; Ospeli suggests. Nothing here is clinical advice.</p>
</main>
</body>
</html>
"""


def area_page(a, by_id):
    live = LIVE.get(a["id"])
    due = "" if a["month"] == MONTHS[0] else f' First full version due: <b>{e(a["month"])}</b>.'
    cta = f'<p><a class="go" href="{e(live[1])}">{e(live[0])}</a></p><p class="lead">Preview on fictional data.{due}</p>' if live else f'<p class="lead">First version due: <b>{e(a["month"])}</b>. <a href="../#roadmap">See the roadmap</a>.</p>'
    people = "".join(f'<div class="person"><b>{e(p["role"])}</b><span>{e(p["does"])}</span></div>' for p in a["people"])
    screens = "".join(f'<li><b>{e(s["name"])}</b>: {e(s["shows"])}</li>' for s in a["screens"])
    captures = "".join(f"<li>{e(c)}</li>" for c in a["captures"])
    kpis = "".join(f'<tr><td><b>{e(k["name"])}</b></td><td>{e(k["definition"])}</td><td>{e(k["source"])}</td></tr>' for k in a["kpis"])
    guide = "".join(f"<li>{e(g)}</li>" for g in a["guide"])
    plays = "".join(f"<li>{e(p)}</li>" for p in a["playbooks"])
    cmds = "".join(f'<tr><td><code>{e(c["name"])}</code></td><td>{e(c["does"])}</td><td>{e(c["approval"])}</td></tr>' for c in a["agentCommands"])
    stds = ", ".join(e(s) for s in a["standards"]) or "Local definitions"
    links = "".join(f'<a href="../{e(by_id[c]["slug"])}/">{e(by_id[c]["name"])}</a>' for c in a.get("connects", []) if c in by_id and c != a["id"])
    body = f"""<p class="crumb"><a href="../">All areas</a> · {e(a["group"])}</p>
{status(a)}
<h1>{e(a["name"])}</h1>
<p class="lead">{e(a["oneLine"])}</p>
{cta}
<div class="ba"><div class="now"><span class="lbl">Today</span>{e(a["today"])}</div><div class="then"><span class="lbl">With Ospeli</span>{e(a["withOspeli"])}</div></div>
<section class="block" aria-labelledby="who"><h2 id="who">Who uses it</h2><div class="people">{people}</div></section>
<div class="grid">
<section class="card" aria-labelledby="scr"><h2 id="scr">Key screens</h2><ul>{screens}</ul></section>
<section class="card" aria-labelledby="cap"><h2 id="cap">What it records</h2><ul>{captures}</ul></section>
<section class="card" aria-labelledby="gd"><h2 id="gd">What the guide suggests</h2><ul>{guide}</ul><p class="legend" style="margin-top:8px">Every suggestion shows its reason. A named person decides. The guide has an off switch.</p></section>
<section class="card" aria-labelledby="pb"><h2 id="pb">Playbooks</h2><ul>{plays}</ul></section>
</div>
<section class="block card" aria-labelledby="kp"><h2 id="kp">Measures, with their definitions</h2><div class="tw"><table><thead><tr><th>Measure</th><th>Definition</th><th>Source</th></tr></thead><tbody>{kpis}</tbody></table></div></section>
<section class="block card" aria-labelledby="ag"><h2 id="ag">For AI assistants</h2><p class="legend">Assistants may read and propose through these commands. "none (read only)" commands only read. Anything that records or changes data is a proposal until a person confirms it, and "person decides" waits for a named person with that role.</p><div class="tw"><table><thead><tr><th>Command</th><th>What it does</th><th>Approval</th></tr></thead><tbody>{cmds}</tbody></table></div></section>
<section class="block" aria-labelledby="st"><h2 id="st">Standards it follows</h2><p>{stds}</p></section>
{'<section class="block" aria-labelledby="cn"><h2 id="cn">Works with</h2><div class="chips">' + links + '</div></section>' if links else ''}
<p class="not"><b>What it does not do:</b> {e(a["notFor"])}</p>"""
    return page(f'{a["name"]} · Ospeli', a["oneLine"], 2, body)


def index_page(areas):
    groups = []
    for g in GROUP_ORDER:
        items = [a for a in areas if a["group"] == g]
        if not items:
            continue
        cards = "".join(f'<a class="area" href="{e(a["slug"])}/">{status(a)}<h3>{e(a["name"])}</h3><p>{e(a["oneLine"])}</p></a>' for a in items)
        groups.append(f'<section class="group" aria-label="{e(g)}"><h2>{e(g)}</h2><div class="areas">{cards}</div></section>')
    n = len([a for a in areas if not a["id"].startswith("X")])
    body = f"""<h1 style="margin-top:28px">Every area of the operation</h1>
<p class="lead">Ospeli covers {n} operational areas on one shared core, plus process mapping and playbooks that work across all of them. Each area page shows who uses it, what it records, how it is measured and what it deliberately does not do.</p>
<p class="legend"><span class="st live">Preview</span> try it today · <span class="st">Month</span> first version due</p>
<div class="groups">{''.join(groups)}</div>"""
    return page("Every area · Ospeli", "All the operational areas Ospeli covers, from beds and theatres to facilities, stores, staffing, quality and preparedness.", 1, body)


def main():
    global LOGO
    LOGO = logo()
    areas = json.loads(DATA.read_text(encoding="utf-8"))
    by_id = {a["id"]: a for a in areas}
    slugs = [a["slug"] for a in areas]
    assert len(slugs) == len(set(slugs)), "duplicate slugs"
    for a in areas:
        assert a["month"] in MONTHS, (a["id"], a["month"])
        d = OUT / a["slug"]
        d.mkdir(parents=True, exist_ok=True)
        (d / "index.html").write_text(area_page(a, by_id), encoding="utf-8")
    (OUT / "index.html").write_text(index_page(areas), encoding="utf-8")
    print(f"built {len(areas)} area pages")


if __name__ == "__main__":
    main()
