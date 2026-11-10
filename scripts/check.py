"""Nightly checks for the Ospeli demo site. Fails the build if any check fails."""
import pathlib, re, shutil, subprocess, sys
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

# Words that would suggest real (not synthetic) data slipped in. Stored as short
# SHA-256 hashes so this public file doesn't list them. Single words and two-word
# phrases are checked; LOWER matches any case, EXACT matches case-sensitively.
# To add a term: python -c "import hashlib;print(hashlib.sha256(b'term').hexdigest()[:16])"
import hashlib
BLOCKED_LOWER = {'0c65f4b9deeaeffa', '287dc6923bef88eb', '6f4b80a890f15854', 'cb9aebd2455f24b0', 'e006652e2f5dfad1', 'fa9381764a951930', '1b82a470458c49f3', 'b994b3a94ac7cc49', 'b05904eed3661b6f', '4b877759f7277f48', '60eb4c2e2eb3d996', '4fe52b9a6857a425'}
BLOCKED_EXACT = {'87c58f4baf6345d2'}

def blocked_terms(text):
    words = re.findall(r"[A-Za-z]+", text)
    grams = words + [a + " " + b for a, b in zip(words, words[1:])]
    hit = lambda g: hashlib.sha256(g.encode()).hexdigest()[:16]
    return sorted({g for g in grams if hit(g.lower()) in BLOCKED_LOWER or hit(g) in BLOCKED_EXACT})

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
    for term in blocked_terms(text):
        errors.append(f"{rel}: contains a blocked term ({term}); synthetic data only")
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

# The command layer (backlog A2/A3): every command has schemas and an example, and
# web/app/api/commands.json matches the registry.
if (APP / "core" / "commands.js").exists():
    node = shutil.which("node")
    if not node:
        errors.append("node not found: cannot check the command registry")
    else:
        r = subprocess.run([node, str(ROOT.parent / "scripts" / "build-commands.mjs"), "--check"], capture_output=True, text=True)
        if r.returncode != 0:
            fails = [l[5:] for l in r.stdout.splitlines() if l.startswith("FAIL ")]
            errors.extend(fails or ["command registry check failed: " + r.stderr[-300:]])

# Agent discovery (backlog A1, issue #18): these files exist, and every ospeli.com or relative
# link in them points at a file that exists under web/.
def local_target(base, ref):
    ref = ref.split("#")[0].split("?")[0]
    if ref.startswith("https://ospeli.com/"):
        t = ROOT / ref[len("https://ospeli.com/"):]
    elif re.match(r"^(https?:|mailto:)", ref):
        return None
    else:
        t = base.parent / ref
    return t / "index.html" if ref.endswith("/") or t.is_dir() else t

for name in ("llms.txt", "agents.md", "robots.txt", "sitemap.xml"):
    f = ROOT / name
    if not f.exists():
        errors.append(f"{name}: missing (agents cannot discover Ospeli)")
        continue
    text = f.read_text(encoding="utf-8")
    refs = re.findall(r"\]\(([^)\s]+)\)", text) + re.findall(r"<loc>([^<]+)</loc>", text) + re.findall(r"^Sitemap:\s*(\S+)", text, re.M)
    for ref in refs:
        t = local_target(f, ref)
        if t is not None and not t.exists():
            errors.append(f"{name}: link {ref} does not resolve")
home = (ROOT / "index.html").read_text(encoding="utf-8")
m = re.search(r'<script type="application/ld\+json">(.*?)</script>', home, re.S)
if not m:
    errors.append("index.html: no schema.org JSON-LD")
else:
    import json
    try:
        ld = json.loads(m.group(1))
        if ld.get("@type") != "SoftwareApplication":
            errors.append("index.html: JSON-LD is not a SoftwareApplication")
    except ValueError as e:
        errors.append(f"index.html: JSON-LD does not parse ({e})")

# Honest claims (issue #31): features not built yet (FHIR, HL7, CSV export, sync between devices)
# may only appear on the front page and in the agent files in a sentence that says they are
# planned, designed for or in development. Agents quote these lines back as facts.
PLANNED_TERMS = re.compile(r"\b(FHIR|HL7|CSV|sync|syncs|synced|syncing)\b", re.I)
PLANNED_MARKERS = re.compile(r"planned|designed to|designed so|in development|not built|coming next", re.I)
def visible_text(html):
    html = re.sub(r"<(script|style)\b.*?</\1>", " ", html, flags=re.S | re.I)
    html = re.sub(r"<[^>]+>", " ", html)
    return re.sub(r"\s+", " ", html)
for name in ("index.html", "llms.txt", "agents.md"):
    f = ROOT / name
    if not f.exists():
        continue
    text = f.read_text(encoding="utf-8")
    text = visible_text(text) if name.endswith(".html") else re.sub(r"\s+", " ", text)
    for sentence in re.split(r"(?<=[.!?])\s+", text):
        if PLANNED_TERMS.search(sentence) and not PLANNED_MARKERS.search(sentence):
            errors.append(f"{name}: unbuilt feature stated as fact (say planned / designed to / in development): {sentence.strip()[:120]}")

for e in errors:
    print("FAIL", e)
print(f"Checked {len(pages)} pages, {len(errors)} problems")
sys.exit(1 if errors else 0)
