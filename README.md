# chat-cli

**A runtime-agnostic pager + talk-port for agents.** Any agent — Claude Code,
Codex, or a plain shell loop — joins the *same* conversation through the *same*
local file broker. No cloud, no daemon, no runtime-specific SDK: just files.

## Why

Multi-agent coordination usually means a bespoke server or a runtime-locked SDK.
`chat-cli` replaces all of that with an append-only log under a shared directory.
If two processes can read and write the same folder, they can page each other.

- **Pager** — `poll` your inbox: only messages newer than your last read,
  excluding your own. `--mentions` shows only pages addressed to you.
- **Talk-port** — `send` into the room: a broadcast for everyone, or a directed
  page with `--to <id>`.

## Architecture

```
            ┌──────────────────── $CHAT_HOME (a directory) ────────────────────┐
            │  <room>/messages.jsonl   append-only log (atomic O_APPEND writes) │
            │  <room>/members.json     roster + presence (alive/idle/dead)      │
            │  <room>/cursors/<id>.json per-member read cursor ("pager seen")   │
            └──────────────────────────────────────────────────────────────────┘
                      ▲                    ▲                     ▲
                      │ files only         │ files only          │ files only
         ┌────────────┴───────┐  ┌─────────┴────────┐  ┌─────────┴──────────┐
         │  CLI  (bin/chat.js)│  │ MCP (chat-mcp.js)│  │ core lib (import it)│
         │  universal entry   │  │ native MCP tools │  │  ChatBroker class   │
         └────────────────────┘  └──────────────────┘  └─────────────────────┘
```

Three layers over one substrate:

1. **Core lib** (`src/core/`, frozen) — the `ChatBroker` class. Every method is a
   pure file op. No network, no daemon, no shared memory.
2. **CLI** (`bin/chat.js` → `dist/cli.js`) — the universal entry. Any
   shell-capable runtime participates by spawning it.
3. **MCP server** (`bin/chat-mcp.js` → `dist/mcp/server.js`) — native
   `chat_join` / `chat_send` / `chat_poll` / `chat_roster` tools for MCP runtimes.

The broker root is `$CHAT_HOME` (defaults to `~/.chat-cli/rooms`). Every process
that shares `CHAT_HOME` rendezvous on the same broker — that's the whole trick.

## Install / build

```bash
npm install
npm run build      # compiles src/ -> dist/ (produces dist/cli.js, dist/mcp/server.js)
```

The bin shims (`bin/chat.js`, `bin/chat-mcp.js`) load the compiled output, so run
`npm run build` before using `chat` / `chat-mcp`. (For development you can also
run the source directly with `npm run dev` / `npm run mcp` via tsx.)

## Quickstart 1 — two shells paging each other

Open two terminals. They share state via `CHAT_HOME` (set the same value in both,
or rely on the default `~/.chat-cli/rooms`).

```bash
# ── Terminal A (architect) ───────────────────────────────
export CHAT_HOME=/tmp/chat-demo CHAT_ROOM=demo CHAT_ID=architect CHAT_ROLE=architect
chat join  --room "$CHAT_ROOM" --id "$CHAT_ID" --role "$CHAT_ROLE"
chat send  --from "$CHAT_ID" --to tester --message "tester, please run the suite"
chat poll  --id "$CHAT_ID" --mentions      # later: read tester's reply
```

```bash
# ── Terminal B (tester) ──────────────────────────────────
export CHAT_HOME=/tmp/chat-demo CHAT_ROOM=demo CHAT_ID=tester CHAT_ROLE=tester
chat join  --room "$CHAT_ROOM" --id "$CHAT_ID" --role "$CHAT_ROLE"
chat poll  --id "$CHAT_ID"                  # see the page from architect
chat send  --from "$CHAT_ID" --to architect --message "suite is green ✅"
chat roster --room "$CHAT_ROOM"             # both members, presence alive
```

Want proof it works across truly separate OS processes? Run the end-to-end check:

```bash
npm run e2e      # spawns 'alice' and 'bob' as distinct processes; prints E2E_OK on success
```

## Quickstart 2 — wire the MCP server into an agent

Point any MCP-capable runtime at the `chat-mcp` binary. The `env` block presets
the room and your handle so the tools need fewer arguments.

```json
{
  "mcpServers": {
    "chat": {
      "command": "node",
      "args": ["bin/chat-mcp.js"],
      "env": {
        "CHAT_HOME": "/tmp/chat-demo",
        "CHAT_ROOM": "demo",
        "CHAT_ID": "architect",
        "CHAT_ROLE": "architect"
      }
    }
  }
}
```

This exposes `chat_join`, `chat_send`, `chat_poll`, and `chat_roster` — backed by
the same file broker the CLI uses, so MCP agents and CLI agents share the room.

## Command reference

| Command           | What it does                                              | Key flags                                                        |
| ----------------- | -------------------------------------------------------- | ---------------------------------------------------------------- |
| `chat join`       | Register / refresh your presence in a room               | `--room` `--id` `--role` `--name` `--runtime` `--bio`            |
| `chat send`       | Broadcast, or page a specific member with `--to`         | `--from` `--message` `--to <id>` `--type` `--priority`          |
| `chat poll`       | Read new messages since your last poll (excludes own)    | `--id` `--mentions` `--since <cursor>` `--limit` `--peek` |
| `chat wait`       | Block until a (mentioning) message arrives, then return  | `--id` `--mentions` `--timeout`                                  |
| `chat roster`     | List members + presence (`alive` / `idle` / `dead`)      | `--room`                                                         |
| `chat history`    | Print recent room history (oldest → newest)              | `--room` `--limit` `--before <id>`                              |
| `chat rooms`      | List rooms under `$CHAT_HOME`                             | —                                                                |

Add `--json` to any command for machine-readable output.

### Environment variables

| Var          | Meaning                                  | Default               |
| ------------ | ---------------------------------------- | --------------------- |
| `CHAT_HOME`  | Broker root directory                    | `~/.chat-cli/rooms`   |
| `CHAT_ROOM`  | Default room (fills in `--room`)         | —                     |
| `CHAT_ID`    | Default member id / handle (`--id`)      | —                     |
| `CHAT_ROLE`  | Default role for `join` (`--role`)       | —                     |
| `CHAT_RUNTIME` | Default runtime tag for `join` (`--runtime`) | —                 |

## Agent skill

`skills/agent-chat/SKILL.md` teaches an agent the pager/talk-port model and the
exact commands — drop it into a Claude Code or Codex skills directory so the
agent can self-serve coordination.

## License

MIT
