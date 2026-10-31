# @kitkatvn/nghixahoi

Local break companion for coding campaigns. This package is the **source of truth** for tracking, the milestones reached, hooks, and the local Mini companion.

Published package: `@kitkatvn/nghixahoi`, which installs the `nghixahoi` command. Its releases are under npm's `latest`, and it holds them alone. Kit=Code's tester builds, for the invited testers of its staging round, are a package of their own, under `staging`, which the staging site's setup prompt installs (see Releases, below).

---

## For people

### Before you set up

Setup only works when an assistant can run commands on your machine.

| Tool | What works | What does not work |
| --- | --- | --- |
| **Codex** | **Codex Task** or **project chat** (Desktop, Go+) | Regular chat |
| **Claude** | **Claude Code** on Claude Desktop (Pro+) | Cloud-only browser chat |

**Minimum requirements:**

| | **Codex** | **Claude Code** |
| --- | --- | --- |
| App | ChatGPT desktop app | Claude Desktop (Code tab) |
| Permission control | Approve for me or Full access | Auto or Bypass permissions |
| Account plan | Go (or higher) | Pro (or higher) |

Use the permission setting that lets setup commands run without stopping between steps.

### Quick Start

Install Kit=Code first: `npm install -g @kitkatvn/nghixahoi@latest`. The setup prompt on Kit=Code's dashboard does it for you, and checks that `nghixahoi --version` prints what `npm view @kitkatvn/nghixahoi version` does.

Kit=Code does not update itself. When a newer version is out, Kit=Code says so: on its dashboard, in the Mini's title bar, and in the Kit=Code context of your prompts. To update, paste the setup prompt from Kit=Code's dashboard, the one `nghixahoi dashboard` opens, into your assistant again: it installs the newest release from npm's `latest`, and your progress stays in `~/.nghixahoi`.

<table>
  <tr>
    <th>Command</th>
    <th>What it opens or enables</th>
  </tr>
  <tr>
    <td>
      <pre><code>nghixahoi codex on
nghixahoi claude on</code></pre>
    </td>
    <td>
      Codex / Claude integration plus Welcome when onboarding is incomplete.
    </td>
  </tr>
  <tr>
    <td>
      <pre><code>Save Welcome with at least one project</code></pre>
    </td>
    <td>
      Opens the Mini companion and can start background tracking when you chose YES in Welcome.
    </td>
  </tr>
  <tr>
    <td>
      <pre><code>nghixahoi track
nghixahoi dashboard</code></pre>
    </td>
    <td>
      Starts tracking or opens the hosted dashboard.
    </td>
  </tr>
</table>

Local API: `http://127.0.0.1:4747`

Finish **Welcome** with at least one project folder before expecting tracking to work.

---

## For agents / developers

### Hard rules

1. Use Codex Task or a project chat (Desktop, Go+), or Claude Code on Claude Desktop (Pro+).
2. Set permission control before setup: Codex **Approve for me** or **Full access**; Claude Code **Auto** or **Bypass permissions**.
3. Execute commands yourself. Do not stop after printing shell instructions.
4. Never calculate or mutate rewards. Use `nghixahoi status`, `nghixahoi summary`, and `nghixahoi awards`.

### Daily commands

| Command | What it does |
| --- | --- |
| `nghixahoi add [path]` | Add a project. Defaults to current folder. Existing code becomes baseline. |
| `nghixahoi remove [path]` | Remove a project, its snapshot and its counted `=`. Focus time already earned stays. |
| `nghixahoi track` | Start the background tracker. Can run before projects are added. |
| `nghixahoi untrack` | Stop the tracker. Added projects remain registered. |
| `nghixahoi list` | Show how many projects are added. |
| `nghixahoi status` | Tracker state, project count, compact reward progress. |
| `nghixahoi summary` | Total counted `=`, active time, next milestone progress. |
| `nghixahoi awards` | Reward and milestone readiness. Aliases: `award`, `rewards`. |
| `nghixahoi setup` | Welcome: projects and auto-track preference. |
| `nghixahoi uninstall` | Remove hooks, skills, tracker, and all `~/.nghixahoi` data. |
| `nghixahoi dashboard` | Open the hosted dashboard for the running tracker. |
| `nghixahoi codex on/off/status` | Install, remove, or inspect the Codex hook and skill. |
| `nghixahoi claude on/off/status` | Install, remove, or inspect the Claude hook and skill. |

Simplest flow:

```bash
nghixahoi track
cd your-project
nghixahoi add .
nghixahoi dashboard
```

Or add first, track later:

```bash
cd your-project
nghixahoi add .
nghixahoi track
```

`dashboard` and the Mini companion require a running tracker.

During first-time `codex on` / `claude on`, do **not** run `add` or `track` for the user. Welcome owns first project selection.

## Surfaces

### Mini companion

A successful Welcome save opens the Mini companion, which shows the page the tracker serves at `/companion`, or a copy of that page when no tracker answers as it opens. `nghixahoi setup` opens Welcome.

The Mini is a compact metrics bar beside your work. There is **no** standalone `nghixahoi mini` command. While a newer Kit=Code is out, its title bar says so in one line, which opens the dashboard.

### Setup / Welcome

`nghixahoi setup` and first-time `codex on` / `claude on` can open Welcome so the user can:

- pick one or more project folders
- choose whether background tracking should start after save

Welcome no longer asks for a companion preference. Saving Welcome opens the Mini companion.

Setup needs the optional Electron dependency.

### Dashboard

`nghixahoi dashboard` opens the hosted dashboard, which reads the local tracker API.

Use `--no-open` or `NGHIXAHOI_NO_OPEN=1` to skip auto-opening the browser.

## What Kit=Code counts

### Focus time

Focus time is one clock for all your projects: a second is active when any added project had real activity in the 5 minutes before it, and it counts once, however many projects were active. Real activity is a change to the lines Kit=Code counts in a file it reads (below). Touching a file, a save that changes no line, re-indenting, and a git operation on its own (a pull, a merge, a checkout of another branch, a stash) are not. After **5 quiet minutes**, new time is recorded as idle. No time is earned while the tracker is stopped.

### Equal count

Kit=Code scans local source snapshots and counts `=` on **real code lines** added after the project baseline.

Rules:

- `nghixahoi add` creates the baseline.
- Existing lines at add time do not earn reward by themselves.
- Only lines with enough alphanumeric content count as real code lines.
- A line is compared without its whitespace, with `"` and `` ` `` read as `'`, and without one trailing `;` or `,`: re-indenting, re-spacing or re-quoting a line does not make it new.
- A line earns at most 3 `=`, and once per user, ever: a line Kit=Code has seen before, in any file of any of your projects, earns nothing, whether it was moved, copied, pasted, or deleted and added back.
- Ignored paths include `.git`, `node_modules`, `dist`, `build`, `.next`, `out`, and `coverage`.
- Lockfiles, minified files (`*.min.js`, `*.min.css`) and source maps (`*.map`) are not counted. Secret files (a name that starts with `.env`, ends in `.pem` or `.key`, or is an SSH key's) are never read.
- Files larger than 1 MiB and binary files are skipped.
- In both modes, the `=` a scan adds are recorded as one source-change batch.

Example:

```js
const total = price + tax
```

If that line is new after `nghixahoi add .`, Kit=Code has not seen it before, and it passes the real-code-line check, its `=` counts toward the ledger.

## Git Mode and Vibe Mode

| Mode | When | What Kit=Code tracks |
| --- | --- | --- |
| Git Mode | Folder is inside a Git repository | Commit count, focus time, source-change batches |
| Vibe Mode | Folder is not inside a Git repository | Focus time and source-change batches |

Both modes count `=` by the same line rules. In Git Mode, Kit=Code reads only the files git lists (tracked, or untracked and not ignored), and code that arrives through git as it moves HEAD earns nothing and is not activity: a pull, a merge, a checkout of another branch, a rebase, a cherry-pick. Code git writes without moving HEAD, such as `git stash pop` or `git restore`, counts as yours. Your own new lines earn whether you commit them or not. The commit count is only reported: no reward depends on it.

## Reward model

The time targets are fixed, each milestone's own (below): no flag or variable changes them.

Each milestone needs both enough active time and enough counted `=`, both added up since install: every milestone is a
threshold on the same two totals, and a milestone is reached once both totals reach its numbers. Nothing is counted from the
milestone before, and nothing is lost: time or `=` past what `30%` needed count toward `50%` and `100%`. So `100%` takes
5 hours and 600 `=` in all in a release, never more. What was reached stays reached.

### Milestones

A release, `@kitkatvn/nghixahoi` under `latest`, counts by the production table:

| Milestone | Active time, in all | Counted `=`, in all |
| ---: | ---: | ---: |
| `30%` | 2 hours (7200 s) | 200 |
| `50%` | 3 hours (10800 s) | 400 |
| `100%` | 5 hours (18000 s) | 600 |

A tester build, the staging package under `staging`, counts by the tester table, the short one, so that testers reach each
milestone quickly; `100%` takes 60 minutes and 15 `=` in all:

| Milestone | Active time, in all | Counted `=`, in all |
| ---: | ---: | ---: |
| `30%` | 18 minutes (1080 s) | 9 |
| `50%` | 30 minutes (1800 s) | 12 |
| `100%` | 60 minutes (3600 s) | 15 |

`MILESTONE_TABLE` in `src/integration-spec.mjs` says which this package counts by, and `nghixahoi summary` names what the next
milestone still needs.
Until 2026-10-08 there were 10% and 20% milestones too, and until 2026-10-20 every milestone counted from install, as it does
again since 2026-10-29. From 2026-10-20 to 2026-10-29 each counted fresh from the moment the milestone before it was reached,
so `100%` took the three targets added up, 10 hours and 1,200 `=` in a release. From 2026-10-21 to 2026-10-22 the tester table
held the production table's numbers; since 2026-10-22 it is the short one again.

Once a milestone is reached, the dashboard shows its message: the campaign's own words, which the campaign's server gives each milestone. The prompt hook and the desktop notification say only that a milestone was reached. `summary` and `awards` show which are ready.

Since 2026-10-22 the milestones count in cycles. Once the campaign's server issues a voucher for a claim, its page links back to the dashboard with a receipt the server signed, and the dashboard hands it to the tracker, which begins the next cycle: `30%`, `50%` and `100%` count again from that moment, both totals of the cycle starting from 0, and the active time and the counted `=` since install keep counting. Nothing else begins one, and a claim that fails or is abandoned changes nothing. A build takes a receipt only if it carries its server's public key: a release under `latest` carries the campaign server's, and a tester build the staging server's. From cycle 2 on, `summary`, the prompt hook and the Mini name the cycle.

Until 2026-10-01 each milestone had a break code, a line of code shown in the dashboard, which recorded it as shown on this machine. The codes are gone, and nothing records one as shown; a code an earlier version recorded as shown stays in `~/.nghixahoi/state.json`, and its milestone reads as ready.

## Codex and Claude integrations

The hosted gateway copies **agent-specific** setup prompts: Codex prompts mention only Codex; Claude prompts mention only Claude Code.

`nghixahoi codex on` and `nghixahoi claude on` install:

- a Kit=Code skill file
- a `UserPromptSubmit` hook whose command runs the runner below: `~/.nghixahoi/bin/nghixahoi hook prompt --source <agent>` (on Windows, `node` with the runner's `nghixahoi.mjs`)
- a durable local runner at `~/.nghixahoi/bin/nghixahoi`

The hook:

- runs after each submitted prompt
- fails open and never blocks prompts
- can add compact context: counted `=`, active time, next milestone progress, reward readiness, and that a newer Kit=Code is available, from what the tracker last saved, with no network
- can announce newly ready tiers once per agent source

Disable hooks with:

```bash
NGHIXAHOI_HOOKS_OFF=1
```

## Local state

```txt
~/.nghixahoi/state.json     Projects and their snapshots, onboarding prefs, focus time, equals ledger
~/.nghixahoi/seen-lines     Every line Kit=Code has seen, as hashes: a line earns once
~/.nghixahoi/install-id     A random id the claim bundle carries, made by the tracker
~/.nghixahoi/tracking-config.json  The campaign's targets and end, as the tracker last took them from the server
~/.nghixahoi/newest-version.json   The newest Kit=Code's version, as the tracker last took it from the server
~/.nghixahoi/tracker.json   Background tracker PID/host/port metadata
~/.nghixahoi/tracker.log    The background tracker's log
~/.nghixahoi/hook.log       Hook errors, when logging succeeds
~/.nghixahoi/bin/nghixahoi  Durable runner used by agent hooks
```

## Privacy

By default Kit=Code does not send:

- source code
- raw diffs
- arbitrary file contents
- full local paths
- project names
- commit metadata

The local API returns totals only: active/idle time, project count, commit count, change batches, counted `=`, and reward progress, with the tracker's health. The claim bundle, which it gives an allowed origin alone, adds when each milestone was reached, the CLI's and the counting rules' versions, and the install id, which names no person, machine or project.

Kit=Code connects to its dashboard's site, the one `nghixahoi dashboard` opens, about once an hour to download the campaign's current targets and end date. It sends nothing about you, your computer or your code, and the server does not record the address of this request.

With them it downloads the number of the newest Kit=Code version, so that it can tell you when an update is out; it never downloads or installs the update itself.

Only the background tracker connects, about an hour apart and once when your computer wakes: two requests, to the dashboard's address plus `/v1/tracking-config` and then `/v1/newest-version`, with no cookie, install id or version. It takes each answer only if Kit=Code's claim server signed it, and otherwise keeps what it had; the hook and the commands never connect. The staging package connects to its staging site instead, and a copy of Kit=Code run from its repository connects to nothing. If the campaign has ended, by your computer's clock, the hook adds nothing to your prompts and `nghixahoi summary` says so; your totals are kept.

## API

```txt
GET  /api/health
GET  /api/summary
GET  /api/projects
GET  /api/events
GET  /api/claim/bundle
POST /api/claim/receipt
GET  /companion
```

The API answers only requests addressed to `127.0.0.1` or `localhost` on its port, and web pages only from an allowed origin (below) or its own. `GET /api/claim/bundle` needs an allowed origin; every `POST` needs an allowed origin and a JSON body. Since 2026-10-22 one changes something, `POST /api/claim/receipt`: it begins the next cycle on a receipt signed with the key the build carries, for this install, of the cycle it is in or a later one, once, and refuses anything else, changing nothing. A receipt of a later cycle, as after Kit=Code is installed afresh, begins the cycle after it, numbered as the server counts (since 2026-10-22's phase 3).

`/api/events` is SSE and emits `summary` every second. Since 0.2.11 a summary's `update` is `{version}`, the newest Kit=Code while it is newer than this one, by the claim server's signed newest version, or `null`.

Legacy endpoints return `410 Gone`:

```txt
POST /api/reward/redeem
GET  /api/projects/:id/commits
POST /api/projects/:id/start
POST /api/projects/:id/stop
POST /api/projects/selection
```

## Options and environment

```bash
nghixahoi track --host 127.0.0.1
nghixahoi track --port 4757
nghixahoi dashboard --no-open
```

| Variable | Effect |
| --- | --- |
| `NGHIXAHOI_ALLOWED_ORIGINS` | Extra CORS origins for the local API |
| `NGHIXAHOI_NO_OPEN` | Skip auto-opening the hosted dashboard |
| `NGHIXAHOI_HOOKS_OFF` | Disable prompt hook side effects |
| `NGHIXAHOI_DAEMON` | Internal flag used by the background tracker |

With nothing configured, the local API allows the origin of the dashboard `nghixahoi dashboard` opens, and local development servers on ports `3000`, `5173`, and `8686`, on `localhost` and `127.0.0.1`.

## Requirements

- Node.js 22.12 or later
- Git optional (enables Git Mode)
- Electron optional (required for native Mini and Welcome)

## Releases

Nobody runs `npm publish` for these packages. A release comes from a pushed tag, `cli-v<version>`: the project's CI runs
its checks on the tagged commit, packs the tarball from that commit, and stages it on npm with `npm stage publish`. A
staged version becomes public only when a maintainer approves it with two-factor authentication. Each package's first
version is the one exception to CI's staging: a maintainer publishes CI's tarball by hand, once, with two-factor
authentication, since npm lets CI stage only for a package that exists.

Two packages, each with its own dist-tag:

| Package | Dist-tag | Versions | Install |
| --- | --- | --- | --- |
| `@kitkatvn/nghixahoi` | `latest` | `<x>.<y>.<z>`, the version in `package.json`, from 0.2.10. Its dashboard is Kit=Code's public site, the one `nghixahoi dashboard` opens | `npm install -g @kitkatvn/nghixahoi@latest` |
| The staging package, which the staging site's setup prompt names | `staging` | `<x>.<y+1>.0-staging.<N>`, the tester build of a tagged commit, for the invited testers of the staging round. Its dashboard is Kit=Code's protected staging site, which only they can open, and it sends Kit=Code's own diagnostics there | The staging site's setup prompt, which first removes `@kitkatvn/nghixahoi`: both install the `nghixahoi` command |

What production's dist-tag points at now: `npm view @kitkatvn/nghixahoi dist-tags`.
