# GitScope

A local, offline web app for tracing git history: the commit graph, who changed what and when, and every diff, in your browser instead of an IDE.

- **No dependencies.** Python 3.8+ standard library and your local `git`. Nothing to `pip install`.
- **Entirely local.** It only opens repositories that are already on your disk. It never clones, fetches, or calls GitHub or any other API. Every git command runs with all network transports disabled (`protocol.allow=never`) and lazy fetching off. The UI loads no CDNs, fonts, analytics, or avatars, and its Content-Security-Policy only allows requests back to the local server.
- **Private to your machine.** The server binds to `127.0.0.1` and rejects requests with a foreign `Host` header (DNS-rebinding protection). State-changing POSTs require a JSON body, so other websites can't trigger them.

## Run it

```sh
./gitscope.sh                      # opens http://127.0.0.1:7777 in your browser
./gitscope.sh ~/code/my-project    # open straight into a repo
./gitscope.sh --port 9000 --no-browser
```

Or run `python3 -m gitscope …` from the repo root.

From the home screen, type a path (press **Tab** to autocomplete folders). Recently opened repos are listed there. To look at a GitHub repo, `git clone` it yourself first, then open the folder.

## What you get

| View | What it shows |
|---|---|
| **History** | `git log --graph`-style commit graph across all branches (or one branch or tag), with branch and tag badges and a colored avatar per author. Filter by message regex or SHA, author, path (file or folder), **code added/removed** (`git log -S`), date range, and no-merges. Infinite scroll. `j`/`k` or the arrow keys move between commits. |
| **Commit detail** | A compact header (subject, author, date, SHA; **Details** expands the full message, committer, parents, branches, and first release). Below it, the changed files are listed on the left and **one file's diff** shows on the right. Each side scrolls on its own, so you never scroll past other files' diffs. Click a file, use ‹ › or press `[` / `]` to step through files, or filter the list. Diffs show **unified or split**, with intra-line highlighting, ignore-whitespace, and a parent picker for merges. **Full view ⤢** (or `f`) hides the commit list right in the same page so the diff gets the whole window. `j`/`k` still step through commits, and `Esc` or **Exit full view** brings the list back. |
| **Files** | Browse the tree at any branch, tag, or commit. Each entry shows the last commit that touched it, GitHub-style. Folders show their README. Images render. Press `t` to fuzzy-find a file. |
| **Blame** | Line-by-line authorship. An age bar shades older lines lighter and newer lines darker, and a breakdown shows who wrote what share of the current file. |
| **File history** | Every commit that touched a file, following renames, with per-commit +/- counts and inline diffs. Also shows which authors changed the file most. |
| **Authors** | Sortable table of commits, share, lines added and removed, files touched, first and last commit, a monthly activity sparkline, and the folders each person mostly works in. Click an author to filter History to them, or click one of their folders to see their commits there. |
| **Activity** | Commit calendar heatmap, filterable by author and year. Commits per month stacked by author. A day-of-week × hour punch card. Click a day or a month to jump to those commits. |

Every view has its own URL (`#/r/<id>/history?sha=…&author=…`), so you can bookmark any view, including its filters.

## Notes

- Author identity uses `.mailmap` if the repo has one (`%aN`), and authors are grouped by name.
- Author and activity statistics come from one `git log --numstat` pass. The result is cached until a ref moves. On very large repos (100k+ commits) the first load can take a while.
- **Auto-refresh.** While a tab is open, GitScope checks the repo on disk every 3 seconds. When you `git pull`, `git fetch`, commit, check out, or delete a branch in your terminal, the current view reloads on its own and keeps your selected commit and scroll position. It waits if you're typing in a filter box or selecting text, and pauses while the tab is in the background. This only re-reads files on disk, so your git credentials stay with your own git.
- The ⟳ button forces the same reload immediately. It never fetches.
- In partial clones (`--filter=blob:none`), content that hasn't been downloaded yet shows an error instead of being fetched.
- The recent-repos list is saved in `~/.gitscope/recent.json`. Set `GITSCOPE_HOME` to move it.

## Layout

```
gitscope/
  server.py        # stdlib HTTP server + JSON API over the git CLI
  __main__.py      # CLI entry point
  static/          # index.html, app.js, style.css (vanilla JS, no build step)
gitscope.sh        # launcher
```
