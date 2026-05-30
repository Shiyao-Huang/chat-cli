/**
 * scripts/e2e.ts — empirical proof of "any runtime".
 *
 * This script spawns the chat CLI as *separate OS processes* that share ONLY
 * the filesystem (a temp CHAT_HOME). Two independent processes — "alice" and
 * "bob" — hold a real conversation through the local file broker. No cloud, no
 * daemon, no shared memory: just files. If two `spawnSync` processes can page
 * each other, then so can a Claude Code agent, a Codex agent, and a bash loop.
 *
 * Each `runCli(...)` call is a brand-new `npx tsx src/cli.ts ...` process. We
 * run against the SOURCE (via tsx) so this works pre-build; if `dist/cli.js`
 * exists the bin shim would also work, but tsx keeps it build-independent.
 *
 * Run:  npx tsx scripts/e2e.ts   (or `npm run e2e`)
 * On success prints a final line `E2E_OK` and exits 0.
 * On any failed assertion prints `FAIL: ...`, then exits 1.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Project root = parent of this scripts/ dir. Resolved from the module URL so
// the script is cwd-independent.
const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Fresh, isolated broker home for this run. The ONLY thing the two processes
// share. Cleaned up at the end.
const CHAT_HOME = mkdtempSync(join(tmpdir(), 'chat-cli-e2e-'));
const ROOM = 'e2e-room';

let failures = 0;

function pass(label: string): void {
  console.log(`PASS: ${label}`);
}

function fail(label: string, detail?: unknown): void {
  failures++;
  console.error(`FAIL: ${label}`);
  if (detail !== undefined) {
    console.error('      ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)));
  }
}

function assert(cond: unknown, label: string, detail?: unknown): void {
  if (cond) pass(label);
  else fail(label, detail);
}

/**
 * Run the CLI in a *separate process*. Returns parsed JSON (the CLI is invoked
 * with --json) plus the raw streams for diagnostics.
 *
 * We tolerate banners/log lines on stdout by scanning for the JSON payload
 * rather than assuming stdout is pure JSON.
 */
function runCli(args: string[]): { ok: boolean; json: any; stdout: string; stderr: string; status: number | null } {
  const res = spawnSync('npx', ['tsx', 'src/cli.ts', ...args, '--json'], {
    cwd: PROJECT_ROOT,
    env: { ...process.env, CHAT_HOME }, // shared rendezvous; everything else inherited
    encoding: 'utf8',
    timeout: 60_000,
  });
  const stdout = res.stdout ?? '';
  const stderr = res.stderr ?? '';
  const json = extractJson(stdout);
  return { ok: res.status === 0, json, stdout, stderr, status: res.status };
}

/** Best-effort extract of a JSON value from CLI stdout (object or array). */
function extractJson(text: string): any {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  // Fast path: the whole thing is JSON.
  try {
    return JSON.parse(trimmed);
  } catch {
    /* fall through to line/brace scan */
  }
  // Try the last non-empty line (CLIs often print the JSON result last).
  const lines = trimmed.split('\n').map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(lines[i]);
    } catch {
      /* keep scanning */
    }
  }
  // Last resort: grab the outermost {...} or [...] span.
  const start = trimmed.search(/[[{]/);
  const end = Math.max(trimmed.lastIndexOf('}'), trimmed.lastIndexOf(']'));
  if (start !== -1 && end > start) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      /* give up */
    }
  }
  return undefined;
}

/** Normalize a poll result into an array of messages regardless of shape. */
function messagesOf(json: any): any[] {
  if (!json) return [];
  if (Array.isArray(json)) return json;
  if (Array.isArray(json.messages)) return json.messages;
  if (json.result && Array.isArray(json.result.messages)) return json.result.messages;
  return [];
}

/** Normalize a roster result into an array of entries regardless of shape. */
function rosterOf(json: any): any[] {
  if (!json) return [];
  if (Array.isArray(json)) return json;
  if (Array.isArray(json.roster)) return json.roster;
  if (Array.isArray(json.members)) return json.members;
  return [];
}

function contentOf(msg: any): string {
  return String(msg?.content ?? msg?.shortContent ?? '');
}

function fromOf(msg: any): string {
  return String(msg?.from ?? '');
}

function cleanup(): void {
  try {
    rmSync(CHAT_HOME, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

console.log('=== chat-cli E2E: two separate OS processes, shared only by filesystem ===');
console.log(`CHAT_HOME = ${CHAT_HOME}`);
console.log(`ROOM      = ${ROOM}`);
console.log('');

try {
  // ── 1. Two distinct processes join the same room ────────────────────────────
  const aliceJoin = runCli(['join', '--room', ROOM, '--id', 'alice', '--role', 'architect']);
  assert(aliceJoin.ok, 'alice (process #1) joined', aliceJoin.stderr || aliceJoin.stdout);

  const bobJoin = runCli(['join', '--room', ROOM, '--id', 'bob', '--role', 'tester']);
  assert(bobJoin.ok, 'bob (process #2) joined', bobJoin.stderr || bobJoin.stdout);

  // ── 2. alice broadcasts, then pages @bob directly ───────────────────────────
  const bcast = runCli(['send', '--room', ROOM, '--from', 'alice', '--message', 'hello room, standup in 5']);
  assert(bcast.ok, 'alice sent a broadcast', bcast.stderr || bcast.stdout);

  const page = runCli(['send', '--room', ROOM, '--from', 'alice', '--to', 'bob', '--message', 'bob, please run the suite']);
  assert(page.ok, 'alice paged @bob', page.stderr || page.stdout);

  // ── 3. bob polls and must receive BOTH messages ─────────────────────────────
  const bobPoll = runCli(['poll', '--room', ROOM, '--id', 'bob']);
  assert(bobPoll.ok, 'bob polled his inbox', bobPoll.stderr || bobPoll.stdout);
  const bobMsgs = messagesOf(bobPoll.json);

  const gotBroadcast = bobMsgs.some((m) => contentOf(m).includes('standup in 5'));
  const gotPage = bobMsgs.some((m) => contentOf(m).includes('run the suite'));
  assert(gotBroadcast, 'bob received the broadcast', bobMsgs);
  assert(gotPage, 'bob received the @bob page', bobMsgs);
  assert(
    bobMsgs.every((m) => fromOf(m) !== 'bob'),
    'poll excludes the caller\'s own messages',
    bobMsgs,
  );

  // ── 4. bob replies @alice ───────────────────────────────────────────────────
  const reply = runCli(['send', '--room', ROOM, '--from', 'bob', '--to', 'alice', '--message', 'alice, suite is green ✅']);
  assert(reply.ok, 'bob replied @alice', reply.stderr || reply.stdout);

  // ── 5. alice polls mentions-only and must see bob's reply ───────────────────
  const alicePoll = runCli(['poll', '--room', ROOM, '--id', 'alice', '--mentions']);
  assert(alicePoll.ok, 'alice polled (mentions-only)', alicePoll.stderr || alicePoll.stdout);
  const aliceMsgs = messagesOf(alicePoll.json);
  const gotReply = aliceMsgs.some((m) => fromOf(m) === 'bob' && contentOf(m).includes('suite is green'));
  assert(gotReply, 'alice received bob\'s @alice reply', aliceMsgs);

  // ── 6. roster shows 2 alive members ─────────────────────────────────────────
  const ros = runCli(['roster', '--room', ROOM]);
  assert(ros.ok, 'roster fetched', ros.stderr || ros.stdout);
  const entries = rosterOf(ros.json);
  const ids = new Set(entries.map((e) => String(e.id)));
  const aliveCount = entries.filter((e) => String(e.presence) === 'alive').length;
  assert(ids.has('alice') && ids.has('bob'), 'roster contains both members', entries);
  assert(aliveCount >= 2, 'roster shows 2 alive members', entries);
} catch (err) {
  fail('unexpected exception during E2E', err instanceof Error ? err.stack : String(err));
} finally {
  cleanup();
}

console.log('');
if (failures > 0) {
  console.error(`E2E FAILED with ${failures} failed assertion(s).`);
  process.exit(1);
}
console.log('All assertions passed. Two separate processes held a real conversation over the file broker.');
console.log('E2E_OK');
process.exit(0);
