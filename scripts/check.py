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
# agents.md and llms.txt may only name commands that exist in the registry (issue #25).
_spec = json.loads((ROOT / "app/api/commands.json").read_text(encoding="utf-8"))["commands"]
_cmds = {c["name"] for c in _spec} | {c["deprecatedName"] for c in _spec if c.get("deprecatedName")}
for name in ("agents.md", "llms.txt"):
    for tok in set(re.findall(r"`([a-z]+(?:\.[a-z-]+)+)`", (ROOT / name).read_text(encoding="utf-8"))):
        if tok not in _cmds and not tok.endswith((".md", ".json", ".txt", ".js", ".com")) and not tok.startswith("window."):
            errors.append(f"{name}: names a command that does not exist: {tok}")
    # New-style names (issue #39): every `ospeli_...` token must be a real command.
    for tok in set(re.findall(r"`(ospeli_[a-z_]+)`", (ROOT / name).read_text(encoding="utf-8"))):
        if tok not in _cmds:
            errors.append(f"{name}: names a command that does not exist: {tok}")

for name in ("index.html", "llms.txt", "agents.md"):
    f = ROOT / name
    if not f.exists():
        continue
    text = f.read_text(encoding="utf-8")
    text = visible_text(text) if name.endswith(".html") else re.sub(r"\s+", " ", text)
    for sentence in re.split(r"(?<=[.!?])\s+", text):
        if PLANNED_TERMS.search(sentence) and not PLANNED_MARKERS.search(sentence):
            errors.append(f"{name}: unbuilt feature stated as fact (say planned / designed to / in development): {sentence.strip()[:120]}")

# Issue #88: on the front page a row tagged "Built" must open the built module in the app
# (a link into app/), never a stand-alone preview under demo/. And the old preview's
# "reasons for declines" is not a feature of the built bed board, so no public page may list it.
for _row in re.findall(r'<div class="mod[^"]*">\s*<span class="st built">Built</span>.*?</div>', home, re.S):
    _name = re.search(r"<h3>(.*?)</h3>", _row, re.S)
    _hrefs = re.findall(r'<a\b[^>]*href="([^"]+)"', _row)
    if not _hrefs or any(not h.startswith("app/") for h in _hrefs):
        errors.append(f"index.html: the Built row \"{_name.group(1) if _name else '?'}\" must link into app/ (found {_hrefs}); a preview is not the built module")
if re.search(r"allocation with reasons for declines", visible_text(home), re.I):
    errors.append("index.html: \"allocation with reasons for declines\" describes the old preview, not the built bed board")

# Honest public claims (issue #43): no coverage, compliance or outcome claims on public pages.
# - "covers 28 areas": most areas are previews, so a count of areas "covered" is not true.
# - "Standards it follows": software does not follow or hold a standard; say what it is designed around.
# - "run full": an outcome Ospeli cannot promise.
# - an area cross-reference ("see A6") must be followed by that area's exact name, so the id and
#   the area it is meant to name cannot drift apart.
# - a FHIR line in an area's standards must say "(planned)".
COVERS = re.compile(r"\bcover(?:s|ing|ed)?\s+(?:all\s+|every\s+)?(?:\d+|twenty|thirty|forty)[\w-]*\s+(?:\w+\s+){0,2}areas\b", re.I)
CLAIMS = [(COVERS, 'claims a number of areas "covered"; say what is built and what is a preview'),
          (re.compile(r"standards\s+it\s+follows", re.I), 'says "Standards it follows"; use "Standards and methods it is designed around"'),
          (re.compile(r"\brun(?:s|ning)?\s+full\b", re.I), 'promises an outcome ("run full")')]
claim_files = [(p, p.relative_to(ROOT).as_posix()) for p in pages]
claim_files += [(ROOT / n, n) for n in ("llms.txt", "agents.md", "areas/areas.json") if (ROOT / n).exists()]
for f, rel in claim_files:
    text = f.read_text(encoding="utf-8")
    text = visible_text(text) if rel.endswith(".html") else re.sub(r"\s+", " ", text)
    for rx, why in CLAIMS:
        m = rx.search(text)
        if m:
            errors.append(f"{rel}: {why}: \"{text[max(0, m.start() - 30):m.end() + 30].strip()}\"")

# Honest public claims (issue #57): the app has no personal sign-in yet; it records the role that
# acted and whether it was a person or an agent. So "a named person" decides, approves or acts may
# only appear in a sentence that says it is planned, or that says what Ospeli never does.
NAMED = re.compile(r"\bnamed (?:person|people|individual)", re.I)
NAMED_OK = re.compile(r"planned|designed to|in development|\bnever\b|\bnot\b|\brefuse", re.I)
for f, rel in claim_files:
    text = f.read_text(encoding="utf-8")
    text = visible_text(text) if rel.endswith(".html") else re.sub(r"\s+", " ", text)
    for sentence in re.split(r"(?<=[.!?;])\s+", text):
        if NAMED.search(sentence) and not NAMED_OK.search(sentence):
            errors.append(f"{rel}: says a named person acts, but there is no personal sign-in yet (say \"a person\", or planned): {sentence.strip()[:120]}")

# Honest public claims (issue #64): the public app runs wholly in the browser, so a script in the
# page can load the app's own modules and act as a person. Until the site server ships (A8), the
# agent files must say that the agent rules are kept by the app's own code and are not a security
# boundary, and must not state "only people can switch agents on", "every agent action is audited"
# or "the page does not expose its storage" as plain fact. Remove this guard only when A8's
# acceptance test (the same script against the site server is refused) is green.
AGENT_FILES = ("llms.txt", "agents.md", "app/api/README.md", "app/api/commands.json")
ABSOLUTE = [(re.compile(r"\bonly (?:a )?(?:people|person)\b[^.]*\bswitch", re.I), "only people can switch agents on"),
            (re.compile(r"\bagents? cannot\b", re.I), "agents cannot"),
            (re.compile(r"\bevery (?:agent )?(?:action|read|call|proposal)\b[^.]*\baudit", re.I), "every agent action is audited"),
            (re.compile(r"does not expose its storage|no other (?:supported )?way in", re.I), "the page does not expose its storage")]
ABSOLUTE_OK = re.compile(r"designed to|browser demo|not a security boundary|site server|kept by the app", re.I)
for name in AGENT_FILES:
    f = ROOT / name
    if not f.exists():
        continue
    text = re.sub(r"\s+", " ", f.read_text(encoding="utf-8"))
    if "not a security boundary" not in text:
        errors.append(f"{name}: must say that in the browser demo the agent rules are kept by the app's own code and are not a security boundary (issue #64)")
    for sentence in re.split(r"(?<=[.!?])\s+", text):
        for rx, what in ABSOLUTE:
            if rx.search(sentence) and not ABSOLUTE_OK.search(sentence):
                errors.append(f"{name}: states \"{what}\" as fact; in the browser demo say \"designed to\" or name the site server (issue #64): {sentence.strip()[:120]}")

# Honest public claims (issue #79): the audit trail is a plain chain of check codes with no secret
# key, no signature and no copy kept off the device. It catches accidental damage. It does not
# show a history that was rewritten or shortened on purpose, and it does not cover the event log.
# So no public file (pages, app code, agent files, the site server and its README) may use these
# words. Remove a word from this list only when the off-device checkpoint ships (issue #79 part 2).
RECORD_WORDS = [(re.compile(r"tamper[- ]?(?:evident|evidence|proof)", re.I), "tamper-evident / tamper-proof"),
                (re.compile(r"append[- ]only", re.I), "append-only"),
                (re.compile(r"so edits show up", re.I), "so edits show up"),
                (re.compile(r"\bintact\b", re.I), "Intact"),
                (re.compile(r"chain check passed", re.I), "the chain check passed"),
                (re.compile(r"any edit or deletion breaks the chain", re.I), "any edit or deletion breaks the chain")]
record_files = [f for f in ROOT.rglob("*") if f.is_file() and f.suffix in (".html", ".js", ".mjs", ".md", ".txt", ".json", ".css")]
record_files += [f for f in (ROOT.parent / "tools").rglob("*") if f.is_file() and f.suffix in (".mjs", ".js", ".md", ".json")]
record_files += [ROOT.parent / "README.md"]
for f in record_files:
    if not f.exists():
        continue
    text = re.sub(r"\s+", " ", f.read_text(encoding="utf-8"))
    for rx, what in RECORD_WORDS:
        m = rx.search(text)
        if m:
            errors.append(f"{f.relative_to(ROOT.parent).as_posix()}: says \"{what}\", which is more than the audit check proves (issue #79): \"{text[max(0, m.start() - 40):m.end() + 40].strip()}\"")

# One vocabulary (issue #82): the words people see are Patient flow coordinator, Facilities
# technician, Emergency department (ED), Operations manager and Nurse call. The old words may not
# appear in the visible text of a public page, in a text a person or an agent reads (llms.txt,
# agents.md, READMEs, areas.json, commands.json) or in a string in the app's or the site server's
# code. Internal ids keep their old spelling so stored data still loads, and they never match:
# they are lower case and hyphenated (bed-manager, estates-tech, ae-nic, ops-manager, call-bell)
# or the bare lower-case trade id 'estates'. Code comments are not checked.
OLD_WORDS = [(re.compile(r"\bbed managers?\b", re.I), "Bed manager", "Patient flow coordinator"),
             (re.compile(r"\bestates tech(?:nician)?s?\b", re.I), "Estates tech / Estates technician", "Facilities technician"),
             (re.compile(r"\bA\s*(?:&|&amp;|\\u0026)\s*E\b", re.I), "A&E", "Emergency department, then ED"),
             (re.compile(r"\bops managers?\b", re.I), "Ops manager", "Operations manager"),
             (re.compile(r"\bcall bells?\b", re.I), "Call bell", "Nurse call"),
             (re.compile(r"\bEstates\b(?!-)"), "Estates", "Facilities")]

def js_strings(src):
    """The string and template literals of a script, joined; comments and code are left out."""
    out, i, n = [], 0, len(src)
    while i < n:
        c, two = src[i], src[i:i + 2]
        if two == "//":
            j = src.find("\n", i); i = n if j < 0 else j
        elif two == "/*":
            j = src.find("*/", i + 2); i = n if j < 0 else j + 2
        elif c in "'\"`":
            j = i + 1
            while j < n and src[j] != c:
                if src[j] == "\\":
                    j += 1
                elif src[j] == "\n" and c != "`":
                    break  # not a string after all (an apostrophe in a regular expression)
                j += 1
            out.append(src[i + 1:j]); i = j + 1
        else:
            i += 1
    return " \n ".join(out)

def page_words(html):
    """What a person can meet on a page: its text, its attribute values and the strings in its scripts."""
    scripts = re.findall(r"<script\b[^>]*>(.*?)</script>", html, flags=re.S | re.I)
    attrs = re.findall(r"\b(?:aria-label|title|alt|placeholder|content|value|label)\s*=\s*\"([^\"]*)\"", re.sub(r"<(script|style)\b.*?</\1>", " ", html, flags=re.S | re.I))
    return " \n ".join([visible_text(html)] + attrs + [js_strings(s) for s in scripts])

def old_word_hits(text):
    hits = []
    for rx, old, new in OLD_WORDS:
        for m in rx.finditer(text):
            hits.append((old, new, re.sub(r"\s+", " ", text[max(0, m.start() - 30):m.end() + 30]).strip()))
    return hits

vocab_files = [f for f in ROOT.rglob("*") if f.is_file() and f.suffix in (".html", ".js", ".mjs", ".md", ".txt", ".json", ".webmanifest")]
vocab_files += [f for f in (ROOT.parent / "tools").rglob("*") if f.is_file() and f.suffix in (".mjs", ".js", ".md", ".json")]
vocab_files += [ROOT.parent / "README.md"]
old_word_count = 0
for f in vocab_files:
    if not f.exists():
        continue
    text = f.read_text(encoding="utf-8")
    text = page_words(text) if f.suffix == ".html" else js_strings(text) if f.suffix in (".js", ".mjs") else text
    for old, new, where in old_word_hits(text):
        old_word_count += 1
        errors.append(f"{f.relative_to(ROOT.parent).as_posix()}: says \"{old}\"; the word is now \"{new}\" (issue #82): \"{where}\"")
if "--old-words" in sys.argv:
    print(f"Old words (issue #82): {old_word_count}")

areas_file = ROOT / "areas" / "areas.json"
if areas_file.exists():
    import json
    areas = json.loads(areas_file.read_text(encoding="utf-8"))
    names = {a["id"]: a["name"] for a in areas}
    def strings(x):
        if isinstance(x, str):
            yield x
        elif isinstance(x, dict):
            for k, v in x.items():
                if k not in ("id", "connects", "slug"):
                    yield from strings(v)
        elif isinstance(x, list):
            for v in x:
                yield from strings(v)
    for a in areas:
        for s in strings(a):
            for m in re.finditer(r"\b([A-EX]\d{1,2})\b(.{0,80})", s):
                ref, rest = m.group(1), m.group(2)
                if ref not in names:
                    errors.append(f"areas.json {a['id']}: cross-reference to unknown area {ref}: \"{s[:100]}\"")
                elif not rest.startswith(", " + names[ref]):
                    errors.append(f"areas.json {a['id']}: cross-reference {ref} must be followed by its name (\"{ref}, {names[ref]}\"): \"{s[:100]}\"")
        for st in a.get("standards", []):
            line = st if isinstance(st, str) else " ".join(str(v) for v in st.values())
            if re.search(r"\bFHIR\b", line) and "(planned)" not in line:
                errors.append(f"areas.json {a['id']}: FHIR is not built; mark the line \"(planned)\": \"{line[:100]}\"")
        for c in a.get("connects", []):
            if c not in names:
                errors.append(f"areas.json {a['id']}: connects to unknown area {c}")

for e in errors:
    print("FAIL", e)
print(f"Checked {len(pages)} pages, {len(errors)} problems")
sys.exit(1 if errors else 0)
