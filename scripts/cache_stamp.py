"""Service worker cache stamp: the offline cache VERSION in web/app/sw.js must be
bumped whenever a precached file changes, or devices keep serving the old files.

scripts/sw-cache-stamp.json records the VERSION and a digest of the precached files.
check.py fails if the digest changed but VERSION did not. After bumping VERSION, run
  python scripts/check.py --stamp-cache
to record the new stamp (the merge step does this). --stamp-cache refuses to write when
the cached files changed but VERSION did not, so it cannot be used to silence the check.
An empty or unreadable PRECACHE list is an error, never a pass."""
import hashlib, json, re

ENTRY = re.compile(r"""'[^'\\\n]*'|"[^"\\\n]*\"""")

def read_sw(app):
    """Return (version, files, problems) for app/sw.js."""
    src = (app / "sw.js").read_text(encoding="utf-8")
    problems = []
    v = re.search(r"const VERSION\s*=\s*'([^']+)'", src)
    if not v:
        problems.append("app/sw.js: const VERSION not found")
    m = re.search(r"const PRECACHE\s*=\s*\[(.*?)\]\s*;", src, re.S)
    files = []
    if not m:
        problems.append("app/sw.js: PRECACHE list not found or not understood (expected const PRECACHE = [ ... ];)")
    else:
        body = re.sub(r"/\*.*?\*/", "", m.group(1), flags=re.S)
        body = re.sub(r"//[^\n]*", "", body)
        for token in (t.strip() for t in body.split(",")):
            if not token:
                continue
            if ENTRY.fullmatch(token):
                files.append(token[1:-1])
            else:
                problems.append(f"app/sw.js: PRECACHE entry not understood: {token[:60]} (use plain quoted paths)")
        if not files:
            problems.append("app/sw.js: PRECACHE list is empty, so nothing would work offline")
    return (v.group(1) if v else None), files, problems

def _bytes(target):
    data = target.read_bytes()
    # Text files: ignore line endings, so a Windows checkout with autocrlf gives the same digest.
    return data if b"\0" in data else data.replace(b"\r\n", b"\n")

def digest(app, files):
    h = hashlib.sha256()
    for ref in sorted(set(files)):
        target = app / ref
        if ref.endswith("/"):
            target = target / "index.html"
        h.update(ref.encode() + b"\0")
        h.update(_bytes(target) if target.exists() else b"<missing>")
        h.update(b"\0")
    return h.hexdigest()[:16]

def current(app):
    version, files, problems = read_sw(app)
    return {"version": version, "digest": digest(app, files)}, problems

def _old(stamp_path):
    try:
        return json.loads(stamp_path.read_text(encoding="utf-8")), None
    except (OSError, ValueError):
        return None, f"{stamp_path.name} is not valid JSON: run python scripts/check.py --stamp-cache"

def write_stamp(app, stamp_path):
    """Record the stamp. Returns a list of reasons it refused (empty when written)."""
    now, problems = current(app)
    if problems:
        return problems + [f"{stamp_path.name} not written: fix app/sw.js first"]
    if stamp_path.exists():
        old, bad = _old(stamp_path)
        if bad or not isinstance(old, dict):
            return [f"{stamp_path.name} is not valid JSON; --stamp-cache refused. Restore it from git, "
                    f"bump VERSION if cached files changed, then run it again"]
        if now["digest"] != old.get("digest") and now["version"] == old.get("version"):
            return [f"app/sw.js: precached files changed but VERSION is still {now['version']}; "
                    f"--stamp-cache refused. Bump VERSION in web/app/sw.js first, then run it again"]
    stamp_path.write_text(json.dumps(now, indent=2) + "\n", encoding="utf-8")
    return []

def stamp_errors(app, stamp_path):
    now, problems = current(app)
    if problems:
        return problems
    if not stamp_path.exists():
        return [f"{stamp_path.name} missing: run python scripts/check.py --stamp-cache"]
    old, bad = _old(stamp_path)
    if bad or not isinstance(old, dict):
        return [bad or f"{stamp_path.name} is not valid: run python scripts/check.py --stamp-cache"]
    if now["digest"] == old.get("digest"):
        return []
    if now["version"] == old.get("version"):
        return [f"app/sw.js: precached files changed but VERSION is still {now['version']}; bump VERSION, then run python scripts/check.py --stamp-cache"]
    return [f"{stamp_path.name} is stale (VERSION is now {now['version']}): run python scripts/check.py --stamp-cache"]
