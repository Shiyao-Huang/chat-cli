# Boardroom — your AI 经营外脑 (management exo-brain)

Boardroom turns a handful of great thinkers into a **live board of advisors** you can
convene on demand. Inject a business question; each thinker reasons *strictly in its own
framework*, consults its own seed material, and drops one sharp, falsifiable judgment into
a shared chat room. You read the stream and walk away with five distinct lenses on the same
decision — no consensus mush.

It's built entirely on `chat-cli`: no cloud, no daemon, no Mem0/RAGFlow/Dify. Just folders
and a chat room.

---

## The mental model: folders + one chat room

Everything is a folder you can read, edit, and version. There is no hidden database.

```
$BOARD_HOME/                       # default: ~/.chat-cli/boardroom
  personas/<id>/                   # one folder per thinker = the thinker
    CLAUDE.md                      #   persona for Claude Code   (Claude reads this)
    AGENTS.md                      #   persona for Codex         (Codex reads this)
    corpus/*.md                    #   the thinker's seed material (principles, quotes…)
    runtime                        #   optional: "claude" or "codex" (pins this persona)
  mem/                             # YOUR long-term memory & judgment notes
  kb/company/                      # the fact layer — your internal docs
  kb/external/                     #                 — outside-world docs
```

The live meeting is a `chat-cli` room called **boardroom** (under `$CHAT_HOME`). Two moving
parts make it come alive:

- **A persona is just a folder.** When convened, it boots as a *real interactive agent
  session* (Claude Code or Codex) launched **inside that folder**, so the agent auto-loads
  the persona file as its character.
- **tmux is the carrier.** Each persona runs in its own tmux window (a real PTY). A topic is
  "injected" with `tmux send-keys`; the persona replies by running `chat send` into the room.

Why **two** persona files? The two runtimes look for different context files:

| Runtime      | Reads as project context |
| ------------ | ------------------------ |
| Claude Code  | `CLAUDE.md`              |
| Codex        | `AGENTS.md`              |

So every persona folder ships **both** — `AGENTS.md` is the Codex-flavored twin of
`CLAUDE.md`. That's the whole reason a single thinker can come alive under either runtime.

---

## 60-second quickstart

```bash
# 1. Build chat-cli and link the CLIs (chat + boardroom) onto your PATH
npm install && npm run build && npm link

# 2. The carrier is tmux (macOS/Linux; on Windows run under WSL)
brew install tmux                      # Linux: apt/yum install tmux

# 3. Scaffold $BOARD_HOME, import the persona templates, and pre-trust them
boardroom init                         # zero-confirmation launch is set up here

# 4. Open one live agent session per thinker (default: all personas)
boardroom convene

# 5. Inject a topic — every live thinker replies into the room in its own voice
boardroom ask "Should we kill our second product line to fund the first?"

# 6. Watch the frameworks stream in (Ctrl-C to stop)
boardroom watch
```

When you're done, fold the meeting into your own memory and end the session:

```bash
boardroom digest                       # append the minutes into mem/
boardroom adjourn                      # end the session (all folders persist)
```

That's it. Give the sessions a few seconds after `convene`/`ask` — real agents are booting
and thinking, so replies trickle in rather than appearing instantly.

---

## Command reference

| Command                                    | What it does                                                                   |
| ------------------------------------------ | ------------------------------------------------------------------------------ |
| `boardroom init`                           | Scaffold `$BOARD_HOME`, import persona templates, pre-trust for zero-confirm.   |
| `boardroom add <id> [name] [--runtime …]`  | Create a persona folder (`CLAUDE.md` + `AGENTS.md` + `corpus/`).                |
| `boardroom seed <id> <file>`               | Append a file into persona `<id>`'s `corpus/`.                                  |
| `boardroom runtime <id> [claude\|codex]`   | Show or set which runtime backs a persona.                                      |
| `boardroom list`                           | List personas (folders).                                                        |
| `boardroom remember <text>`                | Append a note to YOUR long-term memory (`mem/`).                                |
| `boardroom doc <file> [company\|external]` | Import a doc into the fact layer (`kb/`).                                        |
| `boardroom convene [ids…]`                 | Open one live persona session per id (default: all). Zero confirmation screens. |
| `boardroom ask "<topic>"`                  | `send-keys` a topic into every live persona; they reply into the room.          |
| `boardroom ask-one <id> "<topic>"`         | Ask a single thinker.                                                           |
| `boardroom watch`                          | Live-tail the boardroom room.                                                   |
| `boardroom minutes [N]`                    | Print the last N messages as meeting minutes.                                   |
| `boardroom digest [N]`                     | Append the current minutes into YOUR memory (`mem/`).                           |
| `boardroom attach`                         | Attach to the tmux session (Ctrl-b d to detach, and watch them think).          |
| `boardroom status`                         | Show session + live windows + each persona's runtime.                           |
| `boardroom adjourn`                        | Kill the tmux session (folders persist).                                        |

### Environment variables

| Var                 | Meaning                                       | Default                    |
| ------------------- | --------------------------------------------- | -------------------------- |
| `BOARD_HOME`        | Boardroom root (personas, mem, kb)            | `~/.chat-cli/boardroom`    |
| `BOARD_ROOM`        | Chat room name for the meeting                | `boardroom`                |
| `BOARD_PRINCIPAL`   | Your handle in the room (who personas reply to)| `you`                     |
| `BOARD_RUNTIME`     | Default runtime for un-pinned personas        | `claude`                   |
| `BOARD_MODEL`       | Model flag passed to the runtime              | — (runtime default)        |
| `BOARD_CLAUDE_BIN`  | Claude Code binary                            | `claude`                   |
| `BOARD_CODEX_BIN`   | Codex binary                                  | `codex`                    |
| `BOARD_TMUX`        | tmux session name                             | `boardroom`                |
| `CHAT_HOME`         | `chat-cli` broker root (the room lives here)  | `~/.chat-cli/rooms`        |

---

## Add your own thinker

A thinker is a folder with a persona and some seed material. Three steps:

```bash
# 1. Scaffold the folder (creates CLAUDE.md + AGENTS.md + corpus/, and pre-trusts it)
boardroom add bezos "Jeff Bezos"

# 2. Seed its corpus with the load-bearing material it must not get wrong
boardroom seed bezos ./notes/bezos-principles.md
boardroom seed bezos ./notes/bezos-quotes.md

# 3. Bring it into the next meeting
boardroom convene bezos
boardroom ask-one bezos "Is our customer obsession real or a slogan?"
```

**Write BOTH persona files.** `boardroom add` drops a starter `CLAUDE.md` *and* a mirrored
`AGENTS.md` so the persona works under either runtime out of the box. When you make the
persona great, **edit both** — `CLAUDE.md` for Claude Code and `AGENTS.md` for Codex. Keep
them in sync; `AGENTS.md` is simply the Codex-flavored phrasing of the same character. (The
five bundled thinkers — munger, bezos, christensen, drucker, zhangyiming — already ship both,
written by hand; copy one as a model.)

A strong persona file does four things:
1. States the thinker's **ONE signature move** up front.
2. Lists the **mental moves** they make that others won't.
3. Describes **how they speak** — and what they *refuse* to do.
4. Points at `./corpus/` and ends with the **boardroom protocol** (reply via `chat send`).

### Pick a runtime per persona

A persona can run under Claude Code or Codex independently of the others:

```bash
boardroom add ada "Ada Lovelace" --runtime codex   # pin at creation
boardroom runtime munger codex                      # change later
boardroom runtime munger                            # show current (no value = read)
```

If a persona isn't pinned, it uses `BOARD_RUNTIME` (default `claude`). Pinning writes a
one-line `runtime` file into the persona folder. Use Codex where you have Codex credentials
and Claude Code where you have Claude — the board can be mixed.

---

## Feed your memory and the fact layer

The board reasons better when grounded. Two folders are yours to fill:

```bash
# YOUR judgment & long-term memory (mem/)
boardroom remember "We optimize for 5-year free cash flow, not quarterly EPS."

# Company & external facts (kb/company/, kb/external/)
boardroom doc ./q3-board-deck.pdf company
boardroom doc ./competitor-teardown.md external
```

After a session, capture what was said so it compounds over time:

```bash
boardroom minutes 40      # print the last 40 messages as minutes
boardroom digest          # append them into mem/minutes.md
```

---

## Troubleshooting

- **`tmux not found` on convene** — tmux is the carrier for the live sessions.
  macOS: `brew install tmux`. Linux: `apt install tmux` / `yum install tmux`.
  Windows: run boardroom **inside WSL** (a native Windows carrier may come later).

- **Nothing in the room yet** — these are *real* interactive agent sessions, not one-shot
  prompts. After `convene` they take a few seconds to boot, and after `ask` each thinker reads
  its corpus before replying. Wait a beat, then `boardroom watch` again. To see them thinking
  in real time, `boardroom attach` (Ctrl-b d to detach).

- **A persona launched but didn't reply** — confirm it's live with `boardroom status` (it
  should appear under *live windows*). Then check that the right runtime binary is on PATH:
  `BOARD_CLAUDE_BIN` (default `claude`) or `BOARD_CODEX_BIN` (default `codex`). Attach to read
  any error the agent printed.

- **Choosing Claude vs Codex per persona** — match the runtime to the credentials you have.
  Use `boardroom runtime <id> claude|codex` to pin per thinker, or set `BOARD_RUNTIME` for the
  default. Remember: Claude reads `CLAUDE.md`, Codex reads `AGENTS.md` — if you only edited one,
  the other runtime will fall back to a thinner character.

- **A confirmation screen appeared anyway** — `boardroom init` (and `add`/`convene`) pre-trusts
  persona folders and launches with full bypass for zero-confirm boot. If you moved
  `$BOARD_HOME` or created a folder by hand, re-run `boardroom init` to re-trust.

- **`chat: command not found`** — the persona reply command (`chat send …`) needs the `chat`
  CLI globally installed. Run `npm link` in the chat-cli repo (or otherwise put `chat` on PATH).
