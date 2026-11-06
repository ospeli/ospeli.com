"""Nightly checks for the Ospeli demo site. Fails the build if any check fails."""
import pathlib, re, sys
from html.parser import HTMLParser

ROOT = pathlib.Path(__file__).resolve().parent.parent / "web"
errors = []

class Links(HTMLParser):
    def __init__(self):
        super().__init__(); self.refs = []
    def handle_starttag(self, tag, attrs):
        for k, v in attrs:
            if k in ("href", "src") and v and not re.match(r"^(https?:|mailto:|#|data:)", v):
                self.refs.append(v)

# Words that would suggest real (not synthetic) data slipped in. Extend as needed.
BLOCKED = [r"\bNCRHA\b", r"\bEWMSC\b", r"\bMount Hope\b", r"\bERHA\b", r"\bSWRHA\b", r"\bNWRHA\b", r"\bTHA\b"]

pages = sorted(ROOT.rglob("*.html"))
if not pages:
    errors.append("no HTML pages found")
for page in pages:
    text = page.read_text(encoding="utf-8")
    rel = page.relative_to(ROOT)
    if not text.lstrip().lower().startswith("<!doctype html>"):
        errors.append(f"{rel}: missing <!doctype html>")
    if "<title>" not in text:
        errors.append(f"{rel}: missing <title>")
    for pat in BLOCKED:
        if re.search(pat, text):
            errors.append(f"{rel}: contains blocked term {pat!r} (synthetic data only)")
    p = Links(); p.feed(text)
    for ref in p.refs:
        target = (page.parent / ref.split("#")[0].split("?")[0])
        if ref.endswith("/"):
            target = target / "index.html"
        if not target.exists():
            errors.append(f"{rel}: broken link {ref}")

# The app must open offline: every file in web/app/ that the app loads is precached by sw.js.
APP = ROOT / "app"
sw = APP / "sw.js"
if sw.exists():
    m = re.search(r"PRECACHE\s*=\s*\[(.*?)\]", sw.read_text(encoding="utf-8"), re.S)
    listed = set(re.findall(r"'([^']+)'", m.group(1))) if m else set()
    if not m:
        errors.append("app/sw.js: PRECACHE list not found")
    for ref in listed:
        target = APP / ref
        if ref.endswith("/"):
            target = target / "index.html"
        if not target.resolve().exists():
            errors.append(f"app/sw.js: precached file missing: {ref}")
    for f in APP.rglob("*"):
        if f.suffix in (".js", ".css", ".woff2", ".webmanifest", ".html") and f.name != "sw.js":
            rel = f.relative_to(APP).as_posix()
            if rel not in listed:
                errors.append(f"app/sw.js: {rel} is not precached, so it will not work offline")

for e in errors:
    print("FAIL", e)
print(f"Checked {len(pages)} pages, {len(errors)} problems")
sys.exit(1 if errors else 0)
