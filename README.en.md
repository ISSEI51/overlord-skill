# Overlord

[日本語](README.md) | [English](README.en.md) · [MIT License](LICENSE)

## You are the Overlord. You make the decisions that matter.

Let AI agents investigate, plan, implement, review, and track the work — while you focus on priorities, direction, and final decisions.

Overlord is a control layer that runs your Claude Code and Codex agents as a development team instead of as a single coder. Every change is one worktree, one branch, one pull request, one agent run, so several pieces of work can move in parallel while the only thing left in your hands is deciding.

![Overlord Console](docs/images/console-board.jpg)

## Highlights

- **Only decisions reach you** — the "decisions today" bar holds at most three items. A cyan border means a card is waiting on you; a yellow border means an AI is working on it. Those two signals are the whole dashboard
- **Agents work as a team** — you talk to exactly one session, the commander. It dispatches each card's discovery, brief, implementation, and review to subagents
- **Parallel work, one pull request at a time** — 1 change = 1 worktree = 1 branch = 1 pull request = 1 agent run. Large work is split into changes, not into more cards
- **No AI signs off on its own change** — the independent review runs in a different subagent, and a change whose reviewed commit is not the pull request head never reaches acceptance
- **One file holds the state** — agents read and write only `docs/product-ops/board.yaml`; you see it as a kanban in the browser. Writes are guarded by optimistic locking
- **Local only** — the console listens on `127.0.0.1` and rejects any request whose `Host` or `Origin` is not loopback

## Quick start

You need:

- [Claude Code](https://claude.com/claude-code) (or Codex)
- [Bun](https://bun.sh) — required to run Overlord Console
- cmux — required for the commander sidebar and the card instruction buttons. Without cmux you can still browse and edit the kanban and add observations

1. **Install the skills**

   ```bash
   git clone https://github.com/ISSEI51/overlord-skill.git
   cd overlord-skill
   ./scripts/install.sh claude          # for Codex: ./scripts/install.sh codex
   ```

2. **Start the console against the project you want to run**

   ```bash
   ./scripts/console.sh ~/dev/your-project
   ```

   It prints the address it listens on (`http://127.0.0.1:7377` by default). Open it in a browser.

3. **Set up the commander** — in the right sidebar (open on first launch; the top-bar icon or **⌘B** toggles it), press "司令塔を新しく起動" (start a new commander), enter the project directory, and press start. The console creates a cmux workspace running Claude Code, records it as the commander, and pre-fills the composer with the first instruction. Press send: the commander reads `docs/product-ops/board.yaml` (creating it if it does not exist) and reports today's status.

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
| `docs/product-ops/board.yaml` | The single machine-readable source of truth |
| Overlord Console | A browser dashboard that renders and edits the board file |
| Commander | The one cmux session you talk to; it dispatches each card's work to subagents |

### Cards, changes, and tasks

The board has three levels, and **you only manage the top one**.

| Level | Meaning | Where you see it |
| --- | --- | --- |
| **Card** | One product outcome; the human decision unit | A card on the kanban |
| **Change** | One delivery unit: 1 change = 1 worktree = 1 branch = 1 PR = 1 agent execution unit | Read-only inside the card modal |
| **Task** | A step inside an agent's run | Never shown |

A change moves one pull request at a time: `start` creates its worktree and branch, `pr` pushes it and opens the pull request, `reviewed` records the commit the independent review read, and `sync` writes the pull request state back after the merge. `scripts/change.sh` runs each step and records it on the board, so nobody edits the board by hand. A change whose reviewed commit is not the pull request head does not go to acceptance.

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

A local dashboard built with React + shadcn/ui. Changes to `board.yaml` appear on screen automatically. The interface is in Japanese.

### Board

- An eight-column kanban (inbox / discovery / specified / implementing / reviewing / acceptance / done / blocked) with drag & drop
- **Cyan border** = a card that needs you (awaiting acceptance, owned by you, or listed in today's decisions)
- **Yellow border** = a card the AI is actively working on
- The "decisions today" bar shows at most three things only you can decide
- Done cards can be deleted from the right-click menu

### Card modal

![Card modal](docs/images/card-modal.jpg)

Clicking a card opens a centered modal.

- **Instruction buttons** (ask status / advance / implementation brief / independent review / ready to close?) send to the commander with a single press; skill command strings never appear on screen
- **Detailed instruction**: free-form text is sent to the commander prefixed with the card ID
- **Accept & complete**: shown on cards awaiting acceptance; one click marks them done
- State, next action, owner, and blocker are editable in place (Escape cancels)

### Commander sidebar

The right-hand sidebar is the commander — the one cmux session you talk to.

- Toggle with the top-bar icon or **⌘B**; the state is persisted
- The terminal mirror updates almost immediately on commander activity (event-driven with a 10-second safety net, reading over a direct Unix socket — no child processes)
- "Read past output" loads up to 2,000 lines of scrollback; updates pause while you read, and "resume following" returns to live tailing
- Template buttons (today's status / assign work / capture an observation / update the board), a free-form composer, and key controls (Enter / Esc / ↑ / ↓ / interrupt)
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

## Daily use

1. **Capture observations**: "Add an observation" in the top bar, or "capture an observation" in the sidebar
2. **Advance**: open a card and press "advance" once; the commander runs the state-appropriate step (card → brief → implement → independent review) with subagents
3. **Decide**: you only need to look at "decisions today" and cyan-bordered cards; approving briefs and accepting work happens with the card's buttons
4. **Accept**: check cards awaiting acceptance and press "accept & complete"; clear finished cards via right-click

## Operating rules

- At most three cards in implementation at once; around ten active items total (the top bar warns when exceeded)
- One `board.yaml` per repository; run one console per repo (on different ports) for multi-repo work
- The console is your view; the AI always works from `board.yaml`. Writes are protected by optimistic locking, so the AI's updates are never silently overwritten
- Independent review is done by a different subagent from the one that implemented, so no AI reviews its own change
