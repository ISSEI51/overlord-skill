# Overlord

[日本語](README.md) | [English](README.en.md) · [MIT License](LICENSE)

## You are the Overlord. You make the decisions that matter.

Let AI agents investigate, plan, implement, review, and track the work — while you focus on priorities, direction, and final decisions.

Overlord is a control layer that runs your Claude Code and Codex agents as a development team instead of as a single coder. Every change is one worktree, one branch, one pull request, one agent run, so several pieces of work can move in parallel while the only thing left in your hands is deciding.

![Overlord Console](docs/images/console-board.jpg)

## Highlights

- **Only decisions reach you** — the "decisions today" bar holds at most three items. A cyan border means a card is waiting on you; a yellow border means an AI is working on it. Those two signals are the whole dashboard
- **Agents work as a team** — you talk to exactly one session, the commander. It dispatches each card's discovery, brief, implementation, and review to subagents
- **Parallel work, one pull request per change** — 1 change = 1 worktree = 1 branch = 1 pull request = 1 agent run. Large work is split into changes, not into more cards
- **No AI signs off on its own change** — the independent review runs in a different subagent. When a change's reviewed commit is not the pull request head, `sync` prints a warning, and the skills require that such a change is re-reviewed before it moves to acceptance
- **One file holds the state** — the board file is the only state agents read and write; you see `docs/product-ops/board.yaml` as a kanban in the browser. Writes are guarded by optimistic locking
- **Local only** — the console listens on `127.0.0.1` and rejects any request whose `Host` or `Origin` is not loopback

## Quick start

The console interface is in Japanese. The steps below quote the on-screen labels and give their meaning in English.

You need:

- [Claude Code](https://claude.com/claude-code) (or Codex)
- [Bun](https://bun.sh) — required to run Overlord Console
- `git` and the [GitHub CLI](https://cli.github.com/) (`gh`) — `scripts/change.sh` invokes `git` and `gh` directly, in all seven subcommands (`start`, `pr`, `reviewed`, `sync`, `merge`, `deliver`, `identity`): `start` runs `git worktree add` and `git rev-parse`; `pr` runs `git push` plus `gh pr list` / `gh pr create` / `gh pr view`; `reviewed` runs `git worktree list` and `git rev-parse HEAD` inside the worktree, falling back to `gh pr view --json headRefOid` when the worktree is gone; `sync` runs `gh pr view`; `merge` runs `git rev-parse` / `git symbolic-ref` plus `gh pr view` / `gh repo view` / `gh pr merge`; `deliver` runs `git fetch` / `git diff` plus `gh repo view` / `gh pr view` / `gh pr create` / `gh pr edit`; `identity` runs `git rev-parse` / `git remote get-url` plus `gh api user` / `gh repo view`. So `gh` has to be authenticated with `gh auth login`. The commander runs `change.sh` for you — there is no point where you type it yourself
- [cmux](https://cmux.com/) — a macOS terminal that holds several AI sessions as workspaces on one screen. Overlord reads the commander session's screen and sends its input through cmux, which is why it is required for the commander sidebar and the card instruction buttons

Platform: the console and the skills contain no macOS-specific code, so they run anywhere Bun runs (macOS and Linux). cmux is a macOS app; when `cmux` is not on `PATH` the console falls back to `/Applications/cmux.app/Contents/Resources/bin/cmux`. Without cmux you can still browse and edit the kanban, add observations, and run every `scripts/change.sh` command. What you lose is the commander sidebar, the card instruction buttons, `console.sh --open`, and the automatic commander registration `console.sh ensure` performs (everything else `ensure` does works without cmux: the server is started as a detached process with its output in `<project>/.overlord/console.log`).

Overlord is two things: **five skills** the AI reads, and the **console** you look at (the screenshot above). Step 1 installs the skills, step 2 starts the console.

1. **Install the skills**

   ```bash
   git clone https://github.com/ISSEI51/overlord-skill.git
   cd overlord-skill
   ./scripts/install.sh claude          # for Codex: ./scripts/install.sh codex
   ```

2. **Start the console against the project you want to manage**

   ```bash
   ./scripts/console.sh ensure ~/dev/your-project
   ```

   One command does the whole setup: it creates `docs/product-ops/board.yaml` when there is none, starts the server unless a console is already serving that board, and — when you run it from a cmux session — registers that session as the commander. It prints lines like these:

   ```text
   board:            /Users/example/dev/your-project/docs/product-ops/board.yaml
   console:          http://127.0.0.1:7377
   board file:       created
   server:           started, cmux workspace workspace:48
   stop:             close the cmux workspace workspace:48, or: kill $(lsof -ti tcp:7377 -sTCP:LISTEN)
   commander:        registered, surface 22222222-2222-2222-2222-222222222222
   ```

   **Open the address on the `console:` line in a browser.** `ensure` does not open one for you.

   `ensure` is idempotent: when a console is already serving that board it starts no second server (`server: already running, nothing started`) and just prints the address and how to stop it, so running it again is harmless. It still prints a `commander:` line — `unchanged, …` when you run it from the session that is already the commander, leaving `board.yaml` untouched; run it from a different cmux session and that session takes the commander role over. Use `--port 7400` for a different port. **When the port is already serving another project's board, it exits 1 without touching that console and asks you to pick another port.**

3. **Set up the commander** — if you ran step 2 from a cmux session, the `commander:` line reads `registered, surface …` and that session is already the commander. If it reads `not registered, …` (cmux is not reachable, or the command was not run inside a cmux session), use the right sidebar instead (open on first launch; the top-bar icon or **⌘B**, Ctrl+B on Linux, toggles it): press "司令塔を新しく起動" (start a new commander), enter the project directory, and press start. The console creates a cmux workspace running Claude Code, records it as the commander, and pre-fills the composer with the first instruction. Press send: the commander reads `docs/product-ops/board.yaml` (creating it if it does not exist) and reports today's status.

4. **Try one item** — press "気づきを追加" (add an observation) in the top bar and write one line; a card appears in the inbox. Open the card and press "進める" (advance), and the commander assigns the step that card's state calls for to a subagent.

From then on, you only look at the cyan-bordered cards and the decisions bar, and decide what to approve and accept.

## Architecture

```text
observation -> work card -> prioritize -> implementation brief -> implement -> independent review -> acceptance
                    |                                                              |
                    +----------------- docs/product-ops/board.yaml ---------------+
                                              |
                                              +-> Overlord Console (browser)
                                                          |
                                                          +-> commander (cmux) -> subagents per card
```

| Piece | Role |
| --- | --- |
| Five skills | The AI's operating procedures (below) |
| `docs/product-ops/board.yaml` | The only state agents read and write; the single machine-readable source of truth |
| Overlord Console | A browser dashboard that renders and edits the board file |
| Commander | The one cmux session you talk to; it dispatches each card's work to subagents |

### Cards, changes, and tasks

The board has three levels, and **you only manage the top one**.

| Level | Meaning | Where you see it |
| --- | --- | --- |
| **Card** | One product outcome; the human decision unit | A card on the kanban |
| **Change** | One delivery unit: 1 change = 1 worktree = 1 branch = 1 PR = 1 agent execution unit | Read-only inside the card modal |
| **Task** | A step inside an agent's run | Never shown |

A change is delivered as a single pull request: `start` creates its worktree and branch, `pr` pushes it and opens the pull request, `reviewed` records the commit the independent review read, and `sync` writes the pull request state back after the merge. `scripts/change.sh` runs each step and records it on the board, so nobody edits the board by hand. When a change's reviewed commit is not the pull request head, `sync` prints a warning; keeping that change out of acceptance is a rule the skills enforce, not something the command blocks.

Large work is split into **changes**. Many files, a backend/frontend divide, a migration, a desire for smaller pull requests — all of these become changes, and **the card count stays the same**.

A new card is created only when the piece is a separate product outcome: something you could prioritize, ship, or cancel on its own, with its own acceptance conditions.

## Included skills

| Skill | Purpose |
| --- | --- |
| `overlord-ops` | Prioritize work and keep the AI's status organized |
| `overlord-improvement-card` | Turn rough observations into actionable work cards |
| `overlord-ux-audit` | Walk real user flows and find friction |
| `overlord-implementation-brief` | Scope a change tightly before any code is written |
| `overlord-change-review` | Have a different AI verify the change against its goal |

## Overlord Console

A local dashboard built with React + shadcn/ui. Changes to `board.yaml` appear on screen automatically.

### Board

- An eight-column kanban with drag & drop. The columns are labelled in Japanese; their board keys are the words in parentheses:
  受信箱 (inbox) / 調査中 (discovery) / 実装準備完了 (specified) / 実装中 (implementing) / 確認中 (reviewing) / 完成確認待ち (acceptance) / 完了 (done) / 停止中 (blocked)
- **Yellow border** = a card the AI is actively working on (an unfinished change has a worker session recorded, or `owner` is `claude`)
- **Cyan border** = a card that needs you (awaiting acceptance, owned by you, or listed in today's decisions)
- The border is decided in that order: a card with a worker session recorded takes the yellow border, a card without one that needs you takes the cyan border, and `owner: "claude"` gives the yellow border only to what is left. `owner` alone never cancels the cyan border
- The 進める (advance) button is disabled **on a card with a worker session recorded**, and the modal names the change that session is working. A card that is only `owner: "claude"` keeps the button
- The "decisions today" bar shows at most three things only you can decide
- A completed card carries the number of its delivery pull request (the one targeting `main`) as a tag; the same place reads `配送中` while a delivery is in flight, `未マージあり` when unmerged changes blocked it, and `配送失敗` when it failed
- Done cards can be deleted from the right-click menu

### Card modal

![Card modal](docs/images/card-modal.jpg)

Clicking a card opens a centered modal.

- **Instruction buttons** under 司令塔への指示 — 状況を聞く (ask status) / 進める (advance) / 実装ブリーフ (implementation brief) / 独立レビュー (independent review) / 完了の可否 (ready to close?) — send to the commander with a single press; skill command strings never appear on screen
- **このカードへの詳細指示** (detailed instruction): free-form text is sent to the commander prefixed with the card ID
- **受け入れて完了** (accept & complete): shown on cards awaiting acceptance; one click marks them done, and the card's work is proposed to `main` as a pull request
- **成果の配送** (delivery): the delivery pull request's number, state, and link stay on the card. When there was nothing to deliver, when unmerged changes remain, or when the delivery failed, the reason is shown; the last two offer 配送をやり直す (deliver again). The same button is there after a browser restart whenever the card still records a failed delivery
- State, next action, owner, and blocker are editable in place (Escape cancels)

### Commander sidebar

The right-hand sidebar is the commander — the one cmux session you talk to.

- Toggle with the top-bar icon or **⌘B** (Ctrl+B on Linux); the state is persisted
- The terminal mirror updates almost immediately on commander activity (event-driven with a 10-second safety net, reading over a direct Unix socket — no child processes)
- 過去の出力を読む (read past output) loads up to 2,000 lines of scrollback; updates pause while you read, and 追従を再開 (resume following) returns to live tailing
- Template buttons — 今日の状況 (today's status) / 作業を割り当て (assign work) / 気づきをカードに (capture an observation) / ボード更新 (update the board) — a free-form composer with 送信 (send) and 貼り付けのみ (paste only), and key controls (Enter / Esc / ↑ / ↓ / 中断 (interrupt))
- The sidebar never opens by itself; opening and closing is always your action

## Installation

### Skills (Claude Code)

```bash
git clone https://github.com/ISSEI51/overlord-skill.git
cd overlord-skill
./scripts/install.sh claude      # personal (~/.claude/skills)
# per-project: run /path/to/overlord/scripts/install.sh project inside the target repo
```

For Codex use `./scripts/install.sh codex`. The installer refuses to overwrite existing skills with the same name.

### Updating an existing `overlord-*` install

`scripts/install.sh` stops as soon as it finds one skill of the same name (it prints `Refusing to overwrite existing skill:` and exits 1). To update, remove the five existing `overlord-*` skills and install again.

```bash
cd /path/to/overlord
git pull

# personal install (~/.claude/skills)
rm -rf ~/.claude/skills/overlord-ops \
       ~/.claude/skills/overlord-improvement-card \
       ~/.claude/skills/overlord-ux-audit \
       ~/.claude/skills/overlord-implementation-brief \
       ~/.claude/skills/overlord-change-review
./scripts/install.sh claude
```

For Codex, remove the same five under `${CODEX_HOME:-~/.codex}/skills` and run `./scripts/install.sh codex`; for a per-project install, remove `.claude/skills/overlord-*` from the target repository and run `/path/to/overlord/scripts/install.sh project`.

Check what you are about to delete with `ls -l ~/.claude/skills | grep overlord-`. Skills are read when a session starts, so restart Claude Code / Codex after reinstalling.

### Removing the old `product-*` install

The skills were renamed from `product-*` to `overlord-*`, so any install made under the old names has to be removed by hand. Otherwise the old skills stay installed: `scripts/install.sh` copies with `cp -R`, so an installer-made install leaves five real copies; a hand-made symlink install leaves five broken symlinks.

Real copies keep working with their old content, so `/product-ops` and the other four still run. Their descriptions are nearly identical to the new ones, so until you remove them the wrong skill can be picked.

```bash
# check what will be removed first
ls -l ~/.claude/skills | grep product-
ls -l ~/.codex/skills | grep product-

# Claude Code
rm -rf ~/.claude/skills/product-ops \
       ~/.claude/skills/product-improvement-card \
       ~/.claude/skills/product-ux-audit \
       ~/.claude/skills/product-implementation-brief \
       ~/.claude/skills/product-change-review

# Codex
rm -rf ~/.codex/skills/product-ops \
       ~/.codex/skills/product-improvement-card \
       ~/.codex/skills/product-ux-audit \
       ~/.codex/skills/product-implementation-brief \
       ~/.codex/skills/product-change-review
```

On a symlink, `rm -rf` removes the link itself and leaves its target untouched. If you installed per project, remove `.claude/skills/product-*` from that repository the same way.

Skills are read when a session starts, so restart Claude Code / Codex after removing them.

### Console

Requires [Bun](https://bun.sh). A prebuilt frontend is included, so it runs as is.

```bash
brew install oven-sh/bun/bun     # if not installed yet
/path/to/overlord/scripts/console.sh ensure ~/dev/your-project
```

There are two ways to start it, and both run the same server.

| Form | When to use it | Behavior |
| --- | --- | --- |
| `console.sh ensure [<project>] [--port 7400] [--open]` | the commander's entry point; you can type it yourself too | Idempotent. Creates the board if it is missing, starts the server only if nothing is serving that board yet, and registers the commander when run from a cmux session. The server runs in a cmux workspace (a detached process without cmux), so the terminal you ran it from is free again |
| `console.sh <project> [--port 7400] [--open]` | starting a console yourself with a port or a browser pane you choose | Runs the server in the foreground; closing that terminal stops the console |

Both take the same arguments in the same places. Omit the project to use the current directory; a path to a `board.yaml` also works. `--port 7400` changes the port (the default is `$OVERLORD_PORT`, then 7377), and `--open` shows the console in a cmux browser pane — it does not open your own browser.

What `ensure` prints:

| Line | Meaning |
| --- | --- |
| `board` | the board file it resolved; `<project>/docs/product-ops/board.yaml` when you passed a directory |
| `console` | the address to open in a browser |
| `board file` | `created` or `already present`; printed only on the run that starts a server |
| `server` | `already running, nothing started`, or `started,` followed by `cmux workspace <ref>` or `detached process <pid>, log: <path>` |
| `stop` | how to stop that console: close the cmux workspace, or `kill $(lsof -ti tcp:<port> -sTCP:LISTEN)` |
| `commander` | `registered, surface <id>` / `unchanged, this session is already the commander (surface <id>)` / `not registered, …` with the reason |

Two further labels show up only on their own path: `cmux` when creating the workspace failed and the console is started detached instead, and `open` when `--open` was passed and the cmux browser pane could not be opened.

`ensure` exits 1 without starting anything — and without creating the board file — in three cases:

- the project directory does not exist (`ensure` creates the board file, not the project)
- the port is serving another project's board
- the port is held by a process that is not an Overlord console

For the two port cases, pass `--port` with a free port rather than stopping whatever holds it.

Separately, it also exits 1 when the server it started does not answer `/api/state` within 30 seconds. That path has already started the server, so the `server:` and `stop:` lines are printed and the process is left running: stop it as the `stop:` line says, then read `.overlord/console.log` (or the cmux workspace, when it was started there).

Without cmux the `commander` line reads `not registered, cmux is not reachable`, followed by a line pointing at the sidebar. The board and the server still come up, and the exit code is 0.

To stop the console from delivering a card when you complete it, start it with `--no-deliver` or with `OVERLORD_DELIVER=0` in the environment. The `deliver on done` line printed at startup says which it is.

After changing the frontend, install its dependencies with `cd console/frontend && bun install`, then regenerate `console/public` with `cd console && bun run build`.

The server listens on `127.0.0.1` only and rejects requests whose `Host` / `Origin` is not loopback.

## Getting started by hand

Instead of letting the sidebar start the commander, you can promote a Claude Code session you started yourself. Start Claude Code at the root of the target repository and run:

```text
/overlord-ops
Start managing this project's work.
Review the code, existing docs, and project conventions,
then create docs/product-ops/board.yaml.
Give me at most three decisions to make first.
```

If no console is running yet, run `/path/to/overlord/scripts/console.sh ensure .` from that same Claude Code session: it starts the console and, when that session runs inside cmux, registers it as the commander in one step. If you started the console in another terminal instead, register that session as the commander from the sidebar's "変更" (change) button. A session can also write its own IDs to the board's `commander` field after reading them with `cmux identify --json --id-format both`.

To write the board yourself instead, copy this repository's `docs/product-ops/board.example.yaml` to `docs/product-ops/board.yaml` in the target repository and start from there. Its contents are invented, so replace `items` with your own cards; the schema is documented in `skills/overlord-ops/references/board-schema.md`.

A live `board.yaml` records absolute paths that contain your home directory (`commander.cwd` and `changes[].agent.cwd`) and local cmux UUIDs (`commander` and `changes[].agent`). **If the target repository is public, add `docs/product-ops/board.yaml` to its `.gitignore`** so none of that is tracked. This repository does the same, for the same reason.

For the repository's merge-method setting, see [Why merge commits](#why-merge-commits).

## The GitHub account the agent acts as

Branches Overlord pushes and pull requests it opens are attributed to your own account by default. Point Overlord at a separate account and those two operations — and only those two — happen under that account instead.

This is not only about telling the agent's work apart from yours. GitHub does not let the author of a pull request approve it, so when `main` is protected by a ruleset that requires one approval and grants no bypass, **the pull request being opened by somebody other than you is what makes "nothing reaches main without your approval" true**. A pull request that goes back to your name loses that guarantee.

With nothing configured, behaviour is unchanged: the active `gh` account pushes and opens pull requests.

### Setting it up

1. **Add the bot account to the repository as a Write collaborator.** Not Admin: an Admin can delete the ruleset, which makes the protection meaningless.

2. **Create a classic personal access token on the bot account,** with exactly the `repo`, `read:org` and `gist` scopes — the scopes `gh auth login` requires. **Do not add `workflow`**; it would let the agent rewrite the CI workflow.

   A fine-grained PAT may not work here: it cannot be granted access to a repository owned by another person's user account. For an organization-owned repository it can.

3. **Register it with `gh`.** The active account does not change, and Overlord never changes it.

   ```bash
   gh auth login --hostname github.com
   gh auth status          # two accounts; the active one stays yours
   ```

4. **Set the environment variable,** in your shell profile so it applies to every project.

   ```bash
   echo 'export OVERLORD_GH_ACCOUNT=<bot account name>' >> ~/.zshrc
   ```

   This repository's `.env` is another place to put it, but `.env` is read only by `just` recipes; `scripts/change.sh` and a console server started directly do not see it. `.env` is in `.gitignore`.

5. **Check it** in the target repository.

   ```bash
   /path/to/overlord/scripts/change.sh identity
   ```

   ```text
   agent account:    ISSEI-BOT
   token source:     gh auth token --user ISSEI-BOT
   github login:     ISSEI-BOT
   repository:       ISSEI51/overlord-skill
   permission:       WRITE
   push remote:      https://github.com/ISSEI51/overlord-skill.git
   push identity:    ISSEI-BOT
   ```

   In that order: the token can be read, the account it authenticates as is the account you named, that account has write access to this repository, and the push remote is a host the token is sent to. Anything unmet exits 1 with the reason. **The account is configured once for every project, but repository access is granted per repository, so steps 1 and 5 are what you repeat in each new project.**

### What is fixed

- **The active `gh` account is never switched.** `gh auth switch` is process-wide and permanent, so it would collide with a session running in parallel. The token is handed to each subprocess through its environment instead.
- **A configured account whose token cannot be read makes the command fail.** It never falls back to your account: a pull request quietly opened under your name is the outcome this exists to prevent.
- **The token never appears in a command line, on stdout, on stderr, or in a file.** It is passed to child processes as an environment variable and nowhere else.
- The push uses that account only when the remote is `https://github.com/...`. An ssh remote authenticates with a key, so the push happens under the key and Overlord says so rather than sending the token.
- Only the push and the pull request change hands. **Commits keep your authorship.** The ruleset looks at who opened the pull request, which is what this is about.

## Daily use

1. **Capture observations**: 気づきを追加 (add an observation) in the top bar, or 気づきをカードに (capture an observation) in the sidebar
2. **Advance**: open a card and press 進める (advance) once; the commander runs the state-appropriate step (card → brief → implement → independent review) with subagents
3. **Decide**: you only need to look at the 今日の判断 (decisions today) bar and the cyan-bordered cards; approving briefs and accepting work happens with the card's buttons
4. **Accept**: check cards in 完成確認待ち (awaiting acceptance) and press 受け入れて完了 (accept & complete); a pull request proposing the work to `main` is opened for you and its result stays on the card under 成果の配送. Merge it on GitHub, then clear finished cards via right-click

## Operating rules

- At most three cards in implementation at once; around ten active items total (the top bar warns when exceeded)
- One `board.yaml` per repository; run one console per repo on its own port for multi-repo work (`console.sh ensure <project> --port <port>`; given a port another board already serves, `ensure` stops rather than taking it over)
- The console is your view; the AI always works from `board.yaml`. Writes are protected by optimistic locking, so the AI's updates are never silently overwritten
- Independent review is done by a different subagent from the one that implemented, so no AI reviews its own change
- Pull requests targeting `main` (a card's delivery PR) are merged with a **merge commit**. Squash and rebase are not used
- To push and open pull requests under a dedicated account, see [The GitHub account the agent acts as](#the-github-account-the-agent-acts-as). A ruleset on `main` that requires one approval depends on it

### Why merge commits

A squash merge creates one new commit on `main`. The original commits from the working branch never enter `main`'s history, so the merge base does not advance even though the content is identical. If the working branch then rewrites a line the squash commit also changed — or a line close enough to it — the next PR targeting `main` conflicts on that line. PR #10 conflicted this way and was resolved by hand.

Squashing does not **always** cause a conflict. When both sides carry the same content, git resolves it. The conflict occurs when the working branch rewrites lines that overlap the squash commit's own changes; changes to distant lines in the same file still merge cleanly. Since files such as `.gitignore`, `console/src/board.ts`, and `console/src/change.ts` are edited repeatedly, it recurs as long as squashing continues.

With merge commits the merge base advances on every delivery, so the divergence never forms in the first place.

The divergence PR #10's squash created was cleared when PR #16 was merged into `main` with a merge commit.

This rule is about PRs targeting `main`. Change-level PRs target the working branch and are out of scope here.

Check the current setting with:

```bash
gh repo view --json squashMergeAllowed,mergeCommitAllowed,rebaseMergeAllowed
```

To allow merge commits only, either use the checkboxes under Settings > General > Pull Requests on GitHub, or run:

```bash
gh repo edit --enable-merge-commit=true --enable-squash-merge=false --enable-rebase-merge=false
```

This is a per-repository setting you apply by hand. Until you do, keep the rule by choosing the merge-commit option on the merge screen. Use the same setting when you start using Overlord in a new repository.
