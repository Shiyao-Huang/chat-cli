/**
 * boardroom — an "AI 经营外脑" (management exo-brain) built entirely on chat-cli.
 *
 * CROSS-PLATFORM by design (Mac / Linux / Windows): no bash, no tmux. Each thinker's
 * "brain" is a live `claude` process spawned via Node child_process; a topic is
 * "injected" by writing to that process's stdin. The same mechanism works on every OS.
 *
 * Mental model — everything is just folders + a chat room (no Mem0/RAGFlow/Dify):
 *
 *   $BOARD_HOME/                     (default: ~/.chat-cli/boardroom)
 *     personas/<id>/CLAUDE.md        a thinker's PERSONA (claude auto-loads it as character)
 *     personas/<id>/corpus/*.md      that thinker's MEMORY (views / methods / interviews)
 *     mem/                           YOUR long-term memory & judgment preferences
 *     kb/company/  kb/external/       the fact layer (meeting docs, business progress, outside material)
 *
 *   The chat room "boardroom" (chat-cli broker under $CHAT_HOME) is the live meeting.
 *   convene -> spawn one live claude per persona (cwd = its folder, joined as that member).
 *   ask "<topic>" -> write the topic to every persona process's stdin.
 *   each persona thinks in ITS framework, consults ./corpus, runs `chat send` into the room.
 *   you -> `boardroom watch` to see every framework's input stream in.
 *
 * A daemon (the spawned processes) must outlive a single CLI call, so `convene` detaches
 * a small supervisor that owns the child processes and listens on a control pipe for
 * inject/adjourn commands. State lives in $BOARD_HOME/.runtime/.
 */

import {
  mkdirSync,
  existsSync,
  cpSync,
  copyFileSync,
  appendFileSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  statSync,
  rmSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import net from 'node:net';
import { openSync } from 'node:fs';

// ── Config from env ──────────────────────────────────────────────────────────
const BOARD_HOME = process.env.BOARD_HOME || join(homedir(), '.chat-cli', 'boardroom');
const ROOM = process.env.BOARD_ROOM || 'boardroom';
const PRINCIPAL = process.env.BOARD_PRINCIPAL || 'you';
const CHAT_HOME = process.env.CHAT_HOME || join(homedir(), '.chat-cli', 'rooms');
const MODEL = process.env.BOARD_MODEL || '';
const CLAUDE_BIN = process.env.BOARD_CLAUDE_BIN || 'claude';

const RUNTIME_DIR = join(BOARD_HOME, '.runtime');
const SOCK_PATH =
  process.platform === 'win32'
    ? '\\\\.\\pipe\\boardroom-' + Buffer.from(BOARD_HOME).toString('hex').slice(0, 16)
    : join(RUNTIME_DIR, 'control.sock');
const PID_PATH = join(RUNTIME_DIR, 'supervisor.pid');
const LOG_PATH = join(RUNTIME_DIR, 'supervisor.log');

const HERE = dirname(fileURLToPath(import.meta.url));
// dist/boardroom/boardroom.js -> repo root is two up; templates ship alongside.
const REPO_ROOT = join(HERE, '..', '..');
const TEMPLATE_DIR = join(REPO_ROOT, 'templates', 'personas');

function ensureLayers(): void {
  for (const d of [
    join(BOARD_HOME, 'personas'),
    join(BOARD_HOME, 'mem'),
    join(BOARD_HOME, 'kb', 'company'),
    join(BOARD_HOME, 'kb', 'external'),
    RUNTIME_DIR,
  ]) {
    if (!existsSync(d)) mkdirSync(d, { recursive: true });
  }
}

function personaDir(id: string): string {
  return join(BOARD_HOME, 'personas', id);
}

function listPersonas(): string[] {
  const dir = join(BOARD_HOME, 'personas');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => {
      try {
        return statSync(join(dir, n)).isDirectory();
      } catch {
        return false;
      }
    })
    .sort();
}

function die(msg: string): never {
  process.stderr.write(`boardroom: ${msg}\n`);
  process.exit(1);
}

// ── persona scaffolding ──────────────────────────────────────────────────────

function defaultClaudeMd(id: string, name: string): string {
  return `# ${name}

You are **${name}**. Think in your own distinctive framework. Read ./corpus/ before answering.

## Boardroom protocol
You are a live participant in a chat-cli boardroom. Your member id is "${id}"; the room is "${ROOM}";
the principal is "${PRINCIPAL}". When a topic is injected into your terminal:
  1. Think strictly through YOUR framework.
  2. Consult ./corpus/ for grounding.
  3. Reply with ONE highest-leverage point + ONE falsifiable judgment, in character, by running:
       chat send --room ${ROOM} --from ${id} --to ${PRINCIPAL} --type notification "<your input>"
  4. To challenge another member: --to ${PRINCIPAL},<otherId>. See others: chat history --room ${ROOM} --limit 15
Stay in character. Your value is the DISTINCTNESS of your framework, not consensus.
`;
}

function cmdInit(): void {
  ensureLayers();
  process.stdout.write(`init: BOARD_HOME=${BOARD_HOME}\n`);
  if (existsSync(TEMPLATE_DIR)) {
    let n = 0;
    for (const id of readdirSync(TEMPLATE_DIR)) {
      const src = join(TEMPLATE_DIR, id);
      if (!statSync(src).isDirectory()) continue;
      const dst = personaDir(id);
      mkdirSync(join(dst, 'corpus'), { recursive: true });
      cpSync(src, dst, { recursive: true });
      process.stdout.write(`  imported persona: ${id}\n`);
      n++;
    }
    process.stdout.write(`init: imported ${n} persona template(s).\n`);
  } else {
    process.stdout.write(`init: no templates at ${TEMPLATE_DIR} (add: boardroom add <id>).\n`);
  }
  process.stdout.write(`init: layers ready -> mem/, kb/company/, kb/external/\n`);
}

function cmdAdd(args: string[]): void {
  const id = args[0] || die('usage: boardroom add <id> [name]');
  const name = args[1] || id;
  ensureLayers();
  const dir = personaDir(id);
  mkdirSync(join(dir, 'corpus'), { recursive: true });
  const md = join(dir, 'CLAUDE.md');
  if (!existsSync(md)) writeFileSync(md, defaultClaudeMd(id, name), 'utf8');
  process.stdout.write(`persona '${id}' ready at ${dir} (fill corpus/ with material).\n`);
}

function cmdSeed(args: string[]): void {
  const id = args[0] || die('usage: boardroom seed <id> <file>');
  const file = args[1] || die('need a file');
  if (!existsSync(file)) die(`no such file: ${file}`);
  const dir = personaDir(id);
  if (!existsSync(dir)) die(`unknown persona: ${id} (boardroom add ${id} first)`);
  mkdirSync(join(dir, 'corpus'), { recursive: true });
  copyFileSync(file, join(dir, 'corpus', basename(file)));
  process.stdout.write(`seeded ${id} corpus with ${basename(file)}\n`);
}

function cmdRemember(args: string[]): void {
  const text = args.join(' ').trim();
  if (!text) die('usage: boardroom remember <text>');
  ensureLayers();
  const f = join(BOARD_HOME, 'mem', 'notes.md');
  appendFileSync(f, `\n- ${text}\n`, 'utf8');
  process.stdout.write(`remembered -> ${f}\n`);
}

function cmdDoc(args: string[]): void {
  const file = args[0] || die('usage: boardroom doc <file> [company|external]');
  const kind = args[1] || 'company';
  if (!existsSync(file)) die(`no such file: ${file}`);
  if (kind !== 'company' && kind !== 'external') die("kind must be 'company' or 'external'");
  ensureLayers();
  copyFileSync(file, join(BOARD_HOME, 'kb', kind, basename(file)));
  process.stdout.write(`imported ${basename(file)} -> kb/${kind}/\n`);
}

// ── chat helpers (shell out to the installed `chat` CLI) ──────────────────────

function chat(args: string[], opts: { capture?: boolean } = {}): string {
  const env = { ...process.env, CHAT_HOME };
  const res = spawnSyncSafe('chat', args, env, opts.capture);
  return res;
}

function spawnSyncSafe(cmd: string, args: string[], env: NodeJS.ProcessEnv, capture?: boolean): string {
  try {
    const out = execFileSync(cmd, args, {
      env,
      encoding: 'utf8',
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'inherit', 'inherit'],
      shell: process.platform === 'win32', // resolve .cmd shims on Windows
    });
    return out ? out.toString() : '';
  } catch (e: any) {
    if (capture) return '';
    throw e;
  }
}

function cmdWatch(): void {
  // Long-running tail; replace this process with `chat watch` semantics via inherit.
  chat(['watch', '--room', ROOM, '--id', PRINCIPAL]);
}

function cmdMinutes(args: string[]): void {
  const n = args[0] || '40';
  process.stdout.write(chat(['history', '--room', ROOM, '--limit', n], { capture: true }));
}

function cmdDigest(args: string[]): void {
  const n = args[0] || '60';
  ensureLayers();
  const f = join(BOARD_HOME, 'mem', 'minutes.md');
  const body = chat(['history', '--room', ROOM, '--limit', n], { capture: true });
  appendFileSync(f, `\n## Boardroom session digest\n${body}\n`, 'utf8');
  process.stdout.write(`digest appended -> ${f}\n`);
}

// ── supervisor (daemon) — owns the live persona processes ─────────────────────

interface Child {
  id: string;
  proc: import('node:child_process').ChildProcess;
}

function runSupervisor(ids: string[]): void {
  ensureLayers();
  const log = (m: string) => appendFileSync(LOG_PATH, `[${new Date().toISOString()}] ${m}\n`, 'utf8');
  writeFileSync(PID_PATH, String(process.pid), 'utf8');
  const children: Child[] = [];

  for (const id of ids) {
    const dir = personaDir(id);
    if (!existsSync(dir)) {
      log(`skip ${id}: no folder`);
      continue;
    }
    // Pre-join the room so the roster shows the member even before first reply.
    spawnSyncSafe('chat', ['join', '--room', ROOM, '--id', id, '--role', id], { ...process.env, CHAT_HOME }, true);
    const claudeArgs = MODEL ? ['--model', MODEL] : [];
    const proc = spawn(CLAUDE_BIN, claudeArgs, {
      cwd: dir,
      env: { ...process.env, CHAT_HOME },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    });
    proc.stdout.on('data', (d) => log(`[${id}] ${d.toString().trim()}`));
    proc.stderr.on('data', (d) => log(`[${id}!] ${d.toString().trim()}`));
    proc.on('exit', (code) => log(`[${id}] exited code=${code}`));
    children.push({ id, proc });
    log(`spawned ${id} (pid ${proc.pid})`);
  }

  const inject = (id: string, text: string): boolean => {
    const c = children.find((x) => x.id === id);
    if (!c || !c.proc.stdin || c.proc.exitCode !== null) return false;
    c.proc.stdin.write(text.endsWith('\n') ? text : text + '\n');
    return true;
  };

  const server = net.createServer((sock) => {
    let buf = '';
    sock.on('data', (d) => {
      buf += d.toString();
      let idx: number;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (!line.trim()) continue;
        let msg: any;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.cmd === 'inject') {
          const targets = msg.id === '*' ? children.map((c) => c.id) : [msg.id];
          const done = targets.map((t: string) => ({ id: t, ok: inject(t, msg.text) }));
          sock.write(JSON.stringify({ ok: true, done }) + '\n');
        } else if (msg.cmd === 'list') {
          sock.write(JSON.stringify({ ok: true, ids: children.map((c) => c.id) }) + '\n');
        } else if (msg.cmd === 'adjourn') {
          sock.write(JSON.stringify({ ok: true }) + '\n');
          shutdown();
        } else {
          sock.write(JSON.stringify({ ok: false, error: 'unknown cmd' }) + '\n');
        }
      }
    });
  });

  function shutdown(): void {
    log('adjourning');
    for (const c of children) {
      try {
        c.proc.stdin?.end();
        c.proc.kill();
      } catch {
        /* ignore */
      }
      try {
        spawnSyncSafe('chat', ['leave', '--room', ROOM, '--id', c.id], { ...process.env, CHAT_HOME }, true);
      } catch {
        /* ignore */
      }
    }
    try {
      server.close();
    } catch {
      /* ignore */
    }
    for (const p of [PID_PATH, process.platform === 'win32' ? '' : SOCK_PATH].filter(Boolean)) {
      try {
        rmSync(p);
      } catch {
        /* ignore */
      }
    }
    process.exit(0);
  }

  if (process.platform !== 'win32' && existsSync(SOCK_PATH)) {
    try {
      rmSync(SOCK_PATH);
    } catch {
      /* ignore */
    }
  }
  server.listen(SOCK_PATH, () => log(`supervisor listening on ${SOCK_PATH} with ${children.length} personas`));
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

// ── control client (CLI -> supervisor over the pipe) ──────────────────────────

function controlSend(msg: object, timeoutMs = 4000): Promise<any> {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(SOCK_PATH);
    let buf = '';
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error('control timeout (is the boardroom convened?)'));
    }, timeoutMs);
    sock.on('connect', () => sock.write(JSON.stringify(msg) + '\n'));
    sock.on('data', (d) => {
      buf += d.toString();
      const idx = buf.indexOf('\n');
      if (idx >= 0) {
        clearTimeout(timer);
        try {
          resolve(JSON.parse(buf.slice(0, idx)));
        } catch (e) {
          reject(e as Error);
        }
        sock.end();
      }
    });
    sock.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

function supervisorAlive(): boolean {
  if (!existsSync(PID_PATH)) return false;
  const pid = Number(readFileSync(PID_PATH, 'utf8').trim());
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function cmdConvene(args: string[]): void {
  ensureLayers();
  const ids = args.length ? args : listPersonas();
  if (!ids.length) die('no personas (run: boardroom init, or boardroom add <id>)');
  if (supervisorAlive()) {
    process.stdout.write(`convene: already in session. (boardroom adjourn to reset)\n`);
    return;
  }
  // Spawn a DETACHED supervisor running this same script with the hidden __supervise verb.
  const selfArgs = [process.argv[1], '__supervise', ...ids];
  const out = openSync(LOG_PATH, 'a');
  const sup = spawn(process.execPath, selfArgs, {
    detached: true,
    stdio: ['ignore', out, out],
    env: process.env,
  });
  sup.unref();
  process.stdout.write(`convened ${ids.length} thinker(s): ${ids.join(', ')}\n`);
  process.stdout.write(`Live claude sessions are booting. In a few seconds:\n`);
  process.stdout.write(`  boardroom ask "<your topic>"   # inject a topic to every thinker\n`);
  process.stdout.write(`  boardroom watch                # see their inputs stream into the room\n`);
}

async function cmdAsk(args: string[]): Promise<void> {
  const topic = args.join(' ').trim();
  if (!topic) die('usage: boardroom ask "<topic>"');
  if (!supervisorAlive()) die('no session — run: boardroom convene');
  // Record the principal's question into the room so minutes are complete.
  chat(['send', '--room', ROOM, '--from', PRINCIPAL, '--message', `议题: ${topic}`], { capture: true });
  const prompt =
    `[BOARDROOM 议题] ${topic}\n` +
    `请只用你自己的框架思考，参考 ./corpus/，给出一条最高杠杆输入 + 一个可证伪判断，` +
    `然后运行：chat send --room ${ROOM} --from <你的id> --to ${PRINCIPAL} --type notification "..."`;
  const res = await controlSend({ cmd: 'inject', id: '*', text: prompt });
  const oks = (res.done || []).filter((d: any) => d.ok).map((d: any) => d.id);
  process.stdout.write(`asked: ${oks.join(', ') || '(none)'}\n`);
  process.stdout.write(`Watch replies:  boardroom watch\n`);
}

async function cmdAskOne(args: string[]): Promise<void> {
  const id = args[0] || die('usage: boardroom ask-one <id> "<topic>"');
  const topic = args.slice(1).join(' ').trim();
  if (!topic) die('need a topic');
  if (!supervisorAlive()) die('no session — run: boardroom convene');
  const prompt =
    `[BOARDROOM 议题] ${topic}\n` +
    `只用你的框架，参考 ./corpus/，给一条最高杠杆输入 + 一个可证伪判断，` +
    `然后运行：chat send --room ${ROOM} --from ${id} --to ${PRINCIPAL} --type notification "..."`;
  const res = await controlSend({ cmd: 'inject', id, text: prompt });
  const ok = (res.done || []).some((d: any) => d.ok);
  process.stdout.write(ok ? `asked ${id}. Watch: boardroom watch\n` : `failed to reach ${id} (is it live?)\n`);
}

async function cmdAdjourn(): Promise<void> {
  if (!supervisorAlive()) {
    process.stdout.write('no active session.\n');
    return;
  }
  try {
    await controlSend({ cmd: 'adjourn' });
  } catch {
    /* supervisor may exit before replying */
  }
  process.stdout.write('adjourned (folders persist).\n');
}

async function cmdStatus(): Promise<void> {
  const alive = supervisorAlive();
  process.stdout.write(`session: ${alive ? 'in session' : 'idle'}\n`);
  process.stdout.write(`personas (folders): ${listPersonas().join(', ') || '(none)'}\n`);
  if (alive) {
    try {
      const res = await controlSend({ cmd: 'list' });
      process.stdout.write(`live thinkers: ${(res.ids || []).join(', ')}\n`);
    } catch {
      /* ignore */
    }
  }
}

function usage(): void {
  process.stdout.write(`boardroom — AI 经营外脑 on chat-cli (cross-platform: Mac/Linux/Windows)

Setup / roster (everything is just folders):
  boardroom init                    Scaffold $BOARD_HOME and import persona templates.
  boardroom add <id> [name]         Create an empty persona folder (CLAUDE.md + corpus/).
  boardroom seed <id> <file>        Append a file into persona <id>'s corpus.
  boardroom list                    List personas (folders).

Your layers (also folders):
  boardroom remember <text>         Append a note to YOUR long-term memory (mem/).
  boardroom doc <file> [company|external]   Import a doc into the fact layer (kb/).

Run the board (each persona = a live claude process; topic injected via stdin):
  boardroom convene [ids...]        Spawn one live persona process per id (default: all).
  boardroom ask "<topic>"           Inject a topic into every live persona; they reply into the room.
  boardroom ask-one <id> "<topic>"  Ask a single thinker.
  boardroom watch                   Tail the boardroom room live.
  boardroom minutes [N]             Print the last N messages as meeting minutes.
  boardroom digest                  Append the current minutes into YOUR memory (mem/).
  boardroom status                  Show session + live thinkers.
  boardroom adjourn                 Stop all persona processes (folders persist).

Env: BOARD_HOME, BOARD_ROOM, BOARD_PRINCIPAL, BOARD_MODEL, BOARD_CLAUDE_BIN, CHAT_HOME.
`);
}

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  switch (cmd) {
    case '__supervise':
      return runSupervisor(args);
    case 'init':
      return cmdInit();
    case 'add':
      return cmdAdd(args);
    case 'seed':
      return cmdSeed(args);
    case 'list':
      process.stdout.write(listPersonas().join('\n') + '\n');
      return;
    case 'remember':
      return cmdRemember(args);
    case 'doc':
      return cmdDoc(args);
    case 'convene':
      return cmdConvene(args);
    case 'ask':
      return cmdAsk(args);
    case 'ask-one':
      return cmdAskOne(args);
    case 'watch':
      return cmdWatch();
    case 'minutes':
      return cmdMinutes(args);
    case 'digest':
      return cmdDigest(args);
    case 'status':
      return cmdStatus();
    case 'adjourn':
      return cmdAdjourn();
    case 'help':
    case '-h':
    case '--help':
    case undefined:
      return usage();
    default:
      usage();
      process.exit(1);
  }
}

main().catch((e) => {
  process.stderr.write(`boardroom: ${e?.message || String(e)}\n`);
  process.exit(1);
});
