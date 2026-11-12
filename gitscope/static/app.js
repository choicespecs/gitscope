/* GitScope front-end. Vanilla JS, no dependencies, talks only to the local server. */
(function () {
  "use strict";

  // ------------------------------------------------------------------ utils
  const $ = (sel, el) => (el || document).querySelector(sel);
  const $$ = (sel, el) => Array.from((el || document).querySelectorAll(sel));
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const short = (sha) => (sha || "").slice(0, 7);
  const fmtNum = (n) => (n == null ? "–" : Number(n).toLocaleString());
  const pad = (n) => String(n).padStart(2, "0");

  function fmtDate(t, withTime = true) {
    const d = new Date(t * 1000);
    const s = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    return withTime ? `${s} ${pad(d.getHours())}:${pad(d.getMinutes())}` : s;
  }
  function rel(t) {
    const s = Date.now() / 1000 - t;
    const units = [[31536000, "year"], [2592000, "month"], [604800, "week"], [86400, "day"], [3600, "hour"], [60, "minute"]];
    for (const [sec, name] of units) {
      const v = Math.floor(s / sec);
      if (v >= 1) return `${v} ${name}${v > 1 ? "s" : ""} ago`;
    }
    return "just now";
  }
  function initials(name) {
    const parts = String(name || "?").replace(/[^\p{L}\p{N} ._-]/gu, "").split(/[ ._-]+/).filter(Boolean);
    if (!parts.length) return "?";
    return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
  }
  function reEscape(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

  async function api(path, params) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params || {})) if (v !== undefined && v !== null && v !== "") qs.set(k, v);
    const res = await fetch(`/api/${path}?${qs}`);
    const data = await res.json().catch(() => ({ error: res.statusText }));
    if (!res.ok) throw new Error(data.error || res.statusText);
    return data;
  }
  async function post(path, body) {
    const res = await fetch(`/api/${path}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}),
    });
    const data = await res.json().catch(() => ({ error: res.statusText }));
    if (!res.ok) throw new Error(data.error || res.statusText);
    return data;
  }
  function toast(msg) {
    const t = $("#toast");
    t.textContent = msg; t.hidden = false;
    clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), 1800);
  }
  function copy(text) {
    navigator.clipboard && navigator.clipboard.writeText(text).then(() => toast("Copied " + text.slice(0, 40)));
  }
  const tip = {
    el: null,
    show(html, ev) {
      const el = (this.el = this.el || $("#tip"));
      el.innerHTML = html; el.hidden = false; this.move(ev);
    },
    move(ev) {
      if (!this.el || this.el.hidden) return;
      const r = this.el.getBoundingClientRect();
      let x = ev.clientX + 14, y = ev.clientY + 14;
      if (x + r.width > innerWidth - 8) x = ev.clientX - r.width - 14;
      if (y + r.height > innerHeight - 8) y = ev.clientY - r.height - 14;
      this.el.style.left = x + "px"; this.el.style.top = y + "px";
    },
    hide() { if (this.el) this.el.hidden = true; },
  };

  // ------------------------------------------------------------------ theme
  try { const t = localStorage.getItem("gs-theme"); if (t) document.documentElement.dataset.theme = t; } catch (e) {}
  $("#themeBtn").onclick = () => {
    const cur = document.documentElement.dataset.theme ||
      (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    const next = cur === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem("gs-theme", next); } catch (e) {}
  };

  // ------------------------------------------------------------------ state
  const S = {
    repoId: null, repo: null, refs: null, ref: "--all",
    stats: null, statsPromise: null, authorSlot: {}, // author lowercase name -> 1..8
  };

  function authorKey(name) { return String(name || "").trim().toLowerCase(); }
  function authorColor(name) {
    const slot = S.authorSlot[authorKey(name)];
    return slot ? `var(--s${slot})` : "var(--other)";
  }
  function avatar(name, cls = "") {
    return `<span class="av ${cls}" data-a="${esc(authorKey(name))}" style="background:${authorColor(name)}" title="${esc(name)}">${esc(initials(name))}</span>`;
  }
  function recolorAvatars() {
    $$(".av[data-a]").forEach((el) => {
      const slot = S.authorSlot[el.dataset.a];
      el.style.background = slot ? `var(--s${slot})` : "var(--other)";
    });
  }
  function loadStats() {
    if (S.stats) return Promise.resolve(S.stats);
    if (!S.statsPromise) {
      const rid = S.repoId;
      S.statsPromise = api("stats", { repo: rid, ref: S.ref }).then((st) => {
        if (rid !== S.repoId) return st;
        S.stats = st;
        S.authorSlot = {};
        st.authors.slice(0, 8).forEach((a, i) => (S.authorSlot[a.key] = i + 1));
        recolorAvatars();
        return st;
      }).catch((e) => { S.statsPromise = null; throw e; });
    }
    return S.statsPromise;
  }

  // ------------------------------------------------------------------ routing
  // #/                      home
  // #/r/<id>/<view>?k=v     repo views
  function parseHash() {
    const h = location.hash.replace(/^#/, "") || "/";
    const [p, qs] = h.split("?");
    const parts = p.split("/").filter(Boolean);
    const params = Object.fromEntries(new URLSearchParams(qs || ""));
    if (parts[0] === "r" && parts[1]) return { repo: parts[1], view: parts[2] || "history", params };
    return { view: "home", params };
  }
  function link(view, params) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params || {})) if (v !== undefined && v !== null && v !== "") qs.set(k, v);
    const s = qs.toString();
    return `#/r/${S.repoId}/${view}${s ? "?" + s : ""}`;
  }
  function go(view, params, replace) {
    const h = link(view, params);
    if (replace) history.replaceState(null, "", h); else location.hash = h;
  }

  let renderToken = 0;
  async function route() {
    const r = parseHash();
    const token = ++renderToken;
    tip.hide();
    if (r.view === "home") {
      S.repoId = null;
      $("#repoCtx").hidden = true; $("#refSelect").hidden = true; $("#refreshBtn").hidden = true;
      document.title = "GitScope";
      return renderHome();
    }
    if (r.repo !== S.repoId) {
      const app = $("#app");
      app.innerHTML = `<div class="spin">Opening repository…</div>`;
      try {
        const rec = await api("recent");
        const info = rec.repos.find((x) => x.id === r.repo);
        if (!info) throw new Error("This repository isn't registered anymore. Open it again from the home screen.");
        S.repoId = r.repo; S.repo = info; S.stats = null; S.statsPromise = null; S.authorSlot = {};
        S.refs = await api("refs", { repo: r.repo });
        S.ref = "--all";
      } catch (e) {
        S.repoId = null;
        app.innerHTML = `<div class="err">${esc(e.message)}</div><div class="empty"><a href="#/">← Back home</a></div>`;
        return;
      }
      setupRepoChrome();
      loadStats().catch(() => {});
    }
    if (token !== renderToken) return;
    if (r.params.ref !== undefined && r.params.ref !== S.ref) {
      S.ref = r.params.ref || "--all";
      $("#refSelect").value = S.ref;
    }
    $$("#tabs a").forEach((a) => a.classList.toggle("active", a.dataset.view === r.view));
    document.title = `${S.repo.name} · ${r.view} · GitScope`;
    const views = { history: renderHistory, files: renderFiles, authors: renderAuthors, activity: renderActivity };
    (views[r.view] || renderHistory)(r.params);
  }
  window.addEventListener("hashchange", route);

  function setupRepoChrome() {
    $("#repoCtx").hidden = false;
    $("#repoName").textContent = S.repo.name;
    $("#repoName").title = S.repo.path;
    $$("#tabs a").forEach((a) => (a.href = link(a.dataset.view, {})));
    const sel = $("#refSelect");
    const R = S.refs;
    let html = `<option value="--all">All branches</option>`;
    if (R.headRef || R.head) html += `<option value="HEAD">HEAD${R.headRef ? " (" + esc(R.headRef) + ")" : ""}</option>`;
    if (R.branches.length) html += `<optgroup label="Branches">${R.branches.map((b) => `<option value="${esc(b.name)}">${esc(b.name)}</option>`).join("")}</optgroup>`;
    if (R.remotes.length) html += `<optgroup label="Remote branches">${R.remotes.map((b) => `<option value="${esc(b.name)}">${esc(b.name)}</option>`).join("")}</optgroup>`;
    if (R.tags.length) html += `<optgroup label="Tags">${R.tags.slice(0, 500).map((b) => `<option value="${esc(b.name)}">${esc(b.name)}</option>`).join("")}</optgroup>`;
    sel.innerHTML = html; sel.value = S.ref; sel.hidden = false;
    sel.onchange = () => {
      S.ref = sel.value; S.stats = null; S.statsPromise = null;
      loadStats().catch(() => {});
      const r = parseHash();
      const params = Object.assign({}, r.params, { ref: S.ref === "--all" ? "" : S.ref });
      if (r.view === "files") { delete params.path; delete params.mode; }
      delete params.sha;
      go(r.view, params);
    };
    const rb = $("#refreshBtn");
    rb.hidden = false;
    rb.onclick = async () => {
      rb.disabled = true; toast("Reloading…");
      try {
        await post("refresh", { repo: S.repoId });
        S.refs = await api("refs", { repo: S.repoId });
        S.stats = null; S.statsPromise = null;
        setupRepoChrome(); loadStats().catch(() => {});
        route(); toast("Up to date");
      } catch (e) { toast(e.message); }
      rb.disabled = false;
    };
  }
  // the ref param used for API calls that need a single revision
  const singleRef = () => (S.ref === "--all" ? "HEAD" : S.ref);

  // ------------------------------------------------------------------ home
  async function renderHome() {
    const app = $("#app");
    app.innerHTML = `
      <div class="home">
        <h1>Trace your git history</h1>
        <p class="lead">Open a git repository on this machine to browse its commit graph, who changed what and when, and every diff — entirely on this machine.</p>
        <form class="open-box" id="openForm" autocomplete="off">
          <input id="src" placeholder="~/path/to/repo" spellcheck="false" autofocus>
          <button class="primary">Open</button>
          <div class="suggest" id="sug" hidden></div>
        </form>
        <div class="hint">Repositories are read straight from disk; nothing is cloned, fetched, or sent anywhere.
          Press <kbd>Tab</kbd> to autocomplete folders.</div>
        <div class="recent" id="recent"></div>
      </div>`;
    const input = $("#src"), sug = $("#sug");
    let items = [], hi = -1, sugTimer;
    async function suggest() {
      const v = input.value;
            try { items = (await api("suggest", { prefix: v || "~/" })).items; } catch (e) { items = []; }
      hi = -1;
      sug.innerHTML = items.map((it, i) => `<div data-i="${i}">${esc(it.path)}${it.git ? '<span class="tag">git</span>' : ""}</div>`).join("");
      sug.hidden = !items.length || document.activeElement !== input;
    }
    function pick(i) {
      if (!items[i]) return;
      input.value = items[i].path + (items[i].git ? "" : "/");
      input.focus();
      if (items[i].git) sug.hidden = true; else suggest();
    }
    input.addEventListener("input", () => { clearTimeout(sugTimer); sugTimer = setTimeout(suggest, 120); });
    input.addEventListener("focus", suggest);
    input.addEventListener("blur", () => setTimeout(() => (sug.hidden = true), 150));
    input.addEventListener("keydown", (e) => {
      if (sug.hidden || !items.length) return;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        hi = (hi + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
        $$("div", sug).forEach((d, i) => d.classList.toggle("hi", i === hi));
        $$("div", sug)[hi].scrollIntoView({ block: "nearest" });
      } else if (e.key === "Tab") {
        e.preventDefault(); pick(hi >= 0 ? hi : 0);
      } else if (e.key === "Enter" && hi >= 0) {
        e.preventDefault(); pick(hi);
      } else if (e.key === "Escape") sug.hidden = true;
    });
    sug.addEventListener("mousedown", (e) => { const d = e.target.closest("[data-i]"); if (d) { e.preventDefault(); pick(+d.dataset.i); } });
    $("#openForm").onsubmit = async (e) => {
      e.preventDefault();
      const btn = $("#openForm button");
      btn.disabled = true; btn.textContent = "Opening…";
      try {
        const info = await post("open", { source: input.value });
        location.hash = `#/r/${info.id}/history`;
      } catch (err) {
        toast(err.message);
        btn.disabled = false; btn.textContent = "Open";
      }
    };
    try {
      const rec = await api("recent");
      if (rec.repos.length) {
        $("#recent").innerHTML = `<h2>Recent</h2>` + rec.repos.map((r) => `
          <div class="recent-item" data-id="${esc(r.id)}">
            <div class="grow">
              <div class="nm">${esc(r.name)} ${r.exists ? "" : '<span class="badge">missing</span>'}</div>
              <div class="pth">${esc(r.path)}</div>
            </div>
            <span class="faint">${rel(r.opened)}</span>
            <button class="x" title="Remove from list" data-forget="${esc(r.id)}">×</button>
          </div>`).join("");
        $("#recent").onclick = async (e) => {
          const f = e.target.closest("[data-forget]");
          if (f) { e.stopPropagation(); await post("forget", { repo: f.dataset.forget }); return renderHome(); }
          const it = e.target.closest(".recent-item");
          if (it) {
            const r = rec.repos.find((x) => x.id === it.dataset.id);
            try { const info = await post("open", { source: r.path }); location.hash = `#/r/${info.id}/history`; }
            catch (err) { toast(err.message); }
          }
        };
      }
    } catch (e) {}
  }

  // ------------------------------------------------------------------ commit graph lanes
  // Incremental lane assignment over commits in topological order.
  function Graph() {
    this.lanes = [];   // lane -> sha it is waiting for
    this.colors = [];  // lane -> color index
    this.nextColor = 0;
    this.rows = [];
    this.maxLanes = 1;
  }
  Graph.prototype.add = function (c, parentsVisible) {
    const lanes = this.lanes, colors = this.colors;
    let col = lanes.indexOf(c.sha);
    const before = lanes.slice(), beforeColors = colors.slice();
    if (col === -1) {
      col = lanes.indexOf(null);
      if (col === -1) col = lanes.length;
      lanes[col] = c.sha; colors[col] = this.nextColor++;
      before[col] = null;
    }
    const nodeColor = colors[col];
    // other lanes converging into this commit
    const merging = [];
    for (let j = 0; j < lanes.length; j++) if (j !== col && lanes[j] === c.sha) { merging.push(j); lanes[j] = null; }
    const parents = parentsVisible ? c.parents : c.parents.slice(0, 1);
    const parentCols = [];
    if (parents.length === 0) {
      lanes[col] = null;
    } else {
      // first parent continues the lane (unless it is already tracked elsewhere)
      const existing = lanes.indexOf(parents[0]);
      if (existing !== -1 && existing !== col) { lanes[col] = null; parentCols.push(existing); }
      else { lanes[col] = parents[0]; parentCols.push(col); }
      for (let i = 1; i < parents.length; i++) {
        let k = lanes.indexOf(parents[i]);
        if (k === -1) {
          k = lanes.indexOf(null);
          if (k === -1) k = lanes.length;
          lanes[k] = parents[i]; colors[k] = this.nextColor++;
        }
        parentCols.push(k);
      }
    }
    while (lanes.length && lanes[lanes.length - 1] === null) { lanes.pop(); colors.pop(); }
    const row = { col, nodeColor, before, beforeColors, merging, parentCols, after: lanes.slice(), afterColors: colors.slice(), sha: c.sha };
    this.maxLanes = Math.max(this.maxLanes, before.length, lanes.length, col + 1);
    this.rows.push(row);
    return row;
  };
  const LANE_W = 14, ROW_H = 28;
  const laneColor = (i) => `var(--s${(i % 8) + 1})`;
  function graphSvg(row, width, merge) {
    const x = (i) => i * LANE_W + LANE_W / 2 + 2;
    const mid = ROW_H / 2;
    let s = "";
    // pass-through lanes
    for (let j = 0; j < row.before.length; j++) {
      const sha = row.before[j];
      if (!sha || j === row.col || row.merging.includes(j)) continue;
      if (row.after[j] === sha) s += `<path d="M${x(j)} 0V${ROW_H}" stroke="${laneColor(row.beforeColors[j])}"/>`;
    }
    if (row.before[row.col]) s += `<path d="M${x(row.col)} 0V${mid}" stroke="${laneColor(row.nodeColor)}"/>`;
    for (const j of row.merging) s += `<path d="M${x(j)} 0C${x(j)} ${mid} ${x(row.col)} ${mid - 6} ${x(row.col)} ${mid}" stroke="${laneColor(row.beforeColors[j])}"/>`;
    row.parentCols.forEach((k) => {
      const color = laneColor(row.afterColors[k] !== undefined ? row.afterColors[k] : row.nodeColor);
      if (k === row.col) s += `<path d="M${x(k)} ${mid}V${ROW_H}" stroke="${color}"/>`;
      else s += `<path d="M${x(row.col)} ${mid}C${x(row.col)} ${mid + 8} ${x(k)} ${mid + 4} ${x(k)} ${ROW_H}" stroke="${color}"/>`;
    });
    const nc = laneColor(row.nodeColor);
    const node = merge
      ? `<circle cx="${x(row.col)}" cy="${mid}" r="3.5" fill="var(--surface)" stroke="${nc}" stroke-width="2"/>`
      : `<circle cx="${x(row.col)}" cy="${mid}" r="4" fill="${nc}" stroke="var(--surface)" stroke-width="1.5"/>`;
    return `<svg class="g" width="${width}" height="${ROW_H}" fill="none" stroke-width="2">${s}${node}</svg>`;
  }

  function refBadges(refs) {
    return (refs || []).map((r) => {
      if (r.startsWith("HEAD -> ")) return `<span class="ref head">${esc(r.slice(8))}</span>`;
      if (r === "HEAD") return `<span class="ref head">HEAD</span>`;
      if (r.startsWith("tag: ")) return `<span class="ref tag">🏷 ${esc(r.slice(5))}</span>`;
      if (/\/HEAD$/.test(r)) return "";
      const isRemote = S.refs && S.refs.remotes.some((b) => b.name === r);
      return `<span class="ref ${isRemote ? "remote" : "branch"}">${esc(r)}</span>`;
    }).join("");
  }

  // ------------------------------------------------------------------ history view
  const FILTER_KEYS = ["author", "q", "path", "code", "since", "until", "nomerges"];
  let H = null; // history view state

  function renderHistory(params) {
    const app = $("#app");
    const filterSig = JSON.stringify([S.ref, ...FILTER_KEYS.map((k) => params[k] || "")]);
    if (H && H.sig === filterSig && H.repo === S.repoId && $("#logList")) {
      // only the selection changed
      if (params.sha !== H.selected) selectCommit(params.sha, false);
      return;
    }
    H = { sig: filterSig, repo: S.repoId, params, commits: [], skip: 0, more: true, loading: false,
      graph: new Graph(), selected: null, graphOn: !(params.author || params.q || params.code || params.since || params.until) };
    app.innerHTML = `
      <form class="filters" id="filt" autocomplete="off">
        <input type="search" name="q" placeholder="Message or SHA" value="${esc(params.q || "")}" title="Regex search in commit messages, or a commit SHA">
        <input type="search" name="author" placeholder="Author" list="authorList" value="${esc(params.author || "")}" title="Author name or email (regex)">
        <datalist id="authorList"></datalist>
        <input type="search" name="path" placeholder="Path (file or folder)" value="${esc(params.path || "")}" title="Only commits touching this path">
        <input type="search" name="code" placeholder="Code added/removed" value="${esc(params.code || "")}" title="Pickaxe: commits that add or remove this exact string (git log -S)">
        <label title="Since">From <input type="date" name="since" value="${esc(params.since || "")}"></label>
        <label title="Until">to <input type="date" name="until" value="${esc(params.until || "")}"></label>
        <label><input type="checkbox" name="nomerges" value="1" ${params.nomerges ? "checked" : ""}> No merges</label>
        <button class="primary">Filter</button>
        <button type="button" id="clearF">Clear</button>
      </form>
      <div class="split">
        <div class="pane-l" id="paneL">
          <div class="log-head"><span id="logCount">Loading…</span><span class="grow"></span><span class="faint"><kbd>j</kbd>/<kbd>k</kbd> navigate · <kbd>t</kbd> find file</span></div>
          <div class="log-list" id="logList" tabindex="0"></div>
        </div>
        <div class="resizer" id="resizer"></div>
        <div class="pane-r" id="detail"><div class="empty">Select a commit to see its changes.</div></div>
      </div>`;
    try { const w = localStorage.getItem("gs-split"); if (w) $("#paneL").style.width = w; } catch (e) {}
    setupResizer();
    loadStats().then((st) => {
      $("#authorList").innerHTML = st.authors.slice(0, 300).map((a) => `<option value="${esc(a.name)}">${a.commits} commits</option>`).join("");
    }).catch(() => {});
    const form = $("#filt");
    form.onsubmit = (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      const p = { ref: S.ref === "--all" ? "" : S.ref };
      for (const k of FILTER_KEYS) p[k] = (fd.get(k) || "").toString().trim();
      go("history", p);
    };
    $("#clearF").onclick = () => go("history", { ref: S.ref === "--all" ? "" : S.ref });
    const list = $("#logList");
    list.addEventListener("scroll", () => {
      if (list.scrollTop + list.clientHeight > list.scrollHeight - 600) loadMore();
    });
    list.addEventListener("click", (e) => {
      const row = e.target.closest(".row");
      if (row) go("history", Object.assign({}, H.params, { sha: row.dataset.sha }), true), selectCommit(row.dataset.sha, false);
    });
    list.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "j" && e.key !== "k") return;
      e.preventDefault();
      moveSel(e.key === "ArrowDown" || e.key === "j" ? 1 : -1);
    });
    loadMore(true).then(() => {
      if (params.sha) selectCommit(params.sha, true);
      else if (H.shaHit) selectCommit(H.shaHit, true);
    });
  }

  function moveSel(d) {
    const rows = $$("#logList .row");
    let i = rows.findIndex((r) => r.classList.contains("sel"));
    i = Math.max(0, Math.min(rows.length - 1, i + d));
    if (!rows[i]) return;
    const sha = rows[i].dataset.sha;
    go("history", Object.assign({}, H.params, { sha }), true);
    selectCommit(sha, true);
    if (i > rows.length - 20) loadMore();
  }

  function setupResizer() {
    const rz = $("#resizer"), left = $("#paneL");
    rz.onmousedown = (e) => {
      e.preventDefault(); rz.classList.add("drag");
      const startX = e.clientX, startW = left.getBoundingClientRect().width;
      const mm = (ev) => { left.style.width = Math.max(320, Math.min(innerWidth - 300, startW + ev.clientX - startX)) + "px"; };
      const mu = () => {
        rz.classList.remove("drag");
        removeEventListener("mousemove", mm); removeEventListener("mouseup", mu);
        try { localStorage.setItem("gs-split", left.style.width); } catch (e) {}
      };
      addEventListener("mousemove", mm); addEventListener("mouseup", mu);
    };
  }

  async function loadMore(first) {
    if (!H || H.loading || !H.more) return;
    H.loading = true;
    const h = H;
    const p = h.params;
    const list = $("#logList");
    let moreEl = $(".more-row", list);
    if (!moreEl) { moreEl = document.createElement("div"); moreEl.className = "more-row"; list.appendChild(moreEl); }
    moreEl.innerHTML = `<span class="spin" style="padding:0">Loading commits…</span>`;
    try {
      const res = await api("log", {
        repo: S.repoId, ref: S.ref, skip: h.skip, limit: first ? 250 : 500,
        author: p.author, q: p.q, path: p.path, code: p.code, since: p.since, until: p.until, nomerges: p.nomerges,
      });
      if (h !== H) return;
      h.more = res.more; h.skip += res.commits.length; h.shaHit = h.shaHit || res.shaHit;
      const html = [];
      for (const c of res.commits) {
        h.commits.push(c);
        const merge = c.parents.length > 1;
        let g;
        if (h.graphOn) {
          const row = h.graph.add(c, true);
          g = { row, merge };
        }
        html.push({ c, g, merge });
      }
      const width = h.graphOn ? Math.min(h.graph.maxLanes, 24) * LANE_W + 6 : 16;
      if (h.graphOn && width !== h.width) {
        // widen existing graph svgs so columns stay aligned
        $$("svg.g", list).forEach((s) => s.setAttribute("width", width));
      }
      h.width = width;
      const frag = html.map(({ c, g, merge }) => `
        <div class="row${c.sha === h.selected ? " sel" : ""}" data-sha="${c.sha}">
          ${g ? graphSvg(g.row, width, merge) : `<svg class="g" width="16" height="${ROW_H}"><circle cx="9" cy="${ROW_H / 2}" r="3.5" fill="var(--text-3)"/></svg>`}
          <span class="subj${merge ? " merge" : ""}">${refBadges(c.refs)}${esc(c.subject)}</span>
          <span class="who">${avatar(c.author)}<span class="n">${esc(c.author)}</span></span>
          <span class="when" title="${fmtDate(c.time)}">${esc(rel(c.time))}</span>
          <span class="sha">${short(c.sha)}</span>
        </div>`).join("");
      moreEl.insertAdjacentHTML("beforebegin", frag);
      moreEl.innerHTML = h.more ? "" : (h.commits.length ? `End of history · ${fmtNum(h.commits.length)} commits` : "");
      const filtered = FILTER_KEYS.some((k) => p[k]);
      $("#logCount").textContent = h.commits.length
        ? `${fmtNum(h.commits.length)}${h.more ? "+" : ""} commits${filtered ? " (filtered)" : ""}${S.ref !== "--all" ? " on " + S.ref : ""}`
        : "No commits match";
      if (!h.commits.length) list.innerHTML = `<div class="empty">No commits match these filters.</div>`;
    } catch (e) {
      moreEl.innerHTML = `<span class="err">${esc(e.message)}</span>`;
      h.more = false;
      $("#logCount").textContent = "Error";
    } finally {
      h.loading = false;
    }
    if (h.more && list.scrollHeight <= list.clientHeight + 200) loadMore();
  }

  // ------------------------------------------------------------------ commit detail
  let detailToken = 0;
  async function selectCommit(sha, scroll) {
    if (!sha || !H) return;
    H.selected = sha;
    const list = $("#logList");
    $$(".row.sel", list).forEach((r) => r.classList.remove("sel"));
    const row = $(`.row[data-sha^="${CSS.escape(sha)}"]`, list);
    if (row) { row.classList.add("sel"); if (scroll) row.scrollIntoView({ block: "nearest" }); }
    const det = $("#detail");
    const token = ++detailToken;
    det.innerHTML = `<div class="spin">Loading commit…</div>`;
    try {
      const c = await api("commit", { repo: S.repoId, sha });
      if (token !== detailToken) return;
      det.innerHTML = commitDetailHtml(c);
      det.scrollTop = 0;
      wireCommitDetail(det, c);
    } catch (e) {
      if (token === detailToken) det.innerHTML = `<div class="err">${esc(e.message)}</div>`;
    }
  }

  function bar5(add, del) {
    const tot = (add || 0) + (del || 0);
    if (!tot) return `<span class="bar5">${"<i></i>".repeat(5)}</span>`;
    const a = Math.round((add / tot) * 5), d = Math.min(5 - a, Math.round((del / tot) * 5));
    return `<span class="bar5">${'<i class="a"></i>'.repeat(a)}${'<i class="d"></i>'.repeat(d)}${"<i></i>".repeat(5 - a - d)}</span>`;
  }
  function nums(add, del, binary) {
    if (binary) return `<span class="nums faint">binary</span>`;
    return `<span class="nums"><span class="a">+${fmtNum(add)}</span> <span class="d">−${fmtNum(del)}</span></span>`;
  }

  function commitDetailHtml(c) {
    const [subject, ...rest] = c.message.split("\n");
    const body = rest.join("\n").trim();
    const totA = c.files.reduce((s, f) => s + (f.add || 0), 0);
    const totD = c.files.reduce((s, f) => s + (f.del || 0), 0);
    const committerDiff = c.committer !== c.author || Math.abs(c.ctime - c.time) > 60;
    const parentLinks = c.parents.map((p) => `<a data-goto="${p}" class="mono">${short(p)}</a>`).join(", ") || '<span class="faint">none (root commit)</span>';
    return `
      <div class="detail">
        <h2>${esc(subject)}</h2>
        ${body ? `<pre class="body">${esc(body)}</pre>` : ""}
        <div>${refBadges(c.refs)}</div>
        <div class="meta">
          <span class="k">Author</span>
          <span class="person">${avatar(c.author, "md")}<span><b>${esc(c.author)}</b> <span class="faint">&lt;${esc(c.email)}&gt;</span><br>
            <span class="muted">${fmtDate(c.time)}</span> <span class="faint">· ${rel(c.time)}</span></span></span>
          ${committerDiff ? `<span class="k">Committer</span><span>${esc(c.committer)} <span class="faint">· ${fmtDate(c.ctime)}</span></span>` : ""}
          <span class="k">Commit</span><span class="copy" data-copy="${c.sha}" title="Click to copy">${c.sha}</span>
          <span class="k">Parent${c.parents.length > 1 ? "s" : ""}</span><span>${parentLinks}${c.parents.length > 1 ? ` <span class="faint">· diff shown against</span> <select id="baseSel">${c.parents.map((p, i) => `<option value="${p}">${i === 0 ? "first" : "parent " + (i + 1)} (${short(p)})</option>`).join("")}</select>` : ""}</span>
          ${c.branches.length ? `<span class="k">In branches</span><span class="muted">${c.branches.slice(0, 8).map(esc).join(", ")}${c.branches.length > 8 ? ` +${c.branches.length - 8} more` : ""}</span>` : ""}
          ${c.firstTag ? `<span class="k">First release</span><span><span class="ref tag">🏷 ${esc(c.firstTag)}</span></span>` : ""}
        </div>
        <div class="actions">
          <a class="btn" href="${link("files", { ref: c.sha })}"><button type="button">Browse files at this commit</button></a>
          <a href="${link("history", { author: "^" + reEscape(c.author) + "$" })}"><button type="button">More by ${esc(c.author)}</button></a>
        </div>
        <div class="file-summary">
          <b>${c.files.length} file${c.files.length === 1 ? "" : "s"} changed</b>
          ${nums(totA, totD)} ${bar5(totA, totD)}
          <span class="grow"></span>
          <span class="diff-tools">
            <span class="seg" id="modeSeg"><button type="button" data-mode="uni">Unified</button><button type="button" data-mode="split">Split</button></span>
            <label class="faint"><input type="checkbox" id="wsChk"> Ignore whitespace</label>
            <button type="button" id="expandAll">Expand all</button>
            <button type="button" id="collapseAll">Collapse all</button>
          </span>
        </div>
        <div class="file-list">${c.files.map((f, i) => `
          <div data-jump="${i}" title="${esc(f.old ? f.old + " → " + f.path : f.path)}">
            <span class="st ${f.status}">${f.status}</span>
            <span class="fp"><bdi>${f.old ? `${esc(f.old)} → ` : ""}${esc(f.path)}</bdi></span>
            ${nums(f.add, f.del, f.binary)} ${bar5(f.add, f.del)}
          </div>`).join("")}</div>
        <div id="diffs">${c.files.map((f, i) => `
          <section class="fdiff collapsed" data-i="${i}" id="fd${i}">
            <header><span class="caret">▸</span><span class="st ${f.status}">${f.status}</span>
              <span class="p" title="${esc(f.path)}">${f.old ? `${esc(f.old)} → ` : ""}${esc(f.path)}</span>
              ${nums(f.add, f.del, f.binary)}
              <a data-file="${esc(f.path)}" data-status="${f.status}" title="View file at this commit">view</a>
              <a data-fh="${esc(f.path)}" title="Full history of this file">history</a>
            </header>
            <div class="dbody"></div>
          </section>`).join("")}</div>
      </div>`;
  }

  function diffMode() { try { return localStorage.getItem("gs-diffmode") || "uni"; } catch (e) { return "uni"; } }

  function wireCommitDetail(det, c) {
    let base = c.parents[0] || "";
    const loaded = new Map();
    const setMode = (m) => {
      try { localStorage.setItem("gs-diffmode", m); } catch (e) {}
      $$("#modeSeg button", det).forEach((b) => b.classList.toggle("on", b.dataset.mode === m));
      loaded.forEach((patch, i) => { $(`#fd${i} .dbody`, det).innerHTML = renderPatch(patch, m); });
    };
    setMode(diffMode());
    const ws = () => ($("#wsChk", det).checked ? "1" : "");
    async function load(i, open) {
      const sec = $(`#fd${i}`, det);
      if (open === undefined) open = sec.classList.contains("collapsed");
      sec.classList.toggle("collapsed", !open);
      $(".caret", sec).textContent = open ? "▾" : "▸";
      if (!open || loaded.has(i)) return;
      const f = c.files[i];
      const body = $(".dbody", sec);
      body.innerHTML = `<div class="spin">Loading diff…</div>`;
      try {
        const res = await api("diff", { repo: S.repoId, sha: c.sha, parent: base, path: f.path, old: f.old, ws: ws() });
        loaded.set(i, res.patch + (res.truncated ? "\n\\ GitScope: diff truncated (too large)" : ""));
        body.innerHTML = renderPatch(loaded.get(i), diffMode());
      } catch (e) { body.innerHTML = `<div class="err">${esc(e.message)}</div>`; }
    }
    // auto-expand while the total stays manageable
    let budget = 2500;
    c.files.forEach((f, i) => {
      const n = (f.add || 0) + (f.del || 0);
      if (i < 40 && n <= budget && !(f.status === "D" && n > 200)) { budget -= n; load(i, true); }
    });
    det.onclick = (e) => {
      const t = e.target;
      if (t.closest("[data-copy]")) return copy(t.closest("[data-copy]").dataset.copy);
      const gt = t.closest("[data-goto]");
      if (gt) { go("history", Object.assign({}, H.params, { sha: gt.dataset.goto })); return; }
      const fl = t.closest("[data-file]");
      if (fl) {
        const deleted = fl.dataset.status === "D";
        go("files", { ref: deleted ? c.parents[0] : c.sha, path: fl.dataset.file, mode: "source" });
        return;
      }
      const fh = t.closest("[data-fh]");
      if (fh) { go("files", { ref: S.ref === "--all" ? "" : S.ref, path: fh.dataset.fh, mode: "history" }); return; }
      const jump = t.closest("[data-jump]");
      if (jump) {
        const i = +jump.dataset.jump;
        load(i, true);
        $(`#fd${i}`, det).scrollIntoView({ block: "start" });
        return;
      }
      const head = t.closest(".fdiff > header");
      if (head) return load(+head.parentElement.dataset.i);
      const mb = t.closest("[data-mode]");
      if (mb) return setMode(mb.dataset.mode);
      if (t.id === "expandAll") c.files.forEach((_, i) => load(i, true));
      if (t.id === "collapseAll") $$(".fdiff", det).forEach((s) => { s.classList.add("collapsed"); $(".caret", s).textContent = "▸"; });
    };
    const reloadAll = () => {
      const open = [...loaded.keys()].filter((i) => !$(`#fd${i}`, det).classList.contains("collapsed"));
      loaded.clear();
      $$(".fdiff .dbody", det).forEach((b) => (b.innerHTML = ""));
      open.forEach((i) => load(i, true));
    };
    $("#wsChk", det).onchange = reloadAll;
    const bs = $("#baseSel", det);
    if (bs) bs.onchange = async () => {
      base = bs.value;
      const nc = await api("commit", { repo: S.repoId, sha: c.sha, parent: base });
      det.innerHTML = commitDetailHtml(nc);
      $("#baseSel", det).value = base;
      wireCommitDetail(det, Object.assign(nc, { parents: c.parents }));
    };
  }

  // ------------------------------------------------------------------ diff rendering
  function parsePatch(patch) {
    const out = { notes: [], hunks: [] };
    let h = null;
    for (const line of patch.split("\n")) {
      if (line.startsWith("@@")) {
        const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line);
        h = { header: line, oldN: m ? +m[1] : 0, newN: m ? +m[2] : 0, lines: [] };
        out.hunks.push(h);
      } else if (h) {
        if (line === "" ) { continue; }
        const t = line[0];
        if (t === "+" || t === "-" || t === " ") h.lines.push([t, line.slice(1)]);
        else if (t === "\\") h.lines.push(["\\", line.slice(1).trim()]);
      } else {
        if (/^Binary files/.test(line)) out.notes.push("Binary file changed");
        else if (/^(new|deleted) file mode/.test(line)) out.notes.push(line);
        else if (/^old mode|^new mode/.test(line)) out.notes.push(line);
        else if (/^similarity index/.test(line)) out.notes.push(line);
        else if (/^rename (from|to)/.test(line)) out.notes.push(line);
      }
    }
    return out;
  }
  // highlight the changed middle part of a paired -/+ line
  function wordDiff(a, b) {
    let p = 0;
    while (p < a.length && p < b.length && a[p] === b[p]) p++;
    let s = 0;
    while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
    const mk = (x) => {
      const mid = x.slice(p, x.length - s);
      if (!mid || (p === 0 && s === 0)) return esc(x);
      return esc(x.slice(0, p)) + "<mark>" + esc(mid) + "</mark>" + esc(x.slice(x.length - s));
    };
    if (Math.max(a.length, b.length) - p - s > 0.7 * Math.max(a.length, b.length)) return [esc(a), esc(b)];
    return [mk(a), mk(b)];
  }
  // group a hunk into ctx lines and (del[], add[]) change blocks
  function blocks(h) {
    const res = [];
    let o = h.oldN, n = h.newN, i = 0;
    const L = h.lines;
    while (i < L.length) {
      const [t, text] = L[i];
      if (t === " ") { res.push({ type: "ctx", o: o++, n: n++, text }); i++; }
      else if (t === "\\") { res.push({ type: "note", text }); i++; }
      else {
        const dels = [], adds = [];
        while (i < L.length && L[i][0] === "-") { dels.push({ o: o++, text: L[i][1] }); i++; }
        while (i < L.length && (L[i][0] === "+" || L[i][0] === "\\")) { if (L[i][0] === "+") adds.push({ n: n++, text: L[i][1] }); i++; }
        // pair up for word highlighting
        const pairs = Math.min(dels.length, adds.length);
        for (let k = 0; k < dels.length; k++) dels[k].html = esc(dels[k].text);
        for (let k = 0; k < adds.length; k++) adds[k].html = esc(adds[k].text);
        if (dels.length === adds.length) for (let k = 0; k < pairs; k++) {
          const [a, b] = wordDiff(dels[k].text, adds[k].text); dels[k].html = a; adds[k].html = b;
        }
        res.push({ type: "chg", dels, adds });
      }
    }
    return res;
  }
  function renderPatch(patch, mode) {
    const P = parsePatch(patch);
    let html = P.notes.length ? `<div class="dnote">${P.notes.map(esc).join("<br>")}</div>` : "";
    if (!P.hunks.length) return html || `<div class="dnote">No textual changes${patch.trim() ? "" : " (whitespace only, or mode change)"}.</div>`;
    const rows = [];
    if (mode === "split") {
      for (const h of P.hunks) {
        rows.push(`<tr class="hunk"><td colspan="4">${esc(h.header)}</td></tr>`);
        for (const b of blocks(h)) {
          if (b.type === "ctx") rows.push(`<tr><td class="ln">${b.o}</td><td class="c">${esc(b.text)}</td><td class="ln">${b.n}</td><td class="c">${esc(b.text)}</td></tr>`);
          else if (b.type === "note") rows.push(`<tr class="hunk"><td colspan="4">${esc(b.text)}</td></tr>`);
          else {
            const m = Math.max(b.dels.length, b.adds.length);
            for (let k = 0; k < m; k++) {
              const d = b.dels[k], a = b.adds[k];
              rows.push(`<tr>${d ? `<td class="ln del">${d.o}</td><td class="c del">${d.html}</td>` : `<td class="ln"></td><td class="c empty"></td>`}${a ? `<td class="ln add">${a.n}</td><td class="c add">${a.html}</td>` : `<td class="ln"></td><td class="c empty"></td>`}</tr>`);
            }
          }
        }
      }
      return html + `<table class="diff sbs">${rows.join("")}</table>`;
    }
    for (const h of P.hunks) {
      rows.push(`<tr class="hunk"><td colspan="3">${esc(h.header)}</td></tr>`);
      for (const b of blocks(h)) {
        if (b.type === "ctx") rows.push(`<tr><td class="ln">${b.o}</td><td class="ln">${b.n}</td><td class="c"><span class="sg"> </span>${esc(b.text)}</td></tr>`);
        else if (b.type === "note") rows.push(`<tr class="hunk"><td colspan="3">${esc(b.text)}</td></tr>`);
        else {
          for (const d of b.dels) rows.push(`<tr class="del"><td class="ln">${d.o}</td><td class="ln"></td><td class="c del"><span class="sg">-</span>${d.html}</td></tr>`);
          for (const a of b.adds) rows.push(`<tr class="add"><td class="ln"></td><td class="ln">${a.n}</td><td class="c add"><span class="sg">+</span>${a.html}</td></tr>`);
        }
      }
    }
    return html + `<table class="diff uni">${rows.join("")}</table>`;
  }

  // ------------------------------------------------------------------ files view
  function renderFiles(params) {
    const ref = params.ref || singleRef();
    const path = params.path || "";
    const app = $("#app");
    const parts = path ? path.split("/") : [];
    const refLabel = /^[0-9a-f]{40}$/.test(ref) ? short(ref) : ref;
    const crumbs = [`<a href="${link("files", { ref: params.ref })}"><b>${esc(S.repo.name)}</b></a>`]
      .concat(parts.map((p, i) => {
        const sub = parts.slice(0, i + 1).join("/");
        return i === parts.length - 1 ? `<b>${esc(p)}</b>` : `<a href="${link("files", { ref: params.ref, path: sub })}">${esc(p)}</a>`;
      })).join(`<span class="sep">/</span>`);
    app.innerHTML = `
      <div class="files"><div class="files-inner">
        <div class="crumbs">${crumbs}<span class="grow"></span>
          <span class="badge" title="Revision being browsed">@ ${esc(refLabel)}</span>
          <button id="findBtn" title="Go to file (t)">Go to file <kbd>t</kbd></button></div>
        <div id="fileBody"><div class="spin">Loading…</div></div>
      </div></div>`;
    $("#findBtn").onclick = () => openFinder(ref, params.ref);
    // decide dir vs file by asking for the tree first
    const parent = parts.slice(0, -1).join("/");
    const name = parts[parts.length - 1];
    (async () => {
      let isFile = false;
      if (path) {
        try {
          const t = await api("tree", { repo: S.repoId, ref, path: parent });
          const e = t.entries.find((x) => x.name === name);
          if (!e) throw new Error(`"${path}" does not exist at ${refLabel}.`);
          isFile = e.type === "blob";
        } catch (e) {
          $("#fileBody").innerHTML = `<div class="err">${esc(e.message)}</div>` +
            `<div class="empty"><a href="${link("files", { path, mode: "history" })}">Show history of this path on HEAD</a></div>`;
          return;
        }
      }
      if (isFile) renderFileView(ref, params);
      else renderDir(ref, path, params);
    })();
  }

  async function renderDir(ref, path, params) {
    const body = $("#fileBody");
    try {
      const t = await api("tree", { repo: S.repoId, ref, path });
      body.innerHTML = `
        <div class="box">
          <header><span class="muted">${t.entries.length} entries</span><span class="grow"></span>
            <a href="${link("history", { path, ref: params.ref })}">Commits touching ${path ? "this folder" : "the repo"} →</a></header>
          <table class="ls"><tbody>
            ${path ? `<tr data-up="1"><td class="nm"><a href="${link("files", { ref: params.ref, path: path.split("/").slice(0, -1).join("/") })}">..</a></td><td></td><td></td><td></td></tr>` : ""}
            ${t.entries.map((e) => {
              const p = (path ? path + "/" : "") + e.name;
              const icon = e.type === "tree" ? '<span class="ico dir">▣</span>' : e.type === "commit" ? '<span class="ico">⇲</span>' : '<span class="ico">▤</span>';
              const href = e.type === "commit" ? "" : link("files", { ref: params.ref, path: p });
              return `<tr data-n="${esc(e.name)}"><td class="nm">${icon} ${href ? `<a href="${href}">${esc(e.name)}</a>` : esc(e.name) + ' <span class="faint">(submodule)</span>'}</td>
                <td class="who"></td><td class="msg"></td><td class="dt"></td></tr>`;
            }).join("")}
          </tbody></table>
        </div>
        <div id="readme"></div>`;
      // last commit per entry, async
      api("tree-last", { repo: S.repoId, ref, path }).then((res) => {
        $$("tr[data-n]", body).forEach((tr) => {
          const c = res.last[tr.dataset.n];
          if (!c) return;
          tr.children[1].innerHTML = `<span class="au-name" style="gap:6px">${avatar(c.author)}<span class="muted">${esc(c.author)}</span></span>`;
          tr.children[2].innerHTML = `<a style="color:inherit" href="${link("history", { sha: c.sha })}" title="${esc(c.subject)}">${esc(c.subject)}</a>`;
          tr.children[3].textContent = rel(c.time);
          tr.children[3].title = fmtDate(c.time);
        });
      }).catch(() => {});
      const readme = t.entries.find((e) => /^readme(\.(md|txt|rst))?$/i.test(e.name) && e.type === "blob");
      if (readme) {
        const b = await api("blob", { repo: S.repoId, ref, path: (path ? path + "/" : "") + readme.name });
        if (b.text != null) $("#readme").innerHTML = `<div class="box" style="margin-top:16px"><header><b>${esc(readme.name)}</b></header><pre class="src" style="padding:12px 16px;white-space:pre-wrap">${esc(b.text)}</pre></div>`;
      }
    } catch (e) { body.innerHTML = `<div class="err">${esc(e.message)}</div>`; }
  }

  function renderFileView(ref, params) {
    const path = params.path;
    const mode = params.mode || "source";
    const body = $("#fileBody");
    body.innerHTML = `
      <div class="box">
        <header>
          <span class="seg">
            <button data-m="source" class="${mode === "source" ? "on" : ""}">Source</button>
            <button data-m="blame" class="${mode === "blame" ? "on" : ""}">Blame</button>
            <button data-m="history" class="${mode === "history" ? "on" : ""}">History</button>
          </span>
          <span class="muted" id="fmeta"></span><span class="grow"></span>
          <span id="fextra"></span>
        </header>
        <div id="fcontent"><div class="spin">Loading…</div></div>
      </div>`;
    $$("[data-m]", body).forEach((b) => (b.onclick = () => go("files", Object.assign({}, params, { mode: b.dataset.m }), true) || route()));
    if (mode === "blame") return renderBlame(ref, path);
    if (mode === "history") return renderFileHistory(path, params);
    renderSource(ref, path);
  }

  async function renderSource(ref, path) {
    const box = $("#fcontent");
    try {
      if (/\.(png|jpe?g|gif|svg|webp|ico|bmp)$/i.test(path)) {
        box.innerHTML = `<div class="img-view"><img alt="${esc(path)}" src="/api/raw?${new URLSearchParams({ repo: S.repoId, ref, path })}"></div>`;
        return;
      }
      const b = await api("blob", { repo: S.repoId, ref, path });
      $("#fmeta").textContent = `${fmtNum(b.size)} bytes${b.text != null ? " · " + fmtNum(b.text.split("\n").length) + " lines" : ""}`;
      if (b.tooLarge) { box.innerHTML = `<div class="dnote">File is too large to display (${fmtNum(b.size)} bytes).</div>`; return; }
      if (b.binary) { box.innerHTML = `<div class="dnote">Binary file.</div>`; return; }
      const lines = b.text.replace(/\n$/, "").split("\n");
      box.innerHTML = `<div style="overflow:auto"><table class="src">${lines.map((l, i) => `<tr id="L${i + 1}"><td class="ln">${i + 1}</td><td>${esc(l)}</td></tr>`).join("")}</table></div>`;
    } catch (e) { box.innerHTML = `<div class="err">${esc(e.message)}</div>`; }
  }

  async function renderBlame(ref, path) {
    const box = $("#fcontent");
    box.innerHTML = `<div class="spin">Running git blame…</div>`;
    try {
      const b = await api("blame", { repo: S.repoId, ref, path });
      const commits = Object.values(b.commits);
      const times = commits.map((c) => c.time || 0);
      const tMin = Math.min(...times), tMax = Math.max(...times);
      const ageVar = (t) => {
        if (tMax === tMin) return "var(--q3)";
        const f = (t - tMin) / (tMax - tMin);
        return `var(--q${Math.min(4, 1 + Math.floor(f * 4))})`;
      };
      $("#fmeta").textContent = `${fmtNum(b.lines.length)} lines · ${commits.length} commits · ${new Set(commits.map((c) => c.author)).size} authors`;
      // per-author line share for this file
      const share = {};
      b.lines.forEach(([sha]) => { const a = b.commits[sha].author; share[a] = (share[a] || 0) + 1; });
      const top = Object.entries(share).sort((x, y) => y[1] - x[1]);
      $("#fextra").innerHTML = `<span class="legend-age">older <i style="background:var(--q1)"></i><i style="background:var(--q2)"></i><i style="background:var(--q3)"></i><i style="background:var(--q4)"></i> newer</span>`;
      const rows = [];
      let prev = null;
      b.lines.forEach(([sha, text], i) => {
        const c = b.commits[sha];
        const first = sha !== prev;
        prev = sha;
        rows.push(`<tr class="${first ? "gs" : ""}"><td class="bl">${first ? `<span class="age" style="background:${ageVar(c.time)}"></span><div class="bl-in">${avatar(c.author)}<a class="s" href="${link("history", { sha })}" title="${esc(c.subject)}\n${esc(c.author)} · ${fmtDate(c.time)}">${esc(c.subject || short(sha))}</a><span class="d">${fmtDate(c.time, false)}</span></div>`
          : `<span class="age" style="background:${ageVar(c.time)}"></span>`}</td><td class="ln">${i + 1}</td><td>${esc(text)}</td></tr>`);
      });
      box.innerHTML = `
        <div style="padding:10px 12px;border-bottom:1px solid var(--border)">
          <div class="muted" style="font-size:12px">Who wrote the current lines</div>
          <div class="contrib">${top.map(([a, n]) => `<i style="flex:${n};background:${authorColor(a)}" data-tipa="${esc(a)}" data-tipn="${n}"></i>`).join("")}</div>
          <div class="legend">${top.slice(0, 10).map(([a, n]) => `<span>${avatar(a)}${esc(a)} <b>${Math.round((n / b.lines.length) * 100)}%</b></span>`).join("")}</div>
        </div>
        <div style="overflow:auto"><table class="src blame">${rows.join("")}</table></div>`;
      wireContribTips(box, b.lines.length);
    } catch (e) { box.innerHTML = `<div class="err">${esc(e.message)}</div>`; }
  }

  function wireContribTips(root, total) {
    $$("[data-tipa]", root).forEach((el) => {
      el.onmousemove = (ev) => tip.show(`<div class="t">${esc(el.dataset.tipa)}</div>${fmtNum(+el.dataset.tipn)} · ${Math.round((el.dataset.tipn / total) * 100)}%`, ev);
      el.onmouseleave = () => tip.hide();
    });
  }

  async function renderFileHistory(path, params) {
    const box = $("#fcontent");
    box.innerHTML = `<div class="spin">Tracing history (following renames)…</div>`;
    try {
      const res = await api("file-history", { repo: S.repoId, path, ref: params.ref || singleRef() });
      const cs = res.commits;
      if (!cs.length) { box.innerHTML = `<div class="empty">No commits found for this path.</div>`; return; }
      const by = {};
      cs.forEach((c) => { by[c.author] = (by[c.author] || 0) + 1; });
      const top = Object.entries(by).sort((a, b) => b[1] - a[1]);
      $("#fmeta").textContent = `${cs.length} commits · ${top.length} authors · created ${rel(cs[cs.length - 1].time)}`;
      box.innerHTML = `
        <div style="padding:10px 12px;border-bottom:1px solid var(--border)">
          <div class="muted" style="font-size:12px">Commits to this file by author</div>
          <div class="contrib">${top.map(([a, n]) => `<i style="flex:${n};background:${authorColor(a)}" data-tipa="${esc(a)}" data-tipn="${n}"></i>`).join("")}</div>
          <div class="legend">${top.slice(0, 10).map(([a, n]) => `<span>${avatar(a)}${esc(a)} <b>${n}</b></span>`).join("")}</div>
        </div>
        ${cs.map((c, i) => `
          <div class="fh-row" data-i="${i}">
            <div class="fh-line">
              <span class="caret">▸</span>${avatar(c.author)}
              <span class="s"><b>${esc(c.subject)}</b> <span class="faint">${esc(c.author)}</span>${c.old ? ` <span class="badge">renamed from ${esc(c.old)}</span>` : ""}</span>
              ${nums(c.add, c.del, c.add == null)}
              <span class="faint" title="${fmtDate(c.time)}" style="width:90px;text-align:right">${rel(c.time)}</span>
              <a class="mono" href="${link("history", { sha: c.sha })}" title="Open full commit">${short(c.sha)}</a>
            </div>
            <div class="fh-diff" hidden></div>
          </div>`).join("")}`;
      wireContribTips(box, cs.length);
      box.onclick = async (e) => {
        if (e.target.closest("a")) return;
        const line = e.target.closest(".fh-line");
        if (!line) return;
        const row = line.parentElement, d = $(".fh-diff", row), c = cs[+row.dataset.i];
        d.hidden = !d.hidden;
        $(".caret", line).textContent = d.hidden ? "▸" : "▾";
        if (!d.hidden && !d.dataset.loaded) {
          d.dataset.loaded = 1; d.innerHTML = `<div class="spin">Loading diff…</div>`;
          try {
            const r = await api("diff", { repo: S.repoId, sha: c.sha, path: c.path, old: c.old });
            d.innerHTML = `<div class="fdiff"><div class="dbody">${renderPatch(r.patch, diffMode())}</div></div>`;
          } catch (err) { d.innerHTML = `<div class="err">${esc(err.message)}</div>`; }
        }
      };
    } catch (e) { box.innerHTML = `<div class="err">${esc(e.message)}</div>`; }
  }

  // fuzzy "go to file"
  async function openFinder(ref, refParam) {
    if ($(".finder-bg")) return;
    const bg = document.createElement("div");
    bg.className = "finder-bg";
    bg.innerHTML = `<div class="finder"><input placeholder="Type to find a file…" spellcheck="false"><div class="res"><div class="faint">Loading file list…</div></div></div>`;
    document.body.appendChild(bg);
    const input = $("input", bg), res = $(".res", bg);
    input.focus();
    const close = () => bg.remove();
    bg.onmousedown = (e) => { if (e.target === bg) close(); };
    let paths = [];
    try { paths = (await api("ls", { repo: S.repoId, ref })).paths; } catch (e) { res.innerHTML = `<div class="err">${esc(e.message)}</div>`; return; }
    let hits = [], hi = 0;
    function score(p, q) {
      // subsequence match; prefer matches in the basename and contiguous runs
      let i = 0, s = 0, last = -2, idx = [];
      const lp = p.toLowerCase();
      for (const ch of q) {
        const j = lp.indexOf(ch, i);
        if (j === -1) return null;
        s += j === last + 1 ? 3 : 1;
        if (j > lp.lastIndexOf("/")) s += 2;
        idx.push(j); last = j; i = j + 1;
      }
      return { s: s - p.length * 0.01, idx };
    }
    function update() {
      const q = input.value.toLowerCase().replace(/\s+/g, "");
      hits = [];
      if (!q) hits = paths.slice(0, 50).map((p) => ({ p, idx: [] }));
      else {
        for (const p of paths) { const r = score(p, q); if (r) hits.push({ p, s: r.s, idx: r.idx }); }
        hits.sort((a, b) => b.s - a.s); hits = hits.slice(0, 50);
      }
      hi = 0;
      res.innerHTML = hits.map((h, i) => {
        const set = new Set(h.idx);
        const txt = [...h.p].map((ch, k) => (set.has(k) ? `<b>${esc(ch)}</b>` : esc(ch))).join("");
        return `<div data-i="${i}" class="${i === 0 ? "hi" : ""}">${txt}</div>`;
      }).join("") || `<div class="faint">No matches</div>`;
    }
    const pick = (i) => { if (hits[i]) { close(); go("files", { ref: refParam, path: hits[i].p }); } };
    input.oninput = update;
    input.onkeydown = (e) => {
      if (e.key === "Escape") close();
      else if (e.key === "Enter") pick(hi);
      else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        hi = Math.max(0, Math.min(hits.length - 1, hi + (e.key === "ArrowDown" ? 1 : -1)));
        $$("div", res).forEach((d, i) => d.classList.toggle("hi", i === hi));
        $$("div", res)[hi].scrollIntoView({ block: "nearest" });
      }
    };
    res.onclick = (e) => { const d = e.target.closest("[data-i]"); if (d) pick(+d.dataset.i); };
    update();
  }
  document.addEventListener("keydown", (e) => {
    if (e.key !== "t" || !S.repoId || e.metaKey || e.ctrlKey) return;
    if (/INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) return;
    e.preventDefault();
    openFinder(singleRef(), S.ref === "--all" ? "" : S.ref);
  });

  // ------------------------------------------------------------------ authors
  let auSort = { key: "commits", dir: -1 };
  async function renderAuthors(params) {
    const app = $("#app");
    app.innerHTML = `<div class="page"><div class="page-inner" id="au"><div class="spin">Crunching history (first load of a big repo can take a while)…</div></div></div>`;
    let st;
    try { st = await loadStats(); } catch (e) { $("#au").innerHTML = `<div class="err">${esc(e.message)}</div>`; return; }
    const box = $("#au");
    if (!box) return;
    if (!st.authors.length) { box.innerHTML = `<div class="empty">No commits yet.</div>`; return; }
    const first = Math.min(...st.authors.map((a) => a.first)), last = Math.max(...st.authors.map((a) => a.last));
    const totA = st.authors.reduce((s, a) => s + a.add, 0), totD = st.authors.reduce((s, a) => s + a.del, 0);
    // month axis shared by all sparklines so they're comparable
    const months = monthRange(first, last);
    const draw = () => {
      const filter = ($("#auFilter") && $("#auFilter").value.toLowerCase()) || "";
      const list = st.authors
        .filter((a) => !filter || a.name.toLowerCase().includes(filter) || a.emails.some((e) => e.toLowerCase().includes(filter)))
        .sort((a, b) => {
          const k = auSort.key;
          const va = k === "name" ? a.name.toLowerCase() : k === "span" ? a.last - a.first : a[k];
          const vb = k === "name" ? b.name.toLowerCase() : k === "span" ? b.last - b.first : b[k];
          return (va < vb ? -1 : va > vb ? 1 : 0) * auSort.dir;
        });
      const max = Math.max(...st.authors.map((a) => a.commits));
      const th = (k, label, cls = "") => `<th data-k="${k}" class="${cls}">${label}${auSort.key === k ? (auSort.dir < 0 ? " ↓" : " ↑") : ""}</th>`;
      $("#auTable").innerHTML = `<table class="au">
        <thead><tr>${th("name", "Author")}${th("commits", "Commits", "num")}<th>Share</th>${th("add", "Lines +", "num")}${th("del", "Lines −", "num")}${th("files", "Files", "num")}${th("first", "First commit")}${th("last", "Last commit")}<th>Activity (${esc(months[0])} → ${esc(months[months.length - 1])})</th><th>Mostly works in</th></tr></thead>
        <tbody>${list.map((a) => `<tr>
          <td><div class="au-name">${avatar(a.name, "md")}<div><a href="${link("history", { author: "^" + reEscape(a.name) + "$" })}"><b>${esc(a.name)}</b></a><div class="e">${esc(a.emails.slice(0, 2).join(", "))}${a.emails.length > 2 ? ` +${a.emails.length - 2}` : ""}</div></div></div></td>
          <td class="num"><b>${fmtNum(a.commits)}</b>${a.merges ? `<div class="faint" style="font-size:11px">${fmtNum(a.merges)} merges</div>` : ""}</td>
          <td><span class="share"><i style="width:${(a.commits / max) * 100}%;background:${authorColor(a.name)}"></i></span> <span class="faint">${((a.commits / st.total) * 100).toFixed(1)}%</span></td>
          <td class="num" style="color:var(--s3)">+${fmtNum(a.add)}</td>
          <td class="num" style="color:var(--s8)">−${fmtNum(a.del)}</td>
          <td class="num">${fmtNum(a.files)}</td>
          <td title="${fmtDate(a.first)}">${fmtDate(a.first, false)}</td>
          <td title="${fmtDate(a.last)}">${fmtDate(a.last, false)} <div class="faint" style="font-size:11px">${rel(a.last)}</div></td>
          <td>${sparkline(a, months)}</td>
          <td class="dirs">${a.dirs.slice(0, 3).map(([d, n]) => `<a style="color:inherit" href="${link("history", { author: "^" + reEscape(a.name) + "$", path: d === "(root)" ? "" : d })}">${esc(d)}</a> <span class="faint">${n}</span>`).join("<br>")}</td>
        </tr>`).join("")}</tbody></table>`;
      $$("#auTable th[data-k]").forEach((t) => (t.onclick = () => {
        auSort = { key: t.dataset.k, dir: auSort.key === t.dataset.k ? -auSort.dir : (t.dataset.k === "name" ? 1 : -1) };
        draw();
      }));
      wireSparkTips($("#auTable"), months);
    };
    box.innerHTML = `
      <div class="tiles">
        <div class="tile"><div class="v">${fmtNum(st.authors.length)}</div><div class="l">Authors</div></div>
        <div class="tile"><div class="v">${fmtNum(st.total)}</div><div class="l">Commits${S.ref !== "--all" ? " on " + esc(S.ref) : " (all branches)"}</div></div>
        <div class="tile"><div class="v" style="color:var(--s3)">+${fmtNum(totA)}</div><div class="l">Lines added</div></div>
        <div class="tile"><div class="v" style="color:var(--s8)">−${fmtNum(totD)}</div><div class="l">Lines removed</div></div>
        <div class="tile"><div class="v">${fmtDate(first, false)}</div><div class="l">First commit · ${rel(first)}</div></div>
        <div class="tile"><div class="v">${fmtDate(last, false)}</div><div class="l">Latest commit · ${rel(last)}</div></div>
      </div>
      <div class="filters" style="border:1px solid var(--border);border-radius:8px 8px 0 0;border-bottom:none">
        <input type="search" id="auFilter" placeholder="Filter authors…">
        <span class="faint">Click an author to see their commits · click a folder to see their commits there · click a column to sort</span>
      </div>
      <div id="auTable" style="border:1px solid var(--border);border-radius:0 0 8px 8px;overflow:auto"></div>`;
    $("#auFilter").oninput = draw;
    draw();
  }

  function monthRange(t0, t1) {
    const out = [];
    const d = new Date(t0 * 1000); d.setDate(1);
    const end = new Date(t1 * 1000);
    while (d <= end || (d.getFullYear() === end.getFullYear() && d.getMonth() === end.getMonth())) {
      out.push(`${d.getFullYear()}-${pad(d.getMonth() + 1)}`);
      d.setMonth(d.getMonth() + 1);
      if (out.length > 1200) break;
    }
    return out;
  }
  function sparkline(a, months) {
    const W = 180, Hh = 26;
    const vals = months.map((m) => a.months[m] || 0);
    const max = Math.max(1, ...vals);
    const bw = W / months.length;
    const bars = vals.map((v, i) => v ? `<rect x="${(i * bw).toFixed(2)}" y="${(Hh - (v / max) * (Hh - 2)).toFixed(2)}" width="${Math.max(1, bw - (bw > 3 ? 1 : 0)).toFixed(2)}" height="${((v / max) * (Hh - 2)).toFixed(2)}" fill="${authorColor(a.name)}" rx="${bw > 4 ? 1 : 0}"/>` : "").join("");
    return `<svg class="spark" data-key="${esc(a.key)}" width="${W}" height="${Hh}" style="display:block"><line x1="0" x2="${W}" y1="${Hh - 0.5}" y2="${Hh - 0.5}" stroke="var(--border)"/>${bars}</svg>`;
  }
  function wireSparkTips(root, months) {
    $$("svg.spark", root).forEach((svg) => {
      const a = S.stats.authors.find((x) => x.key === svg.dataset.key);
      svg.onmousemove = (ev) => {
        const r = svg.getBoundingClientRect();
        const i = Math.max(0, Math.min(months.length - 1, Math.floor(((ev.clientX - r.left) / r.width) * months.length)));
        tip.show(`<div class="t">${esc(a.name)}</div>${months[i]}: <b>${a.months[months[i]] || 0}</b> commits`, ev);
      };
      svg.onmouseleave = () => tip.hide();
    });
  }

  // ------------------------------------------------------------------ activity
  async function renderActivity(params) {
    const app = $("#app");
    app.innerHTML = `<div class="page"><div class="page-inner" id="act"><div class="spin">Crunching history…</div></div></div>`;
    let st;
    try { st = await loadStats(); } catch (e) { $("#act").innerHTML = `<div class="err">${esc(e.message)}</div>`; return; }
    const box = $("#act");
    if (!box) return;
    if (!st.total) { box.innerHTML = `<div class="empty">No commits yet.</div>`; return; }
    const days = Object.keys(st.daily).sort();
    const years = [...new Set(days.map((d) => d.slice(0, 4)))].sort().reverse();
    const year = params.year && years.includes(params.year) ? params.year : "last";
    const who = params.who || "";
    box.innerHTML = `
      <div class="card">
        <div class="card-head">
          <div><h3>Commit calendar</h3><div class="sub" id="heatSub"></div></div>
          <div class="ctrl">
            <select id="heatWho"><option value="">Everyone</option>${st.authors.slice(0, 200).map((a) => `<option value="${esc(a.key)}" ${a.key === who ? "selected" : ""}>${esc(a.name)} (${a.commits})</option>`).join("")}</select>
            <select id="heatYear"><option value="last">Last 12 months</option>${years.map((y) => `<option ${y === year ? "selected" : ""}>${y}</option>`).join("")}</select>
          </div>
        </div>
        <div class="chart-wrap" id="heat"></div>
        <div class="legend"><span class="heat-scale">Less <i style="background:var(--q0)"></i><i style="background:var(--q1)"></i><i style="background:var(--q2)"></i><i style="background:var(--q3)"></i><i style="background:var(--q4)"></i> More</span><span class="faint">Click a day to see its commits</span></div>
      </div>
      <div class="card">
        <div class="card-head"><div><h3>Commits per month by author</h3><div class="sub">Top 8 authors by commit count; everyone else is grouped as “Other”. Click a bar to see that month's commits.</div></div></div>
        <div class="chart-wrap" id="stack"></div>
        <div class="legend" id="stackLegend"></div>
      </div>
      <div class="card">
        <div class="card-head"><div><h3>When commits happen</h3><div class="sub">Day of week × hour of day (local time)</div></div></div>
        <div class="chart-wrap" id="punch"><div class="spin">…</div></div>
      </div>`;
    const upd = () => go("activity", { ref: S.ref === "--all" ? "" : S.ref, year: $("#heatYear").value === "last" ? "" : $("#heatYear").value, who: $("#heatWho").value }, true);
    $("#heatYear").onchange = () => { upd(); drawHeat(st, $("#heatYear").value, $("#heatWho").value); };
    $("#heatWho").onchange = () => { upd(); drawHeat(st, $("#heatYear").value, $("#heatWho").value); };
    drawHeat(st, year, who);
    drawStack(st);
    drawPunch();
  }

  function dayStr(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }

  function drawHeat(st, year, who) {
    const data = who ? (st.authorDaily[who] || {}) : st.daily;
    let start, end;
    if (year === "last") { end = new Date(); start = new Date(); start.setFullYear(end.getFullYear() - 1); start.setDate(start.getDate() + 1); }
    else { start = new Date(+year, 0, 1); end = new Date(+year, 11, 31); }
    const s0 = new Date(start); s0.setDate(s0.getDate() - s0.getDay()); // back to Sunday
    const cell = 12, gap = 3, top = 18, left = 28;
    const cells = [];
    let total = 0, activeDays = 0, maxV = 0, best = null;
    for (let d = new Date(s0); d <= end; d.setDate(d.getDate() + 1)) {
      if (d < start) continue;
      const k = dayStr(d);
      const v = data[k] || 0;
      total += v; if (v) activeDays++;
      if (v > maxV) { maxV = v; best = k; }
      const week = Math.floor((d - s0) / (7 * 864e5) + 0.01);
      cells.push({ k, v, x: left + week * (cell + gap), y: top + d.getDay() * (cell + gap), d: new Date(d) });
    }
    const weeks = Math.ceil(((end - s0) / 864e5 + 1) / 7);
    const W = left + weeks * (cell + gap), H = top + 7 * (cell + gap);
    // quantize on non-zero values so a single huge day doesn't wash out everything
    const nz = cells.map((c) => c.v).filter(Boolean).sort((a, b) => a - b);
    const q = (p) => nz[Math.min(nz.length - 1, Math.floor(p * nz.length))] || 1;
    const t1 = q(0.25), t2 = q(0.5), t3 = q(0.8);
    const lvl = (v) => (v === 0 ? 0 : maxV <= 4 ? Math.min(4, v + 4 - maxV)
      : v <= t1 ? 1 : v <= t2 ? 2 : v <= t3 ? 3 : 4);
    let monthsTxt = "", lastM = -1;
    cells.forEach((c) => {
      if (c.d.getDate() <= 7 && c.d.getDay() === 0 && c.d.getMonth() !== lastM) {
        lastM = c.d.getMonth();
        monthsTxt += `<text x="${c.x}" y="11">${c.d.toLocaleString(undefined, { month: "short" })}</text>`;
      }
    });
    const dayLbl = ["", "Mon", "", "Wed", "", "Fri", ""].map((t, i) => t ? `<text x="0" y="${top + i * (cell + gap) + 10}">${t}</text>` : "").join("");
    $("#heat").innerHTML = `<svg width="${W}" height="${H}">${monthsTxt}${dayLbl}${cells.map((c) =>
      `<rect x="${c.x}" y="${c.y}" width="${cell}" height="${cell}" rx="2" fill="var(--q${lvl(c.v)})" data-k="${c.k}" data-v="${c.v}" style="cursor:${c.v ? "pointer" : "default"}"/>`).join("")}</svg>`;
    const name = who ? (st.authors.find((a) => a.key === who) || {}).name : "";
    $("#heatSub").textContent = `${fmtNum(total)} commits on ${activeDays} days${name ? " by " + name : ""}${best ? ` · busiest: ${best} (${maxV})` : ""}`;
    const svg = $("#heat svg");
    svg.onmousemove = (ev) => {
      const r = ev.target.closest("rect");
      if (!r) return tip.hide();
      const d = new Date(r.dataset.k + "T12:00:00");
      tip.show(`<div class="t">${d.toLocaleDateString(undefined, { weekday: "short", year: "numeric", month: "short", day: "numeric" })}</div>${r.dataset.v} commit${r.dataset.v === "1" ? "" : "s"}`, ev);
    };
    svg.onmouseleave = () => tip.hide();
    svg.onclick = (ev) => {
      const r = ev.target.closest("rect");
      if (!r || r.dataset.v === "0") return;
      go("history", { ref: S.ref === "--all" ? "" : S.ref, since: r.dataset.k, until: r.dataset.k, author: name ? "^" + reEscape(name) + "$" : "" });
    };
  }

  function drawStack(st) {
    const top = st.authors.slice(0, 8);
    const first = Math.min(...st.authors.map((a) => a.first)), last = Math.max(...st.authors.map((a) => a.last));
    const months = monthRange(first, last);
    const series = top.map((a, i) => ({ name: a.name, key: a.key, color: `var(--s${i + 1})`, vals: months.map((m) => a.months[m] || 0) }));
    const other = months.map((m) => st.authors.slice(8).reduce((s, a) => s + (a.months[m] || 0), 0));
    if (other.some(Boolean)) series.push({ name: "Other", key: "", color: "var(--other)", vals: other });
    const totals = months.map((_, i) => series.reduce((s, x) => s + x.vals[i], 0));
    const maxT = Math.max(1, ...totals);
    const wrap = $("#stack");
    const W = Math.max(wrap.clientWidth - 4, months.length * 4 + 50), H = 220, padL = 36, padB = 22, padT = 6;
    const plotW = W - padL - 4, plotH = H - padB - padT;
    const bw = plotW / months.length;
    const gap = bw > 6 ? 2 : bw > 3 ? 1 : 0;
    const y = (v) => padT + plotH - (v / maxT) * plotH;
    // nice ticks
    const step = niceStep(maxT / 4);
    let grid = "";
    for (let v = 0; v <= maxT; v += step) grid += `<line x1="${padL}" x2="${W - 4}" y1="${y(v)}" y2="${y(v)}" stroke="var(--border)" stroke-dasharray="${v ? "2 3" : ""}"/><text x="${padL - 6}" y="${y(v) + 3}" text-anchor="end">${v}</text>`;
    let bars = "";
    months.forEach((m, i) => {
      let acc = 0;
      const x = padL + i * bw + gap / 2, w = Math.max(0.8, bw - gap);
      series.forEach((s) => {
        const v = s.vals[i];
        if (!v) return;
        const y0 = y(acc), y1 = y(acc + v);
        bars += `<rect x="${x.toFixed(2)}" y="${y1.toFixed(2)}" width="${w.toFixed(2)}" height="${Math.max(0.5, y0 - y1 - (bw > 6 ? 1 : 0)).toFixed(2)}" fill="${s.color}"/>`;
        acc += v;
      });
      bars += `<rect x="${(padL + i * bw).toFixed(2)}" y="${padT}" width="${bw.toFixed(2)}" height="${plotH}" fill="transparent" data-i="${i}" style="cursor:pointer"/>`;
    });
    // year labels on x axis
    let xl = "";
    const everyYear = months.length > 30;
    months.forEach((m, i) => {
      if (everyYear ? m.endsWith("-01") || i === 0 : (i % Math.ceil(months.length / 12) === 0))
        xl += `<text x="${padL + i * bw + 1}" y="${H - 6}">${everyYear ? m.slice(0, 4) : m}</text>`;
    });
    wrap.innerHTML = `<svg width="${W}" height="${H}">${grid}${bars}${xl}</svg>`;
    $("#stackLegend").innerHTML = series.map((s) => `<span><i style="background:${s.color}"></i>${esc(s.name)}</span>`).join("");
    const svg = $("svg", wrap);
    svg.onmousemove = (ev) => {
      const r = ev.target.closest("[data-i]");
      if (!r) return tip.hide();
      const i = +r.dataset.i;
      const rows = series.filter((s) => s.vals[i]).sort((a, b) => b.vals[i] - a.vals[i])
        .map((s) => `<div class="r"><i style="background:${s.color}"></i>${esc(s.name)}<span class="v">${s.vals[i]}</span></div>`).join("");
      tip.show(`<div class="t">${months[i]} · ${totals[i]} commits</div>${rows || '<span class="faint">No commits</span>'}`, ev);
    };
    svg.onmouseleave = () => tip.hide();
    svg.onclick = (ev) => {
      const r = ev.target.closest("[data-i]");
      if (!r) return;
      const m = months[+r.dataset.i];
      const [yy, mm] = m.split("-").map(Number);
      const lastDay = new Date(yy, mm, 0).getDate();
      go("history", { ref: S.ref === "--all" ? "" : S.ref, since: m + "-01", until: `${m}-${pad(lastDay)}` });
    };
  }
  function niceStep(x) {
    const p = Math.pow(10, Math.floor(Math.log10(Math.max(1, x))));
    const n = x / p;
    return Math.max(1, (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p);
  }

  async function drawPunch() {
    // derived from the log so it reflects local hours; reuse a capped log fetch
    const el = $("#punch");
    try {
      const counts = Array.from({ length: 7 }, () => Array(24).fill(0));
      let skip = 0, more = true, n = 0;
      while (more && n < 20000) {
        const r = await api("log", { repo: S.repoId, ref: S.ref, skip, limit: 2000 });
        r.commits.forEach((c) => { const d = new Date(c.time * 1000); counts[d.getDay()][d.getHours()]++; });
        skip += r.commits.length; n += r.commits.length; more = r.more;
        if (!$("#punch")) return;
      }
      const max = Math.max(1, ...counts.flat());
      const cw = 26, ch = 24, left = 40, top = 8;
      const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
      let s = "";
      counts.forEach((row, di) => {
        s += `<text x="0" y="${top + di * ch + ch / 2 + 3}">${days[di]}</text>`;
        row.forEach((v, h) => {
          if (!v) return;
          const r = Math.max(2, Math.sqrt(v / max) * (ch / 2 - 2));
          s += `<circle cx="${left + h * cw + cw / 2}" cy="${top + di * ch + ch / 2}" r="${r.toFixed(2)}" fill="var(--s1)" data-d="${di}" data-h="${h}" data-v="${v}"/>`;
        });
      });
      for (let h = 0; h < 24; h += 3) s += `<text x="${left + h * cw + cw / 2}" y="${top + 7 * ch + 12}" text-anchor="middle">${h}:00</text>`;
      el.innerHTML = `<svg width="${left + 24 * cw}" height="${top + 7 * ch + 18}">${s}</svg>${n >= 20000 ? '<div class="faint">Based on the most recent 20,000 commits.</div>' : ""}`;
      const svg = $("svg", el);
      svg.onmousemove = (ev) => {
        const c = ev.target.closest("circle");
        if (!c) return tip.hide();
        tip.show(`<div class="t">${days[c.dataset.d]} ${c.dataset.h}:00–${c.dataset.h}:59</div>${c.dataset.v} commits`, ev);
      };
      svg.onmouseleave = () => tip.hide();
    } catch (e) { el.innerHTML = `<div class="err">${esc(e.message)}</div>`; }
  }

  route();
})();
