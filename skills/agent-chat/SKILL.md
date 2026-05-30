---
name: agent-chat
description: Join a shared multi-agent chat room to coordinate with other agents (any runtime) via a local file broker — send pages, poll your inbox, see who's online. Use when asked to talk to / coordinate with / page another agent or join a room.
---

# agent-chat

Coordinate with other agents over a **local file broker**. No cloud, no daemon —
just files under `$CHAT_HOME`. Any runtime that can run a shell command (Claude
Code, Codex, a plain bash loop) joins the *same* conversation.

## Mental model: pager + talk-port

- **Talk-port (`send`)** — you speak into the room. A broadcast goes to everyone;
  a message with `--to <id>` is a **page** that lands on a specific agent's pager.
- **Pager (`poll`)** — you check your inbox. `poll` returns only messages newer
  than your last poll, **excluding your own**, and advances your read cursor. Use
  `--mentions` to see *only* pages addressed to you.

You are identified by an `--id` (your handle, e.g. your role). Always `join` once
before sending or polling.

## Setup (env ergonomics)

Set these once so you can omit flags. The CLI reads them as defaults:

```bash
export CHAT_ROOM=build-squad     # which room to talk in
export CHAT_ID=architect         # your handle (usually your role)
export CHAT_ROLE=architect       # declared role shown in the roster
# Optional: export CHAT_HOME=/abs/path   # broker location (default ~/.chat-cli/rooms)
```

With these set, `--room` / `--id` / `--role` can be dropped from the commands below.

## Commands (copy-pasteable)

```bash
# 1. Join the room (idempotent — safe to re-run to refresh presence).
chat join --room "$CHAT_ROOM" --id "$CHAT_ID" --role "$CHAT_ROLE"

# 2a. Broadcast to everyone in the room.
chat send --from "$CHAT_ID" --message "starting on the auth refactor"

# 2b. Page a specific agent (DIRECTED — always @mention via --to).
chat send --from "$CHAT_ID" --to tester --message "tester, suite is ready to run"

# 3. Poll your inbox (new messages since last poll; excludes your own).
chat poll --id "$CHAT_ID"

# 3b. Poll ONLY pages addressed to you.
chat poll --id "$CHAT_ID" --mentions

# 4. Block until a page arrives (use inside your work loop instead of busy-spinning).
chat wait --id "$CHAT_ID" --mentions

# 5. See who's online (presence: alive | idle | dead).
chat roster --room "$CHAT_ROOM"
```

Add `--json` to any command to get machine-readable output for scripting.

## Cooperative protocol

1. **Join first.** `chat join` once at the start. Set `CHAT_ID` to your role so
   others know who you are and can page you by that handle.
2. **Poll in your work loop.** Between units of work, run `chat poll` (or
   `chat wait --mentions` to block) so you don't miss a page. Don't go silent.
3. **Always @mention for directed messages.** Use `--to <id>` whenever a message
   is *for* a specific agent — that's what makes it land on their pager and show
   up under `--mentions`. Broadcasts (no `--to`) are for room-wide announcements.
4. **Reply by paging back.** Answer `@you` pages with `--to <their-id>`.
5. **Announce done.** When you finish, send a `notification` or `handoff` so the
   next agent can pick up:
   ```bash
   chat send --from "$CHAT_ID" --to architect --type handoff \
     --message "API done, contract in src/api/. Over to you."
   ```

## MCP alternative (for MCP-capable runtimes)

If your runtime speaks MCP, wire the `chat-mcp` server in instead of shelling out.
It exposes native tools backed by the **same** file broker:

- `chat_join` — register/refresh your presence in a room.
- `chat_send` — broadcast or page (`to`/`mentions` for directed messages).
- `chat_poll` — read new messages for your id (supports `mentionsOnly`).
- `chat_roster` — list members and their presence.

Generic MCP server config (point at the installed `chat-mcp` binary):

```json
{
  "mcpServers": {
    "chat": {
      "command": "node",
      "args": ["bin/chat-mcp.js"],
      "env": { "CHAT_ROOM": "build-squad", "CHAT_ID": "architect", "CHAT_ROLE": "architect" }
    }
  }
}
```

CLI and MCP are interchangeable — agents using either one share the same room.
