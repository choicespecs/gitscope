"""GitScope local server.

A tiny stdlib-only HTTP server that shells out to the local `git` binary and
exposes repository history as JSON to the single-page UI in ./static.

Nothing here talks to any web API. The only network activity that can ever
happen is an explicit `git clone` / `git fetch` when the user opens a remote
repository URL (and that can be disabled with --offline).
"""

import hashlib
import json
import os
import re
import subprocess
import sys
import threading
import time
from collections import OrderedDict, defaultdict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

STATIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")
DATA_DIR = os.path.expanduser(os.environ.get("GITSCOPE_HOME", "~/.gitscope"))
CLONE_DIR = os.path.join(DATA_DIR, "clones")
RECENT_FILE = os.path.join(DATA_DIR, "recent.json")

EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"
SHA_RE = re.compile(r"^[0-9a-fA-F]{4,64}$")
REMOTE_RE = re.compile(r"^(https?://|ssh://|git://|git@)[\w.@:/~+%-]+$")
MAX_BLOB = 2 * 1024 * 1024
MAX_PATCH = 4 * 1024 * 1024

FS, RS = "\x1f", "\x1e"
LOG_FORMAT = FS.join(["%H", "%P", "%aN", "%aE", "%at", "%ct", "%D", "%s"]) + RS

OFFLINE = False


class ApiError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


# ---------------------------------------------------------------- git runner

_GIT_ENV = dict(os.environ)
_GIT_ENV.update({
    "GIT_TERMINAL_PROMPT": "0",      # never block waiting for credentials
    "GIT_OPTIONAL_LOCKS": "0",
    "LC_ALL": "C",
    "GIT_PAGER": "cat",
})
_GIT_BASE = [
    "git",
    "-c", "core.quotepath=off",
    "-c", "color.ui=never",
    "-c", "protocol.ext.allow=never",
    "-c", "log.showSignature=false",
]


def git(repo, *args, timeout=180, check=True):
    cmd = list(_GIT_BASE)
    if repo:
        cmd += ["-C", repo]
    cmd += list(args)
    try:
        proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                              env=_GIT_ENV, timeout=timeout)
    except subprocess.TimeoutExpired:
        raise ApiError("git timed out: " + " ".join(args[:2]), 504)
    out = proc.stdout.decode("utf-8", errors="replace")
    if check and proc.returncode != 0:
        err = proc.stderr.decode("utf-8", errors="replace").strip()
        raise ApiError(err or "git %s failed" % args[0])
    return out


def git_bytes(repo, *args, timeout=60):
    cmd = list(_GIT_BASE) + ["-C", repo] + list(args)
    proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                          env=_GIT_ENV, timeout=timeout)
    if proc.returncode != 0:
        raise ApiError(proc.stderr.decode("utf-8", "replace").strip() or "git failed")
    return proc.stdout


# ---------------------------------------------------------------- repo registry

_lock = threading.Lock()
_repos = {}  # id -> dict(path, name, source, remote)


def _load_recent():
    try:
        with open(RECENT_FILE) as f:
            data = json.load(f)
        for r in data:
            _repos[r["id"]] = r
    except (OSError, ValueError, KeyError):
        pass


def _save_recent():
    os.makedirs(DATA_DIR, exist_ok=True)
    items = sorted(_repos.values(), key=lambda r: -r.get("opened", 0))[:30]
    tmp = RECENT_FILE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(items, f, indent=1)
    os.replace(tmp, RECENT_FILE)


def _repo_id(path):
    return hashlib.sha1(path.encode()).hexdigest()[:12]


def _clone_target(url):
    clean = re.sub(r"^(https?://|ssh://|git://|git@)", "", url)
    clean = re.sub(r"\.git/?$", "", clean).strip("/")
    slug = re.sub(r"[^\w.-]+", "_", clean)[:100]
    return os.path.join(CLONE_DIR, slug + ".git")


def open_repo(source):
    source = (source or "").strip()
    if not source:
        raise ApiError("Enter a local path or a git URL")
    remote = None
    if REMOTE_RE.match(source):
        if OFFLINE:
            raise ApiError("Remote URLs are disabled (--offline). Clone it yourself and open the local path.")
        remote = source
        path = _clone_target(source)
        if not os.path.isdir(path):
            os.makedirs(CLONE_DIR, exist_ok=True)
            # bare clone: we only read objects, so no working tree is needed
            git(None, "clone", "--bare", "--quiet", "--", source, path, timeout=1800)
    else:
        path = os.path.abspath(os.path.expanduser(source))
        if not os.path.isdir(path):
            raise ApiError("Not a directory: %s" % path)
        inside = git(path, "rev-parse", "--is-bare-repository", check=False).strip()
        if inside == "":
            raise ApiError("Not a git repository: %s" % path)
        if inside == "false":
            path = git(path, "rev-parse", "--show-toplevel").strip()
        else:
            path = git(path, "rev-parse", "--absolute-git-dir").strip()
    rid = _repo_id(path)
    name = os.path.basename(path.rstrip("/"))
    if name.endswith(".git"):
        name = name[:-4]
    if remote:
        name = re.sub(r"\.git$", "", remote.rstrip("/").split("/")[-1].split(":")[-1])
    with _lock:
        info = _repos.get(rid, {})
        info.update({"id": rid, "path": path, "name": name, "remote": remote,
                     "source": source, "opened": time.time()})
        _repos[rid] = info
        _save_recent()
    return info


def get_repo(rid):
    info = _repos.get(rid or "")
    if not info:
        raise ApiError("Unknown repository id. Open it again from the home screen.", 404)
    if not os.path.isdir(info["path"]):
        raise ApiError("Repository path no longer exists: %s" % info["path"], 404)
    return info["path"]


# ---------------------------------------------------------------- cache

_cache = OrderedDict()
_cache_lock = threading.Lock()


def cached(key, fn, size=200):
    with _cache_lock:
        if key in _cache:
            _cache.move_to_end(key)
            return _cache[key]
    val = fn()
    with _cache_lock:
        _cache[key] = val
        while len(_cache) > size:
            _cache.popitem(last=False)
    return val


def clear_cache(rid):
    with _cache_lock:
        for k in [k for k in _cache if k[0] == rid]:
            del _cache[k]


def state_key(repo):
    """Changes whenever any ref moves - used to invalidate cached aggregates."""
    out = git(repo, "for-each-ref", "--format=%(objectname)")
    head = git(repo, "rev-parse", "-q", "--verify", "HEAD", check=False).strip()
    return hashlib.sha1((out + head).encode()).hexdigest()


# ---------------------------------------------------------------- helpers

def check_rev(rev):
    rev = (rev or "").strip()
    if not rev:
        return "HEAD"
    if rev.startswith("-") or ".." in rev or any(c in rev for c in " \t\n\\:~^"):
        raise ApiError("Invalid revision: %r" % rev)
    return rev


def check_path(p):
    p = (p or "").strip().strip("/")
    if p.startswith("-") or "\x00" in p:
        raise ApiError("Invalid path")
    return p


def parse_log(out):
    commits = []
    for rec in out.split(RS):
        rec = rec.strip("\n")
        if not rec:
            continue
        f = rec.split(FS)
        if len(f) < 8:
            continue
        commits.append({
            "sha": f[0],
            "parents": f[1].split() if f[1] else [],
            "author": f[2],
            "email": f[3],
            "time": int(f[4] or 0),
            "ctime": int(f[5] or 0),
            "refs": [r.strip() for r in f[6].split(",") if r.strip()] if f[6] else [],
            "subject": f[7],
        })
    return commits


def split_rename(path):
    """Expand numstat rename notation into (old, new)."""
    m = re.match(r"^(.*)\{(.*) => (.*)\}(.*)$", path)
    if m:
        pre, a, b, post = m.groups()
        old = (pre + a + post).replace("//", "/")
        new = (pre + b + post).replace("//", "/")
        return old, new
    if " => " in path:
        a, b = path.split(" => ", 1)
        return a, b
    return None, path


def _int(v, default, lo=0, hi=10 ** 6):
    try:
        return max(lo, min(hi, int(v)))
    except (TypeError, ValueError):
        return default


# ---------------------------------------------------------------- API handlers

def api_refs(repo, q):
    out = git(repo, "for-each-ref", "--sort=-committerdate",
              "--format=%(refname)%1f%(objectname)%1f%(*objectname)%1f%(committerdate:unix)%1f%(creatordate:unix)")
    branches, remotes, tags = [], [], []
    for line in out.splitlines():
        name, obj, peeled, cdate, crdate = (line.split(FS) + [""] * 5)[:5]
        sha = peeled or obj
        if name.startswith("refs/heads/"):
            branches.append({"name": name[11:], "sha": sha, "time": int(cdate or 0)})
        elif name.startswith("refs/remotes/"):
            if name.endswith("/HEAD"):
                continue
            remotes.append({"name": name[13:], "sha": sha, "time": int(cdate or 0)})
        elif name.startswith("refs/tags/"):
            tags.append({"name": name[10:], "sha": sha, "time": int(crdate or cdate or 0)})
    head_ref = git(repo, "symbolic-ref", "-q", "--short", "HEAD", check=False).strip()
    head = git(repo, "rev-parse", "-q", "--verify", "HEAD", check=False).strip()
    return {"head": head, "headRef": head_ref, "branches": branches,
            "remotes": remotes, "tags": tags}


def _log_filter_args(q):
    args = []
    if q.get("author"):
        args += ["--author=" + q["author"]]
    if q.get("q"):
        args += ["--grep=" + q["q"]]
    if q.get("author") or q.get("q"):
        args += ["--regexp-ignore-case", "--extended-regexp"]
    if q.get("since"):
        args += ["--since=" + q["since"]]
    if q.get("until"):
        args += ["--until=" + q["until"] + " 23:59:59"]
    if q.get("code"):
        args += ["-S" + q["code"]]
    if q.get("nomerges") == "1":
        args += ["--no-merges"]
    return args


def api_log(repo, q):
    skip = _int(q.get("skip"), 0, 0, 10 ** 8)
    limit = _int(q.get("limit"), 300, 1, 2000)
    ref = q.get("ref") or "--all"
    revs = ["--all"] if ref == "--all" else [check_rev(ref)]
    path = check_path(q.get("path"))
    args = ["log", "--topo-order", "--format=" + LOG_FORMAT,
            "--skip=%d" % skip, "-n", str(limit + 1)]
    args += _log_filter_args(q)
    if path:
        args += ["--parents"]  # parent rewriting so the graph stays connected
    sha_hit = None
    term = (q.get("q") or "").strip()
    if skip == 0 and SHA_RE.match(term):
        found = git(repo, "rev-parse", "-q", "--verify", term + "^{commit}", check=False).strip()
        if found:
            sha_hit = found
    if not empty_repo(repo):
        out = git(repo, *(args + revs + (["--", path] if path else [])))
    else:
        out = ""
    commits = parse_log(out)
    more = len(commits) > limit
    commits = commits[:limit]
    return {"commits": commits, "more": more, "skip": skip, "shaHit": sha_hit}


def empty_repo(repo):
    return not git(repo, "rev-parse", "-q", "--verify", "HEAD", check=False).strip() and \
        not git(repo, "for-each-ref", "--count=1").strip()


def _diff_base(repo, sha, parent):
    if parent:
        return check_rev(parent)
    parents = git(repo, "rev-list", "--parents", "-n", "1", sha).split()[1:]
    return parents[0] if parents else EMPTY_TREE


def api_commit(repo, q):
    sha = check_rev(q.get("sha"))
    fmt = FS.join(["%H", "%P", "%aN", "%aE", "%at", "%cN", "%cE", "%ct", "%D", "%B"])
    out = git(repo, "show", "-s", "--format=" + fmt, sha + "^{commit}")
    f = out.split(FS)
    info = {
        "sha": f[0], "parents": f[1].split(), "author": f[2], "email": f[3],
        "time": int(f[4]), "committer": f[5], "committerEmail": f[6],
        "ctime": int(f[7]),
        "refs": [r.strip() for r in f[8].split(",") if r.strip()],
        "message": f[9].rstrip("\n"),
    }
    full = info["sha"]
    base = _diff_base(repo, full, q.get("parent"))
    info["base"] = base
    files = []
    ns = git(repo, "diff-tree", "-r", "-M", "-z", "--name-status", "--no-commit-id", base, full)
    parts = ns.split("\0")
    i = 0
    while i < len(parts) and parts[i]:
        status = parts[i]
        if status[0] in "RC":
            files.append({"status": status[0], "score": status[1:], "old": parts[i + 1], "path": parts[i + 2]})
            i += 3
        else:
            files.append({"status": status[0], "path": parts[i + 1], "old": None})
            i += 2
    stats = git(repo, "diff-tree", "-r", "-M", "-z", "--numstat", "--no-commit-id", base, full)
    parts = stats.split("\0")
    i, k = 0, 0
    while i < len(parts) and parts[i] and k < len(files):
        add, dele, p = (parts[i].split("\t") + ["", ""])[:3]
        if p == "":  # rename: paths follow as two separate NUL fields
            i += 3
        else:
            i += 1
        files[k]["add"] = None if add == "-" else int(add)
        files[k]["del"] = None if dele == "-" else int(dele)
        files[k]["binary"] = add == "-"
        k += 1
    info["files"] = files
    # which branches contain this commit (cheap enough for a single commit)
    contains = git(repo, "for-each-ref", "--contains", full, "--format=%(refname)",
                   "refs/heads", "refs/remotes", check=False)
    info["branches"] = [re.sub(r"^refs/(heads|remotes)/", "", b) for b in contains.split("\n")
                        if b and not b.endswith("/HEAD")][:50]
    tag = git(repo, "describe", "--tags", "--contains", full, check=False).strip()
    info["firstTag"] = tag.split("~")[0].split("^")[0] if tag else None
    return info


def api_diff(repo, q):
    sha = check_rev(q.get("sha"))
    base = _diff_base(repo, sha, q.get("parent"))
    ctx = _int(q.get("context"), 3, 0, 10000)
    args = ["diff", "-M", "--no-color", "--no-ext-diff", "-U%d" % ctx]
    if q.get("ws") == "1":
        args.append("-w")
    args += [base, sha, "--"]
    path = check_path(q.get("path"))
    old = check_path(q.get("old"))
    if path:
        args.append(path)
    if old and old != path:
        args.append(old)
    raw = git_bytes(repo, *args)
    truncated = len(raw) > MAX_PATCH
    return {"patch": raw[:MAX_PATCH].decode("utf-8", "replace"), "truncated": truncated}


def api_tree(repo, q):
    ref = check_rev(q.get("ref"))
    path = check_path(q.get("path"))
    target = ref + ":" + path if path else ref + "^{tree}"
    out = git(repo, "ls-tree", "-z", "-l", target)
    entries = []
    for rec in out.split("\0"):
        if not rec:
            continue
        meta, name = rec.split("\t", 1)
        mode, typ, obj, size = meta.split(None, 3)
        entries.append({"name": name, "type": typ, "sha": obj, "mode": mode,
                        "size": None if size.strip() == "-" else int(size)})
    entries.sort(key=lambda e: (e["type"] != "tree", e["name"].lower()))
    return {"ref": ref, "path": path, "entries": entries}


def api_tree_last(repo, q):
    """Latest commit touching each entry of a directory (GitHub-style listing)."""
    ref = check_rev(q.get("ref"))
    path = check_path(q.get("path"))
    names = set(e["name"] for e in api_tree(repo, q)["entries"])
    prefix = path + "/" if path else ""

    def compute():
        found = {}
        cmd = list(_GIT_BASE) + ["-C", repo, "log", "--format=" + RS + "%H" + FS + "%aN" + FS + "%at" + FS + "%s",
                                  "--name-only", "--no-renames", "-n", "8000", ref, "--"] + ([path] if path else [])
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=_GIT_ENV)
        cur = None
        try:
            for raw in proc.stdout:
                line = raw.decode("utf-8", "replace").rstrip("\n")
                if line.startswith(RS):
                    sha, author, t, subj = (line[1:].split(FS) + ["", "", "0", ""])[:4]
                    cur = {"sha": sha, "author": author, "time": int(t or 0), "subject": subj}
                elif line and cur:
                    if not line.startswith(prefix):
                        continue
                    first = line[len(prefix):].split("/", 1)[0]
                    if first in names and first not in found:
                        found[first] = cur
                        if len(found) == len(names):
                            break
        finally:
            proc.kill()
            proc.wait()
        return found

    sha = git(repo, "rev-parse", ref).strip()
    return {"last": cached((q.get("repo"), "treelast", sha, path), compute)}


def api_ls(repo, q):
    """All file paths at a ref, for the fuzzy 'go to file' finder."""
    ref = check_rev(q.get("ref"))
    sha = git(repo, "rev-parse", ref + "^{commit}").strip()

    def compute():
        out = git(repo, "ls-tree", "-r", "-z", "--name-only", sha)
        return [p for p in out.split("\0") if p][:200000]
    return {"paths": cached((q.get("repo"), "ls", sha), compute, size=50)}


def _is_binary(data):
    return b"\0" in data[:8000]


def api_blob(repo, q):
    ref = check_rev(q.get("ref"))
    path = check_path(q.get("path"))
    if not path:
        raise ApiError("path required")
    size = int(git(repo, "cat-file", "-s", ref + ":" + path).strip())
    if size > MAX_BLOB:
        return {"path": path, "size": size, "tooLarge": True}
    data = git_bytes(repo, "cat-file", "blob", ref + ":" + path)
    if _is_binary(data):
        return {"path": path, "size": size, "binary": True}
    return {"path": path, "size": size, "text": data.decode("utf-8", "replace")}


MIME = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
        ".svg": "image/svg+xml", ".webp": "image/webp", ".ico": "image/x-icon", ".bmp": "image/bmp"}


def api_raw(repo, q):
    ref = check_rev(q.get("ref"))
    path = check_path(q.get("path"))
    data = git_bytes(repo, "cat-file", "blob", ref + ":" + path)
    ext = os.path.splitext(path)[1].lower()
    return ("raw", MIME.get(ext, "application/octet-stream"), data)


def api_blame(repo, q):
    ref = check_rev(q.get("ref"))
    path = check_path(q.get("path"))
    size = int(git(repo, "cat-file", "-s", ref + ":" + path).strip())
    if size > MAX_BLOB:
        raise ApiError("File too large to blame (%d bytes)" % size)
    out = git(repo, "blame", "--porcelain", "-w", ref, "--", path, timeout=300)
    commits, lines = {}, []
    cur = None
    for line in out.split("\n"):
        if line.startswith("\t"):
            lines.append([cur, line[1:]])
            continue
        parts = line.split(" ")
        if len(parts) >= 3 and len(parts[0]) >= 40 and SHA_RE.match(parts[0]):
            cur = parts[0]
            commits.setdefault(cur, {"sha": cur})
        elif cur:
            key, _, val = line.partition(" ")
            c = commits[cur]
            if key == "author":
                c["author"] = val
            elif key == "author-mail":
                c["email"] = val.strip("<>")
            elif key == "author-time":
                c["time"] = int(val)
            elif key == "summary":
                c["subject"] = val
            elif key == "previous":
                c["previous"] = val.split(" ", 1)[0]
            elif key == "filename":
                c["filename"] = val
    return {"path": path, "ref": ref, "commits": commits, "lines": lines}


def api_file_history(repo, q):
    ref = q.get("ref") or "HEAD"
    revs = ["--all"] if ref == "--all" else [check_rev(ref)]
    path = check_path(q.get("path"))
    if not path:
        raise ApiError("path required")
    limit = _int(q.get("limit"), 500, 1, 5000)
    args = ["log", "--format=" + RS + LOG_FORMAT.rstrip(RS), "--numstat", "-n", str(limit)]
    if ref != "--all":
        args.append("--follow")
    out = git(repo, *(args + revs + ["--", path]))
    commits = []
    for chunk in out.split(RS):
        if not chunk.strip():
            continue
        head, _, rest = chunk.partition("\n")
        c = parse_log(head + RS)
        if not c:
            continue
        c = c[0]
        c["add"] = c["del"] = 0
        c["path"] = path
        c["old"] = None
        for line in rest.splitlines():
            bits = line.split("\t")
            if len(bits) != 3:
                continue
            old, new = split_rename(bits[2])
            c["path"], c["old"] = new, old
            c["add"] = None if bits[0] == "-" else int(bits[0])
            c["del"] = None if bits[1] == "-" else int(bits[1])
        commits.append(c)
    return {"path": path, "commits": commits}


def api_stats(repo, q):
    """Per-author aggregates + daily activity. Expensive -> cached by ref state."""
    ref = q.get("ref") or "--all"
    revs = ["--all"] if ref == "--all" else [check_rev(ref)]
    key = (q.get("repo"), "stats", ref, state_key(repo))

    def compute():
        if empty_repo(repo):
            return {"authors": [], "daily": {}, "total": 0}
        cmd = list(_GIT_BASE) + ["-C", repo, "log", "--format=" + RS + "%aN" + FS + "%aE" + FS + "%at" + FS + "%P",
                                  "--numstat", "--no-renames"] + revs
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=_GIT_ENV)
        authors = {}
        daily = defaultdict(int)
        daily_author = {}
        cur = None
        total = 0
        for raw in proc.stdout:
            line = raw.decode("utf-8", "replace").rstrip("\n")
            if line.startswith(RS):
                name, email, t, parents = (line[1:].split(FS) + ["", "", "0", ""])[:4]
                t = int(t or 0)
                k = name.strip().lower() or email.lower()
                a = authors.get(k)
                if a is None:
                    a = authors[k] = {"name": name, "emails": {}, "commits": 0, "merges": 0,
                                      "add": 0, "del": 0, "first": t, "last": t,
                                      "months": defaultdict(int), "dirs": defaultdict(int),
                                      "files": set()}
                a["emails"][email] = a["emails"].get(email, 0) + 1
                a["commits"] += 1
                if len(parents.split()) > 1:
                    a["merges"] += 1
                a["first"] = min(a["first"], t)
                a["last"] = max(a["last"], t)
                day = time.strftime("%Y-%m-%d", time.localtime(t))
                a["months"][day[:7]] += 1
                daily[day] += 1
                daily_author[(k, day)] = daily_author.get((k, day), 0) + 1
                cur = a
                total += 1
            elif line and cur is not None:
                bits = line.split("\t")
                if len(bits) == 3:
                    if bits[0] != "-":
                        cur["add"] += int(bits[0])
                        cur["del"] += int(bits[1])
                    p = bits[2]
                    d = p.rsplit("/", 1)[0] if "/" in p else "(root)"
                    d = "/".join(d.split("/")[:2])
                    cur["dirs"][d] += 1
                    if len(cur["files"]) < 100000:
                        cur["files"].add(p)
        proc.wait()
        result = []
        for k, a in authors.items():
            emails = sorted(a["emails"].items(), key=lambda e: -e[1])
            result.append({
                "key": k, "name": a["name"], "emails": [e for e, _ in emails],
                "commits": a["commits"], "merges": a["merges"], "add": a["add"], "del": a["del"],
                "first": a["first"], "last": a["last"], "months": dict(a["months"]),
                "files": len(a["files"]),
                "dirs": sorted(a["dirs"].items(), key=lambda d: -d[1])[:6],
            })
        result.sort(key=lambda a: -a["commits"])
        per_author_daily = defaultdict(dict)
        for (k, day), n in daily_author.items():
            per_author_daily[k][day] = n
        return {"authors": result, "daily": dict(daily), "total": total,
                "authorDaily": dict(per_author_daily)}

    return cached(key, compute, size=20)


def api_open(body):
    info = open_repo(body.get("source"))
    clear_cache(info["id"])
    return info


def api_recent(_q):
    items = sorted(_repos.values(), key=lambda r: -r.get("opened", 0))
    return {"repos": [dict(r, exists=os.path.isdir(r["path"])) for r in items]}


def api_forget(body):
    with _lock:
        _repos.pop(body.get("repo"), None)
        _save_recent()
    return {"ok": True}


def api_refresh(body):
    rid = body.get("repo")
    repo = get_repo(rid)
    info = _repos[rid]
    fetched = False
    if info.get("remote"):
        if OFFLINE:
            raise ApiError("Offline mode: fetching is disabled")
        git(repo, "fetch", "--prune", "--tags", "origin", "+refs/heads/*:refs/heads/*", timeout=1800)
        fetched = True
    clear_cache(rid)
    return {"ok": True, "fetched": fetched}


def api_suggest(q):
    """Directory autocomplete for the path box (local filesystem only)."""
    raw = q.get("prefix") or ""
    prefix = os.path.expanduser(raw) if raw else os.path.expanduser("~/")
    base, partial = os.path.split(prefix)
    base = base or "/"
    out = []
    try:
        names = sorted(os.listdir(base), key=str.lower)
    except OSError:
        return {"items": []}
    for n in names:
        if n.startswith(".") and not partial.startswith("."):
            continue
        if not n.lower().startswith(partial.lower()):
            continue
        full = os.path.join(base, n)
        if not os.path.isdir(full):
            continue
        is_git = os.path.exists(os.path.join(full, ".git")) or (
            n.endswith(".git") and os.path.exists(os.path.join(full, "HEAD")))
        shown = full
        home = os.path.expanduser("~")
        if raw.startswith("~") and full.startswith(home):
            shown = "~" + full[len(home):]
        out.append({"path": shown, "git": is_git})
        if len(out) >= 60:
            break
    out.sort(key=lambda i: (not i["git"],))
    return {"items": out}


def api_config(_q):
    return {"offline": OFFLINE, "version": "1.0.0"}


GET_ROUTES = {
    "/api/refs": api_refs,
    "/api/log": api_log,
    "/api/commit": api_commit,
    "/api/diff": api_diff,
    "/api/tree": api_tree,
    "/api/tree-last": api_tree_last,
    "/api/ls": api_ls,
    "/api/blob": api_blob,
    "/api/raw": api_raw,
    "/api/blame": api_blame,
    "/api/file-history": api_file_history,
    "/api/stats": api_stats,
}
GLOBAL_GET = {"/api/recent": api_recent, "/api/suggest": api_suggest, "/api/config": api_config}
POST_ROUTES = {"/api/open": api_open, "/api/forget": api_forget, "/api/refresh": api_refresh}

STATIC_TYPES = {".html": "text/html; charset=utf-8", ".js": "application/javascript; charset=utf-8",
                ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".ico": "image/x-icon"}


class Handler(BaseHTTPRequestHandler):
    server_version = "GitScope/1.0"
    allowed_hosts = set()

    def log_message(self, fmt, *args):
        if os.environ.get("GITSCOPE_DEBUG"):
            sys.stderr.write("%s\n" % (fmt % args))

    # Defends against DNS-rebinding: a random website can't talk to us
    # through a hostname that resolves to 127.0.0.1.
    def _host_ok(self):
        return (self.headers.get("Host") or "") in self.allowed_hosts

    def _send(self, status, body, ctype="application/json; charset=utf-8", extra=None):
        if isinstance(body, (dict, list)):
            body = json.dumps(body).encode()
        elif isinstance(body, str):
            body = body.encode()
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Security-Policy",
                         "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; "
                         "connect-src 'self'; script-src 'self'; frame-ancestors 'none'")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _err(self, e):
        status = getattr(e, "status", 500)
        self._send(status, {"error": str(e)})

    def do_GET(self):
        if not self._host_ok():
            return self._send(403, {"error": "Forbidden host"})
        url = urlparse(self.path)
        q = {k: v[-1] for k, v in parse_qs(url.query).items()}
        try:
            if url.path in GLOBAL_GET:
                return self._send(200, GLOBAL_GET[url.path](q))
            if url.path in GET_ROUTES:
                repo = get_repo(q.get("repo"))
                res = GET_ROUTES[url.path](repo, q)
                if isinstance(res, tuple) and res[0] == "raw":
                    ctype = res[1]
                    extra = {"Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox"}
                    self.send_response(200)
                    self.send_header("Content-Type", ctype)
                    self.send_header("Content-Length", str(len(res[2])))
                    self.send_header("X-Content-Type-Options", "nosniff")
                    for k, v in extra.items():
                        self.send_header(k, v)
                    self.end_headers()
                    self.wfile.write(res[2])
                    return
                return self._send(200, res)
            if url.path.startswith("/api/"):
                return self._send(404, {"error": "No such endpoint"})
            return self._static(url.path)
        except ApiError as e:
            return self._err(e)
        except Exception as e:  # noqa
            return self._err(ApiError("Internal error: %s" % e, 500))

    def do_POST(self):
        if not self._host_ok():
            return self._send(403, {"error": "Forbidden host"})
        # JSON content-type forces a CORS preflight for cross-site requests -> CSRF safe.
        if not (self.headers.get("Content-Type") or "").startswith("application/json"):
            return self._send(415, {"error": "JSON required"})
        url = urlparse(self.path)
        try:
            length = int(self.headers.get("Content-Length") or 0)
            body = json.loads(self.rfile.read(length) or b"{}")
            if url.path not in POST_ROUTES:
                return self._send(404, {"error": "No such endpoint"})
            return self._send(200, POST_ROUTES[url.path](body))
        except ApiError as e:
            return self._err(e)
        except Exception as e:  # noqa
            return self._err(ApiError("Internal error: %s" % e, 500))

    def _static(self, path):
        if path in ("", "/"):
            path = "/index.html"
        full = os.path.realpath(os.path.join(STATIC_DIR, path.lstrip("/")))
        if not full.startswith(os.path.realpath(STATIC_DIR) + os.sep) or not os.path.isfile(full):
            full = os.path.join(STATIC_DIR, "index.html")
        with open(full, "rb") as f:
            data = f.read()
        ext = os.path.splitext(full)[1]
        self._send(200, data, STATIC_TYPES.get(ext, "application/octet-stream"))


def serve(host="127.0.0.1", port=7777, initial=None, open_browser=True, offline=False):
    global OFFLINE
    OFFLINE = offline
    _load_recent()
    httpd = None
    for p in range(port, port + 20):
        try:
            httpd = ThreadingHTTPServer((host, p), Handler)
            port = p
            break
        except OSError:
            continue
    if httpd is None:
        sys.exit("Could not find a free port starting at %d" % port)
    Handler.allowed_hosts = {"%s:%d" % (h, port) for h in ("127.0.0.1", "localhost", host)}
    url = "http://127.0.0.1:%d/" % port
    if initial:
        try:
            info = open_repo(initial)
            url += "#/r/%s/history" % info["id"]
        except ApiError as e:
            print("Could not open %s: %s" % (initial, e))
    print("GitScope running at %s  (Ctrl+C to stop)" % url)
    if open_browser:
        import webbrowser
        threading.Timer(0.4, lambda: webbrowser.open(url)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nbye")
