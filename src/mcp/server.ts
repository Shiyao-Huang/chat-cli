/**
 * MCP stdio server for chat-cli.
 *
 * Exposes the local-file ChatBroker as native MCP tools so any MCP-capable
 * agent (Claude Code, Codex, etc.) shares the SAME room as CLI/shell agents.
 * Mental model: a "pager + talk-port".
 *   - chat_send  is the TALK-PORT: you speak into the room (optionally @mention
 *     specific members so it lands on their pager).
 *   - chat_poll  is your PAGER: you call it to collect messages addressed to
 *     you / broadcast since your last poll.
 *
 * All tools are backed by ChatBroker(CHAT_HOME) — the same local files the CLI
 * uses — so MCP, CLI, and plain shell agents rendezvous on one conversation.
 *
 * IDENTITY: defaults are read from env CHAT_ROOM / CHAT_ID / CHAT_ROLE /
 * CHAT_RUNTIME. Per-tool room/id/from args OVERRIDE the env. If neither an arg
 * nor env supplies a required room/id, the tool returns an error with a clear
 * remediation message.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { ChatBroker } from '../core/index.js';

// One broker, shared across all tool calls. Root comes from CHAT_HOME (handled
// inside ChatBroker), so every process pointed at the same CHAT_HOME agrees.
const broker = new ChatBroker();

// ── env-backed identity defaults ─────────────────────────────────────────────

const ENV_ROOM = process.env.CHAT_ROOM?.trim() || undefined;
const ENV_ID = process.env.CHAT_ID?.trim() || undefined;
const ENV_ROLE = process.env.CHAT_ROLE?.trim() || undefined;
const ENV_RUNTIME = process.env.CHAT_RUNTIME?.trim() || undefined;

/** Resolve a value: explicit arg wins, then env fallback, else undefined. */
function pick(arg: string | undefined, env: string | undefined): string | undefined {
  const a = arg?.trim();
  if (a) return a;
  return env;
}

// ── result helpers ───────────────────────────────────────────────────────────

type ToolResult = {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
};

/** Concise success payload — JSON so the calling agent can parse it. */
function ok(payload: unknown): ToolResult {
  const text =
    typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
  return { content: [{ type: 'text', text }] };
}

/** Error payload with a clear remediation message. */
function fail(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/**
 * Resolve the required room, or return an error result explaining how to fix it.
 * Returns a discriminated union so callers can early-return on error.
 */
function resolveRoom(
  arg: string | undefined,
): { ok: true; room: string } | { ok: false; error: ToolResult } {
  const room = pick(arg, ENV_ROOM);
  if (!room) {
    return {
      ok: false,
      error: fail(
        'No room specified. Pass a `room` argument or set the CHAT_ROOM ' +
          'environment variable before starting the MCP server.',
      ),
    };
  }
  return { ok: true, room };
}

/**
 * Resolve the required member id, or return an error result. `argName` is the
 * tool's field name ("id" or "from") so the message points at the right knob.
 */
function resolveId(
  arg: string | undefined,
  argName: 'id' | 'from',
): { ok: true; id: string } | { ok: false; error: ToolResult } {
  const id = pick(arg, ENV_ID);
  if (!id) {
    return {
      ok: false,
      error: fail(
        `No member id specified. Pass a \`${argName}\` argument or set the ` +
          'CHAT_ID environment variable (and call chat_join first to announce ' +
          'yourself to the room).',
      ),
    };
  }
  return { ok: true, id };
}

// ── server + tools ───────────────────────────────────────────────────────────

const server = new McpServer({ name: 'chat-cli', version: '0.1.0' });

// chat_join ────────────────────────────────────────────────────────────────
server.registerTool(
  'chat_join',
  {
    title: 'Join a chat room',
    description:
      'Announce yourself to a room so others see you on the roster and can ' +
      '@mention you. Idempotent: re-joining refreshes your entry and presence. ' +
      'Call this once at the start of a session before sending or polling. ' +
      'Defaults come from env CHAT_ROOM / CHAT_ID / CHAT_ROLE / CHAT_RUNTIME; ' +
      'any argument overrides the matching env var.',
    inputSchema: {
      room: z
        .string()
        .optional()
        .describe('Room to join. Defaults to env CHAT_ROOM.'),
      id: z
        .string()
        .optional()
        .describe('Your member id within the room. Defaults to env CHAT_ID.'),
      role: z
        .string()
        .optional()
        .describe('Your declared role/title. Defaults to env CHAT_ROLE.'),
      displayName: z
        .string()
        .optional()
        .describe('Optional human-friendly display name.'),
      runtime: z
        .string()
        .optional()
        .describe('Runtime tag (e.g. "claude-code", "codex", "shell"). Defaults to env CHAT_RUNTIME.'),
      bio: z
        .string()
        .optional()
        .describe('Optional short self-description shown in the roster.'),
    },
  },
  async (args) => {
    const r = resolveRoom(args.room);
    if (!r.ok) return r.error;
    const m = resolveId(args.id, 'id');
    if (!m.ok) return m.error;
    const role = pick(args.role, ENV_ROLE) ?? 'member';
    const runtime = pick(args.runtime, ENV_RUNTIME);
    try {
      const member = broker.join({
        room: r.room,
        id: m.id,
        role,
        displayName: args.displayName,
        runtime,
        bio: args.bio,
      });
      return ok({ joined: true, room: r.room, member });
    } catch (err) {
      return fail(`chat_join failed: ${(err as Error).message}`);
    }
  },
);

// chat_send ────────────────────────────────────────────────────────────────
server.registerTool(
  'chat_send',
  {
    title: 'Send a message (talk-port)',
    description:
      'TALK-PORT: speak into the room. With no `mentions` the message is a ' +
      'broadcast every member sees on their next poll. List member ids in ' +
      '`mentions` to also page those members specifically. Use `type` to ' +
      'classify (chat/task-update/notification/help-needed/handoff/system) and ' +
      '`priority` (normal/high/urgent) to flag importance. `from` defaults to ' +
      'env CHAT_ID. Returns the stored message id.',
    inputSchema: {
      content: z.string().describe('The message body to post.'),
      room: z
        .string()
        .optional()
        .describe('Room to post to. Defaults to env CHAT_ROOM.'),
      from: z
        .string()
        .optional()
        .describe('Sender member id. Defaults to env CHAT_ID.'),
      mentions: z
        .array(z.string())
        .optional()
        .describe('Member ids to page directly (lands on their pager). Empty/omitted = broadcast.'),
      type: z
        .enum(['chat', 'task-update', 'notification', 'help-needed', 'handoff', 'system'])
        .optional()
        .describe('Message classification. Defaults to "chat".'),
      priority: z
        .enum(['normal', 'high', 'urgent'])
        .optional()
        .describe('Priority flag for the recipients.'),
      shortContent: z
        .string()
        .optional()
        .describe('Optional <=150 char summary for dense logs.'),
    },
  },
  async (args) => {
    const r = resolveRoom(args.room);
    if (!r.ok) return r.error;
    const f = resolveId(args.from, 'from');
    if (!f.ok) return f.error;
    try {
      const msg = broker.send({
        room: r.room,
        from: f.id,
        content: args.content,
        shortContent: args.shortContent,
        type: args.type,
        mentions: args.mentions,
        priority: args.priority,
      });
      return ok({ sent: true, id: msg.id, room: msg.room, timestamp: msg.timestamp });
    } catch (err) {
      return fail(`chat_send failed: ${(err as Error).message}`);
    }
  },
);

// chat_poll ────────────────────────────────────────────────────────────────
server.registerTool(
  'chat_poll',
  {
    title: 'Poll your pager',
    description:
      'PAGER: fetch messages addressed to you or broadcast to the room since ' +
      'your last poll. Excludes your own messages. By default this ADVANCES ' +
      'your read cursor so the same messages are not returned twice — set ' +
      '`peek: true` to look without advancing. Use `mentionsOnly: true` to ' +
      'fetch only messages that @mention you. `id` defaults to env CHAT_ID. ' +
      'Returns the new messages plus the updated cursor.',
    inputSchema: {
      room: z
        .string()
        .optional()
        .describe('Room to poll. Defaults to env CHAT_ROOM.'),
      id: z
        .string()
        .optional()
        .describe('Your member id (whose pager to read). Defaults to env CHAT_ID.'),
      mentionsOnly: z
        .boolean()
        .optional()
        .describe('If true, only return messages that @mention you.'),
      limit: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Max messages to return (default 100).'),
      peek: z
        .boolean()
        .optional()
        .describe('If true, do NOT advance your read cursor (look without marking read).'),
    },
  },
  async (args) => {
    const r = resolveRoom(args.room);
    if (!r.ok) return r.error;
    const m = resolveId(args.id, 'id');
    if (!m.ok) return m.error;
    try {
      const result = broker.poll(r.room, m.id, {
        mentionsOnly: args.mentionsOnly,
        limit: args.limit,
        advance: !args.peek,
      });
      return ok({
        room: r.room,
        count: result.messages.length,
        cursor: result.cursor,
        messages: result.messages,
      });
    } catch (err) {
      return fail(`chat_poll failed: ${(err as Error).message}`);
    }
  },
);

// chat_roster ──────────────────────────────────────────────────────────────
server.registerTool(
  'chat_roster',
  {
    title: 'List room members',
    description:
      'List everyone in a room with their computed presence ' +
      '(alive / idle / dead). Use this to see who is around before paging ' +
      'someone via chat_send `mentions`. Defaults to env CHAT_ROOM.',
    inputSchema: {
      room: z
        .string()
        .optional()
        .describe('Room whose roster to list. Defaults to env CHAT_ROOM.'),
    },
  },
  async (args) => {
    const r = resolveRoom(args.room);
    if (!r.ok) return r.error;
    try {
      const roster = broker.roster(r.room);
      return ok({ room: r.room, count: roster.length, members: roster });
    } catch (err) {
      return fail(`chat_roster failed: ${(err as Error).message}`);
    }
  },
);

// chat_history ─────────────────────────────────────────────────────────────
server.registerTool(
  'chat_history',
  {
    title: 'Read recent room history',
    description:
      'Read recent messages from a room (oldest..newest), independent of your ' +
      'pager cursor. Useful for catching up on context without affecting your ' +
      'unread state. Defaults to env CHAT_ROOM.',
    inputSchema: {
      room: z
        .string()
        .optional()
        .describe('Room whose history to read. Defaults to env CHAT_ROOM.'),
      limit: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Max messages to return (default 50).'),
    },
  },
  async (args) => {
    const r = resolveRoom(args.room);
    if (!r.ok) return r.error;
    try {
      const messages = broker.history(r.room, { limit: args.limit });
      return ok({ room: r.room, count: messages.length, messages });
    } catch (err) {
      return fail(`chat_history failed: ${(err as Error).message}`);
    }
  },
);

// chat_rooms ───────────────────────────────────────────────────────────────
server.registerTool(
  'chat_rooms',
  {
    title: 'List rooms',
    description:
      'List all rooms known to this local broker. Use this to discover ' +
      'available conversations before joining one.',
    inputSchema: {},
  },
  async () => {
    try {
      const rooms = broker.listRooms();
      return ok({ count: rooms.length, rooms });
    } catch (err) {
      return fail(`chat_rooms failed: ${(err as Error).message}`);
    }
  },
);

// ── boot ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
