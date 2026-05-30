/**
 * chat-cli — the universal command-line "pager + talk-port".
 *
 * Lowest-common-denominator entry: anything that can run a shell command joins
 * the SAME conversation through the SAME local file broker. CLI = universal
 * entry; MCP = native tools. Hand-rolled arg parsing, no extra deps.
 *
 * Identity defaults come from env so agents don't repeat flags:
 *   CHAT_ROOM -> --room, CHAT_ID -> --id, CHAT_ROLE -> --role, CHAT_RUNTIME -> --runtime.
 * Broker root honors CHAT_HOME automatically (see ChatBroker / brokerRoot).
 *
 * Exit codes: 0 success, 2 = `wait` timed out with no messages, 1 = usage/validation error.
 */

import { ChatBroker } from './core/index.js';
import type {
  ChatMessage,
  MessageType,
  Priority,
  RosterEntry,
} from './core/index.js';

// ── tiny arg parser ──────────────────────────────────────────────────────────

interface ParsedArgs {
  /** Named flags: --flag value  OR  --flag (boolean true). */
  flags: Map<string, string | true>;
  /** Everything that wasn't consumed as a flag/value (positional). */
  positionals: string[];
}

/**
 * Parse `argv` (already sliced past the subcommand). A token "--name" followed
 * by a non-flag token consumes it as the value; otherwise it's a boolean flag.
 * `--name=value` is also supported. `--` ends flag parsing.
 */
function parseArgs(argv: string[], booleanFlags: Set<string>): ParsedArgs {
  const flags = new Map<string, string | true>();
  const positionals: string[] = [];
  let i = 0;
  let onlyPositional = false;
  while (i < argv.length) {
    const tok = argv[i];
    if (onlyPositional) {
      positionals.push(tok);
      i++;
      continue;
    }
    if (tok === '--') {
      onlyPositional = true;
      i++;
      continue;
    }
    if (tok.startsWith('--')) {
      const body = tok.slice(2);
      const eq = body.indexOf('=');
      if (eq !== -1) {
        flags.set(body.slice(0, eq), body.slice(eq + 1));
        i++;
        continue;
      }
      const name = body;
      if (booleanFlags.has(name)) {
        flags.set(name, true);
        i++;
        continue;
      }
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags.set(name, next);
        i += 2;
      } else {
        // No value follows; treat as a present boolean flag.
        flags.set(name, true);
        i++;
      }
      continue;
    }
    positionals.push(tok);
    i++;
  }
  return { flags, positionals };
}

function flagStr(p: ParsedArgs, ...names: string[]): string | undefined {
  for (const n of names) {
    const v = p.flags.get(n);
    if (typeof v === 'string') return v;
  }
  return undefined;
}

function flagBool(p: ParsedArgs, ...names: string[]): boolean {
  for (const n of names) {
    if (p.flags.has(n)) return true;
  }
  return false;
}

function flagNum(p: ParsedArgs, def: number, ...names: string[]): number {
  const raw = flagStr(p, ...names);
  if (raw === undefined) return def;
  const n = Number(raw);
  return Number.isFinite(n) ? n : def;
}

// ── env-backed identity defaults ─────────────────────────────────────────────

const ENV = {
  room: process.env.CHAT_ROOM,
  id: process.env.CHAT_ID,
  role: process.env.CHAT_ROLE,
  runtime: process.env.CHAT_RUNTIME,
};

function resolveRoom(p: ParsedArgs): string | undefined {
  return flagStr(p, 'room', 'r') ?? ENV.room;
}
function resolveId(p: ParsedArgs): string | undefined {
  return flagStr(p, 'id', 'i') ?? ENV.id;
}
function resolveRole(p: ParsedArgs): string | undefined {
  return flagStr(p, 'role') ?? ENV.role;
}
function resolveRuntime(p: ParsedArgs): string | undefined {
  return flagStr(p, 'runtime') ?? ENV.runtime;
}

// ── error type for clean usage/validation failures ──────────────────────────

class UsageError extends Error {}

function need(value: string | undefined, what: string): string {
  if (value === undefined || value === '') {
    throw new UsageError(`missing required ${what}`);
  }
  return value;
}

// ── formatting helpers ───────────────────────────────────────────────────────

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function hhmmss(ts: number): string {
  const d = new Date(ts);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/** Human-friendly relative age, e.g. "3s", "5m", "2h", "4d". */
function ageStr(fromMs: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - fromMs) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
}

/** A scannable one-line render of a message; marks @you and priority. */
function formatMessage(m: ChatMessage, viewerId?: string): string {
  const time = hhmmss(m.timestamp);
  const who = m.fromDisplayName ? `${m.fromDisplayName}` : m.from;
  const mentionsYou = !!viewerId && m.mentions?.includes(viewerId);
  const tags: string[] = [];
  if (m.priority === 'urgent') tags.push('!urgent');
  else if (m.priority === 'high') tags.push('!high');
  if (mentionsYou) tags.push('@you');
  if (m.type && m.type !== 'chat') tags.push(`#${m.type}`);
  const tagStr = tags.length ? ` ${tags.join(' ')}` : '';
  return `[${time}] <${who}> (${m.from})${tagStr} ▸ ${m.content}`;
}

function printMessages(messages: ChatMessage[], viewerId?: string): void {
  for (const m of messages) {
    process.stdout.write(formatMessage(m, viewerId) + '\n');
  }
}

function printJson(value: unknown): void {
  process.stdout.write(JSON.stringify(value) + '\n');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── usage text ───────────────────────────────────────────────────────────────

const USAGE = `chat — universal pager + talk-port (local file broker)

Usage: chat <command> [options]

Identity defaults read from env: CHAT_ROOM, CHAT_ID, CHAT_ROLE, CHAT_RUNTIME.
Broker root honors CHAT_HOME (else ~/.chat-cli/rooms).

Commands:
  join     --room R --id ID --role ROLE [--name DISPLAY] [--runtime RT] [--bio B]
             Register/refresh a member in a room.

  send     --room R --from ID (--message "..." | positional message)
             [--to a,b,c] [--type T] [--priority P] [--name DISPLAY] [--short S]
             Post a message. --from may also be given as --id. @mentions via --to.

  poll     --room R --id ID [--mentions] [--limit N] [--peek] [--json]
             Print messages newer than your cursor (excludes your own).
             --peek does not advance the cursor.

  wait     --room R --id ID [--mentions] [--timeout S=60] [--interval S=2] [--json]
             Block until >=1 new message arrives, print them, exit 0.
             Exit 2 if it times out with nothing new.

  watch    --room R --id ID [--mentions] [--interval S=2]
             Tail forever, printing new messages as they arrive (Ctrl-C to stop).

  roster   --room R [--json]
             List members: id, role, runtime, presence, age since lastSeen.

  history  --room R [--limit N=30] [--json]
             Print recent messages (oldest..newest).

  rooms    List known room names.

  leave    --room R --id ID
             Remove yourself from a room's roster.

  help     Show this help.

Message types: chat | task-update | notification | help-needed | handoff | system
Priorities:    normal | high | urgent

Exit codes: 0 ok, 2 = wait timeout (no messages), 1 = usage/validation error.
`;

function printUsage(toStderr = false): void {
  if (toStderr) process.stderr.write(USAGE);
  else process.stdout.write(USAGE);
}

// ── shared option resolution ─────────────────────────────────────────────────

function parseMentions(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  const list = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return list.length ? list : undefined;
}

const VALID_TYPES = new Set<MessageType>([
  'chat',
  'task-update',
  'notification',
  'help-needed',
  'handoff',
  'system',
]);
const VALID_PRIORITIES = new Set<Priority>(['normal', 'high', 'urgent']);

function parseType(raw: string | undefined): MessageType | undefined {
  if (raw === undefined) return undefined;
  if (!VALID_TYPES.has(raw as MessageType)) {
    throw new UsageError(
      `invalid --type ${JSON.stringify(raw)} (expected one of: ${[...VALID_TYPES].join(', ')})`,
    );
  }
  return raw as MessageType;
}

function parsePriority(raw: string | undefined): Priority | undefined {
  if (raw === undefined) return undefined;
  if (!VALID_PRIORITIES.has(raw as Priority)) {
    throw new UsageError(
      `invalid --priority ${JSON.stringify(raw)} (expected one of: ${[...VALID_PRIORITIES].join(', ')})`,
    );
  }
  return raw as Priority;
}

// ── command implementations ──────────────────────────────────────────────────

function cmdJoin(broker: ChatBroker, p: ParsedArgs): number {
  const room = need(resolveRoom(p), 'room (--room or CHAT_ROOM)');
  const id = need(resolveId(p), 'id (--id or CHAT_ID)');
  const role = need(resolveRole(p), 'role (--role or CHAT_ROLE)');
  const member = broker.join({
    room,
    id,
    role,
    displayName: flagStr(p, 'name', 'display', 'displayName'),
    runtime: resolveRuntime(p),
    bio: flagStr(p, 'bio'),
  });
  if (flagBool(p, 'json')) {
    printJson(member);
  } else {
    process.stdout.write(
      `joined room ${JSON.stringify(room)} as ${member.id} (${member.role})` +
        (member.runtime ? ` [${member.runtime}]` : '') +
        '\n',
    );
  }
  return 0;
}

function cmdSend(broker: ChatBroker, p: ParsedArgs): number {
  const room = need(resolveRoom(p), 'room (--room or CHAT_ROOM)');
  const from = need(
    flagStr(p, 'from') ?? resolveId(p),
    'sender (--from, --id, or CHAT_ID)',
  );
  // Body: --message wins; else join the positional rest.
  const flagMsg = flagStr(p, 'message', 'msg', 'm');
  const positional = p.positionals.join(' ').trim();
  const content = (flagMsg ?? positional).trim();
  if (!content) {
    throw new UsageError(
      'missing message body (use --message "..." or pass it positionally)',
    );
  }
  const msg = broker.send({
    room,
    from,
    content,
    shortContent: flagStr(p, 'short', 'shortContent'),
    type: parseType(flagStr(p, 'type', 't')),
    priority: parsePriority(flagStr(p, 'priority', 'prio')),
    mentions: parseMentions(flagStr(p, 'to', 'mentions')),
    fromDisplayName: flagStr(p, 'name', 'display', 'displayName'),
  });
  if (flagBool(p, 'json')) {
    printJson(msg);
  } else {
    process.stdout.write(`sent ${msg.id}\n`);
  }
  return 0;
}

function cmdPoll(broker: ChatBroker, p: ParsedArgs): number {
  const room = need(resolveRoom(p), 'room (--room or CHAT_ROOM)');
  const id = need(resolveId(p), 'id (--id or CHAT_ID)');
  const mentionsOnly = flagBool(p, 'mentions', 'mentionsOnly');
  const peek = flagBool(p, 'peek');
  const limit = flagStr(p, 'limit') !== undefined ? flagNum(p, 100, 'limit') : undefined;
  const result = broker.poll(room, id, {
    mentionsOnly,
    advance: !peek,
    limit,
  });
  if (flagBool(p, 'json')) {
    printJson(result);
  } else {
    printMessages(result.messages, id);
  }
  return 0;
}

async function cmdWait(broker: ChatBroker, p: ParsedArgs): Promise<number> {
  const room = need(resolveRoom(p), 'room (--room or CHAT_ROOM)');
  const id = need(resolveId(p), 'id (--id or CHAT_ID)');
  const mentionsOnly = flagBool(p, 'mentions', 'mentionsOnly');
  const json = flagBool(p, 'json');
  const timeoutS = flagNum(p, 60, 'timeout');
  const intervalS = flagNum(p, 2, 'interval');
  const intervalMs = Math.max(50, intervalS * 1000);
  const deadline = Date.now() + timeoutS * 1000;

  // Poll loop: advance the cursor each time so a hit is consumed exactly once.
  for (;;) {
    const result = broker.poll(room, id, { mentionsOnly, advance: true });
    if (result.messages.length > 0) {
      if (json) printJson(result);
      else printMessages(result.messages, id);
      return 0;
    }
    if (Date.now() >= deadline) {
      if (json) printJson({ messages: [], cursor: result.cursor });
      // human mode: print nothing on timeout.
      return 2;
    }
    // Don't overshoot the deadline waiting.
    const remaining = deadline - Date.now();
    await sleep(Math.min(intervalMs, Math.max(50, remaining)));
  }
}

async function cmdWatch(broker: ChatBroker, p: ParsedArgs): Promise<number> {
  const room = need(resolveRoom(p), 'room (--room or CHAT_ROOM)');
  const id = need(resolveId(p), 'id (--id or CHAT_ID)');
  const mentionsOnly = flagBool(p, 'mentions', 'mentionsOnly');
  const json = flagBool(p, 'json');
  const intervalS = flagNum(p, 2, 'interval');
  const intervalMs = Math.max(50, intervalS * 1000);

  // Long-running tail: loop forever until the process is killed (Ctrl-C).
  for (;;) {
    const result = broker.poll(room, id, { mentionsOnly, advance: true });
    if (result.messages.length > 0) {
      if (json) {
        for (const m of result.messages) printJson(m);
      } else {
        printMessages(result.messages, id);
      }
    }
    await sleep(intervalMs);
  }
}

function cmdRoster(broker: ChatBroker, p: ParsedArgs): number {
  const room = need(resolveRoom(p), 'room (--room or CHAT_ROOM)');
  const entries: RosterEntry[] = broker.roster(room);
  if (flagBool(p, 'json')) {
    printJson(entries);
    return 0;
  }
  if (entries.length === 0) {
    process.stdout.write(`(no members in room ${JSON.stringify(room)})\n`);
    return 0;
  }
  const now = Date.now();
  for (const e of entries) {
    const rt = e.runtime ? e.runtime : '-';
    const name = e.displayName ? ` "${e.displayName}"` : '';
    process.stdout.write(
      `${e.id}${name} (${e.role}) [${rt}] ${e.presence} · seen ${ageStr(e.lastSeen, now)} ago\n`,
    );
  }
  return 0;
}

function cmdHistory(broker: ChatBroker, p: ParsedArgs): number {
  const room = need(resolveRoom(p), 'room (--room or CHAT_ROOM)');
  const limit = flagNum(p, 30, 'limit');
  const messages = broker.history(room, { limit });
  if (flagBool(p, 'json')) {
    printJson(messages);
  } else {
    // viewer = caller id if resolvable, so @you still highlights in history.
    printMessages(messages, resolveId(p));
  }
  return 0;
}

function cmdRooms(broker: ChatBroker, p: ParsedArgs): number {
  const rooms = broker.listRooms();
  if (flagBool(p, 'json')) {
    printJson(rooms);
  } else {
    for (const r of rooms) process.stdout.write(r + '\n');
  }
  return 0;
}

function cmdLeave(broker: ChatBroker, p: ParsedArgs): number {
  const room = need(resolveRoom(p), 'room (--room or CHAT_ROOM)');
  const id = need(resolveId(p), 'id (--id or CHAT_ID)');
  broker.leave(room, id);
  if (flagBool(p, 'json')) {
    printJson({ left: true, room, id });
  } else {
    process.stdout.write(`left room ${JSON.stringify(room)} (${id})\n`);
  }
  return 0;
}

// ── dispatcher ───────────────────────────────────────────────────────────────

/** Flags that never consume a following token (treated as booleans). */
const BOOLEAN_FLAGS = new Set([
  'json',
  'mentions',
  'mentionsOnly',
  'peek',
  'help',
]);

async function dispatch(argv: string[]): Promise<number> {
  const command = argv[2];

  if (
    command === undefined ||
    command === 'help' ||
    command === '--help' ||
    command === '-h'
  ) {
    printUsage(false);
    return 0;
  }

  const rest = argv.slice(3);
  const p = parseArgs(rest, BOOLEAN_FLAGS);

  // Global --help on any subcommand short-circuits to usage.
  if (flagBool(p, 'help')) {
    printUsage(false);
    return 0;
  }

  const broker = new ChatBroker(); // honors CHAT_HOME automatically

  switch (command) {
    case 'join':
      return cmdJoin(broker, p);
    case 'send':
    case 'say':
      return cmdSend(broker, p);
    case 'poll':
      return cmdPoll(broker, p);
    case 'wait':
      return cmdWait(broker, p);
    case 'watch':
    case 'tail':
      return cmdWatch(broker, p);
    case 'roster':
    case 'who':
      return cmdRoster(broker, p);
    case 'history':
    case 'log':
      return cmdHistory(broker, p);
    case 'rooms':
      return cmdRooms(broker, p);
    case 'leave':
      return cmdLeave(broker, p);
    default:
      throw new UsageError(`unknown command ${JSON.stringify(command)}`);
  }
}

// ── entry ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  try {
    const code = await dispatch(process.argv);
    process.exitCode = code;
  } catch (err) {
    const message =
      err instanceof Error ? err.message : String(err);
    process.stderr.write(`error: ${message}\n\n`);
    if (err instanceof UsageError) {
      printUsage(true);
    }
    // UsageError + core validation errors (bad ids, bad type, etc.) => exit 1.
    process.exitCode = 1;
  }
}

void main();
