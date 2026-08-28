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
- `git` and the [GitHub CLI](https://cli.github.com/) (`gh`) — `scripts/change.sh` invokes `git` and `gh` directly, in all five subcommands (`start`, `pr`, `reviewed`, `sync`, `deliver`): `start` runs `git worktree add` and `git rev-parse`; `pr` runs `git push` plus `gh pr list` / `gh pr create` / `gh pr view`; `reviewed` runs `git worktree list` and `git rev-parse HEAD` inside the worktree, falling back to `gh pr view --json headRefOid` when the worktree is gone; `sync` runs `gh pr view`; `deliver` runs `git fetch` / `git diff` plus `gh repo view` / `gh pr view` / `gh pr create` / `gh pr edit`. So `gh` has to be authenticated with `gh auth login`. The commander runs `change.sh` for you — there is no point where you type it yourself
- [cmux](https://cmux.com/) — a macOS terminal that holds several AI sessions as workspaces on one screen. Overlord reads the commander session's screen and sends its input through cmux, which is why it is required for the commander sidebar and the card instruction buttons

Platform: the console and the skills contain no macOS-specific code, so they run anywhere Bun runs (macOS and Linux). cmux is a macOS app; when `cmux` is not on `PATH` the console falls back to `/Applications/cmux.app/Contents/Resources/bin/cmux`. Without cmux you can still browse and edit the kanban, add observations, and run every `scripts/change.sh` command. What you lose is the commander sidebar, the card instruction buttons, and `console.sh --open`.

Overlord is two things: **five skills** the AI reads, and the **console** you look at (the screenshot above). Step 1 installs the skills, step 2 starts the console.

1. **Install the skills**

   ```bash
   git clone https://github.com/ISSEI51/overlord-skill.git
   cd overlord-skill
   ./scripts/install.sh claude          # for Codex: ./scripts/install.sh codex
   ```

2. **Start the console against the project you want to manage**

   ```bash
   ./scripts/console.sh ~/dev/your-project
   ```

   It prints the address it listens on (`http://127.0.0.1:7377` by default). Open it in a browser.

3. **Set up the commander** — in the right sidebar (open on first launch; the top-bar icon or **⌘B**, Ctrl+B on Linux, toggles it), press "司令塔を新しく起動" (start a new commander), enter the project directory, and press start. The console creates a cmux workspace running Claude Code, records it as the commander, and pre-fills the composer with the first instruction. Press send: the commander reads `docs/product-ops/board.yaml` (creating it if it does not exist) and reports today's status.

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
- **Cyan border** = a card that needs you (awaiting acceptance, owned by you, or listed in today's decisions)
- **Yellow border** = a card the AI is actively working on
- The "decisions today" bar shows at most three things only you can decide
- Done cards can be deleted from the right-click menu

### Card modal

![Card modal](docs/images/card-modal.jpg)

Clicking a card opens a centered modal.

- **Instruction buttons** under 司令塔への指示 — 状況を聞く (ask status) / 進める (advance) / 実装ブリーフ (implementation brief) / 独立レビュー (independent review) / 完了の可否 (ready to close?) — send to the commander with a single press; skill command strings never appear on screen
- **このカードへの詳細指示** (detailed instruction): free-form text is sent to the commander prefixed with the card ID
- **受け入れて完了** (accept & complete): shown on cards awaiting acceptance; one click marks them done
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
/path/to/overlord/scripts/console.sh ~/dev/your-project
```

Opens at `http://127.0.0.1:7377`. Use `--port 7400` to change the port, `--open` to open it in a cmux browser pane.

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

Start the console in another terminal and register that session as the commander from the sidebar's "変更" (change) button. A session can also write its own IDs to the board's `commander` field after reading them with `cmux identify --json --id-format both`.

To write the board yourself instead, copy this repository's `docs/product-ops/board.example.yaml` to `docs/product-ops/board.yaml` in the target repository and start from there. Its contents are invented, so replace `items` with your own cards; the schema is documented in `skills/overlord-ops/references/board-schema.md`.

A live `board.yaml` records absolute paths that contain your home directory (`commander.cwd` and `changes[].agent.cwd`) and local cmux UUIDs (`commander` and `changes[].agent`). **If the target repository is public, add `docs/product-ops/board.yaml` to its `.gitignore`** so none of that is tracked. This repository does the same, for the same reason.

For the repository's merge-method setting, see [Why merge commits](#why-merge-commits).

## Daily use

1. **Capture observations**: 気づきを追加 (add an observation) in the top bar, or 気づきをカードに (capture an observation) in the sidebar
2. **Advance**: open a card and press 進める (advance) once; the commander runs the state-appropriate step (card → brief → implement → independent review) with subagents
3. **Decide**: you only need to look at the 今日の判断 (decisions today) bar and the cyan-bordered cards; approving briefs and accepting work happens with the card's buttons
4. **Accept**: check cards in 完成確認待ち (awaiting acceptance) and press 受け入れて完了 (accept & complete); clear finished cards via right-click

## Operating rules

- At most three cards in implementation at once; around ten active items total (the top bar warns when exceeded)
- One `board.yaml` per repository; run one console per repo (on different ports) for multi-repo work
- The console is your view; the AI always works from `board.yaml`. Writes are protected by optimistic locking, so the AI's updates are never silently overwritten
- Independent review is done by a different subagent from the one that implemented, so no AI reviews its own change
- Pull requests targeting `main` (a card's delivery PR) are merged with a **merge commit**. Squash and rebase are not used

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
