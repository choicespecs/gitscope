# GitScope

A local, offline web app for tracing git history: the commit graph, who changed what and when, and every diff, in your browser instead of an IDE.

- **No dependencies.** Python 3.8+ standard library and your local `git`. Nothing to `pip install`.
- **No external API calls.** The UI loads no CDNs, fonts, analytics, or avatars, and its Content-Security-Policy only allows requests back to the local server. The only network traffic possible is an explicit `git clone`/`git fetch` when *you* open a remote URL, and `--offline` turns that off too.
- **Local only.** The server binds to `127.0.0.1` and rejects requests with a foreign `Host` header (DNS-rebinding protection). State-changing POSTs require a JSON body, so other websites can't trigger them.

## Run it

```sh
./gitscope.sh                      # opens http://127.0.0.1:7777 in your browser
./gitscope.sh ~/code/my-project    # open straight into a repo
./gitscope.sh https://github.com/user/repo.git   # clones once (bare) into ~/.gitscope/clones
./gitscope.sh --offline            # forbid remote URLs entirely
./gitscope.sh --port 9000 --no-browser
```

Or run `python3 -m gitscope …` from the repo root.

From the home screen you can type a path (press **Tab** to autocomplete folders) or paste a git URL. Recently opened repos are listed there.

## What you get

| View | What it shows |
|---|---|
| **History** | `git log --graph`-style commit graph across all branches (or one branch or tag), with branch and tag badges and a colored avatar per author. Filter by message regex or SHA, author, path (file or folder), **code added/removed** (`git log -S`), date range, and no-merges. Infinite scroll. `j`/`k` or the arrow keys move between commits. |
| **Commit detail** | Full message, author and committer, parents (choose which parent to diff a merge against), the branches that contain the commit, and the first tag that shipped it. Lists changed files with +/- stats. Diffs show in **unified or split** view, with intra-line change highlighting and an ignore-whitespace option. |
| **Files** | Browse the tree at any branch, tag, or commit. Each entry shows the last commit that touched it, GitHub-style. Folders show their README. Images render. Press `t` to fuzzy-find a file. |
| **Blame** | Line-by-line authorship. An age bar shades older lines lighter and newer lines darker, and a breakdown shows who wrote what share of the current file. |
| **File history** | Every commit that touched a file, following renames, with per-commit +/- counts and inline diffs. Also shows which authors changed the file most. |
| **Authors** | Sortable table of commits, share, lines added and removed, files touched, first and last commit, a monthly activity sparkline, and the folders each person mostly works in. Click an author to filter History to them, or click one of their folders to see their commits there. |
| **Activity** | Commit calendar heatmap, filterable by author and year. Commits per month stacked by author. A day-of-week × hour punch card. Click a day or a month to jump to those commits. |

Every view has its own URL (`#/r/<id>/history?sha=…&author=…`), so you can bookmark any view, including its filters.

## Notes

- Author identity uses `.mailmap` if the repo has one (`%aN`), and authors are grouped by name.
- Author and activity statistics come from one `git log --numstat` pass. The result is cached until a ref moves. On very large repos (100k+ commits) the first load can take a while.
- Cloned repos are stored bare in `~/.gitscope/clones`. The ⟳ button runs `git fetch` for them. For local repos it just reloads. Set `GITSCOPE_HOME` to move this data.
- Private remotes use your existing git credentials (SSH keys or a credential helper). GitScope never prompts for or stores credentials.

## Layout

```
gitscope/
  server.py        # stdlib HTTP server + JSON API over the git CLI
  __main__.py      # CLI entry point
  static/          # index.html, app.js, style.css (vanilla JS, no build step)
gitscope.sh        # launcher
```
