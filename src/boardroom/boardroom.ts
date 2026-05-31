/**
 * boardroom — an "AI 经营外脑" (management exo-brain) built entirely on chat-cli.
 *
 * Each thinker's "brain" is a LIVE interactive `claude` session. The carrier is
 * tmux: every persona runs in its own tmux window (which gives claude a real PTY),
 * and a topic is "injected" with `tmux send-keys`. This reuses the mechanism proven
 * in happy-cli (spawnInTmux + send-keys), reimplemented here as a thin, dependency-
 * free wrapper over the tmux CLI. (No `claude -p`: these are real interactive sessions.)
 *
 * tmux is Mac/Linux. On Windows, use it under WSL (a Windows-native carrier can be
 * added later); `convene` detects a missing tmux and says so.
 *
 * Mental model — everything is just folders + a chat room (no Mem0/RAGFlow/Dify):
 *
 *   $BOARD_HOME/                     (default: ~/.chat-cli/boardroom)
 *     personas/<id>/CLAUDE.md        a thinker's PERSONA (claude auto-loads it as character)
 *     personas/<id>/corpus/*.md      that thinker's MEMORY (views / methods / interviews)
 *     mem/                           YOUR long-term memory & judgment preferences
 *     kb/company/  kb/external/       the fact layer (meeting docs, business progress)
 *
 *   The chat room "boardroom" (chat-cli broker under $CHAT_HOME) is the live meeting.
 *   convene -> one tmux window per persona, each running `claude` in its folder, joined as that member.
 *   ask "<topic>" -> tmux send-keys the topic into every persona window.
 *   each persona thinks in ITS framework, consults ./corpus, runs `chat send` into the room.
 *   you -> `boardroom watch` to see every framework's input stream in.
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
  renameSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';

// ── Config from env ──────────────────────────────────────────────────────────
const BOARD_HOME = process.env.BOARD_HOME || join(homedir(), '.chat-cli', 'boardroom');
const ROOM = process.env.BOARD_ROOM || 'boardroom';
const PRINCIPAL = process.env.BOARD_PRINCIPAL || 'you';
const CHAT_HOME = process.env.CHAT_HOME || join(homedir(), '.chat-cli', 'rooms');
const MODEL = process.env.BOARD_MODEL || '';
const CLAUDE_BIN = process.env.BOARD_CLAUDE_BIN || 'claude';
const CODEX_BIN = process.env.BOARD_CODEX_BIN || 'codex';
// Default runtime for personas that don't pin one ("claude" | "codex").
const DEFAULT_RUNTIME = (process.env.BOARD_RUNTIME || 'claude').toLowerCase();
// tmux session that holds one window per persona.
const SESSION = process.env.BOARD_TMUX || 'boardroom';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..');
const TEMPLATE_DIR = join(REPO_ROOT, 'templates', 'personas');

function ensureLayers(): void {
  for (const d of [
    join(BOARD_HOME, 'personas'),
    join(BOARD_HOME, 'mem'),
    join(BOARD_HOME, 'kb', 'company'),
    join(BOARD_HOME, 'kb', 'external'),
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

// ── tmux helpers (thin, dependency-free; command sequence per happy's tmux.ts) ──

function tmux(args: string[], capture = true): { ok: boolean; out: string } {
  const res = spawnSync('tmux', args, { encoding: 'utf8' });
  return { ok: res.status === 0, out: (res.stdout || '') + (res.stderr || '') };
}

function tmuxAvailable(): boolean {
  const res = spawnSync('tmux', ['-V'], { encoding: 'utf8' });
  return res.status === 0;
}

function sessionExists(): boolean {
  return tmux(['has-session', '-t', SESSION]).ok;
}

function windowFor(id: string): string {
  return `${SESSION}:${id}`;
}

function windowExists(id: string): boolean {
  const { ok, out } = tmux(['list-windows', '-t', SESSION, '-F', '#{window_name}']);
  if (!ok) return false;
  return out.split('\n').map((s) => s.trim()).includes(id);
}

// Resolve which agent runtime backs a persona. A persona may pin one by writing
// "claude" or "codex" into <folder>/runtime; otherwise DEFAULT_RUNTIME is used.
function personaRuntime(id: string): 'claude' | 'codex' {
  const f = join(personaDir(id), 'runtime');
  if (existsSync(f)) {
    const v = readFileSync(f, 'utf8').trim().toLowerCase();
    if (v === 'codex') return 'codex';
    if (v === 'claude') return 'claude';
  }
  return DEFAULT_RUNTIME === 'codex' ? 'codex' : 'claude';
}

// Build the shell command a persona window runs: join the room, then exec the agent
// runtime in the persona folder (so it auto-loads CLAUDE.md / AGENTS.md as character),
// launched with full bypass so it boots with ZERO confirmation screens.
function personaCommand(id: string): string {
  const dir = personaDir(id);
  const runtime = personaRuntime(id);
  const join0 =
    `CHAT_HOME=${shq(CHAT_HOME)} chat join --room ${shq(ROOM)} --id ${shq(id)} --role ${shq(id)} --runtime ${shq(runtime)} >/dev/null 2>&1`;
  if (runtime === 'codex') {
    const modelFlag = MODEL ? `--model ${shq(MODEL)} ` : '';
    // codex reads AGENTS.md in cwd; full bypass skips all approval/sandbox prompts.
    return (
      `cd ${shq(dir)} && ${join0}; ` +
      `CHAT_HOME=${shq(CHAT_HOME)} exec ${shq(CODEX_BIN)} ${modelFlag}--dangerously-bypass-approvals-and-sandbox`
    );
  }
  const modelFlag = MODEL ? `--model ${shq(MODEL)} ` : '';
  // claude reads CLAUDE.md in cwd; --dangerously-skip-permissions skips the bypass
  // warning screen, and folders are pre-trusted at init so the trust screen is gone too.
  return (
    `cd ${shq(dir)} && ${join0}; ` +
    `CHAT_HOME=${shq(CHAT_HOME)} exec ${shq(CLAUDE_BIN)} ${modelFlag}--dangerously-skip-permissions`
  );
}

// POSIX single-quote escaping for embedding in the tmux window command.
function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// Pre-trust every persona folder in ~/.claude.json so Claude Code launches with no
// trust dialog. Idempotent and best-effort (never throws). This is what makes
// `convene` a zero-confirmation, unattended launch for claude-backed personas.
function pretrustPersonaFolders(ids: string[]): number {
  const cfgPath = join(homedir(), '.claude.json');
  let cfg: any = {};
  if (existsSync(cfgPath)) {
    try {
      cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
    } catch {
      return 0; // don't clobber an unparseable config
    }
  }
  cfg.projects = cfg.projects || {};
  let n = 0;
  for (const id of ids) {
    const dir = personaDir(id);
    const e = cfg.projects[dir] || {};
    e.hasTrustDialogAccepted = true;
    e.hasCompletedProjectOnboarding = true;
    cfg.projects[dir] = e;
    n++;
  }
  try {
    writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');
  } catch {
    return 0;
  }
  return n;
}

// Pre-trust codex-backed persona folders in ~/.codex/config.toml so Codex launches
// with no "trust this directory?" prompt. Codex records trust as a TOML table:
//   [projects."<abs path>"]
//   trust_level = "trusted"
// Idempotent: skips any folder already present. Best-effort (never throws).
function pretrustCodexFolders(ids: string[]): number {
  const cfgPath = join(homedir(), '.codex', 'config.toml');
  let body = '';
  if (existsSync(cfgPath)) {
    try {
      body = readFileSync(cfgPath, 'utf8');
    } catch {
      return 0;
    }
  }
  let added = 0;
  let append = '';
  for (const id of ids) {
    if (personaRuntime(id) !== 'codex') continue;
    const dir = personaDir(id);
    // Match the exact table header codex writes.
    const header = `[projects."${dir}"]`;
    if (body.includes(header) || append.includes(header)) continue;
    append += `\n${header}\ntrust_level = "trusted"\n`;
    added++;
  }
  if (!append) return 0;
  try {
    writeFileSync(cfgPath, body + append, 'utf8');
  } catch {
    return 0;
  }
  return added;
}

// Pre-trust all personas for their respective runtimes so convene is zero-confirm.
function pretrustAll(ids: string[]): void {
  pretrustPersonaFolders(ids); // claude (~/.claude.json)
  pretrustCodexFolders(ids); // codex (~/.codex/config.toml)
}


// ── persona scaffolding ──────────────────────────────────────────────────────

function defaultClaudeMd(id: string, name: string): string {
  return `# ${name}

You are **${name}**. Think in your own distinctive framework. Read ./corpus/ before answering.

## Boardroom group chat (你在一个多人 AI 群聊里)
You are a live participant in a chat-cli group chat. Your member id is "${id}"; the room is "${ROOM}";
the human principal is "${PRINCIPAL}". Other thinkers are in the room too. It works like a real group chat:
messages from others are pushed into your terminal as lines beginning with **[群消息] <who>: <what>**.

HOW TO SPEAK — when (and only when) the gate below says you may, run:
    chat send --room ${ROOM} --from ${id} --to <recipients> --type notification "<your message>"
  • Talk to the whole room (everyone sees it):   --to all
  • Reply/challenge ONE member point-to-point:   --to <theirId>      (e.g. --to ${PRINCIPAL}, or --to munger)
  • You can address several:  --to ${PRINCIPAL},munger
  Keep it to <=2 sentences, in character, grounded in YOUR framework (cite ./corpus/ when relevant).

## INTENT GATE (硬规则 — 默认沉默)
The meeting is run by the facilitator **master**. You may run \`chat send\` ONLY if at least ONE of these is true;
otherwise run NO command (silence is the correct, expected default):
  (a) FRESH GOAL — a new "[BOARDROOM 议题]" / "议题:" just arrived and you have not yet given your opening take.
  (b) CALLED — you are @mentioned by id, OR the facilitator "master" called on you by name, OR you are directly
      challenged by name.
  (c) NEW, DECISION-CHANGING POINT — you have a point that is (i) genuinely NEW (not a rephrase, agreement, or
      repeat of something already said), (ii) comes from YOUR distinct framework, and (iii) actually CHANGES A
      DECISION or FALSIFIES one of the master's convergence criteria. A merely "interesting new angle" is NOT enough.

FORBIDDEN (treat as a protocol breach — do NOT do these):
  • replying just to add "another angle" that doesn't change a decision;
  • 1:1 @rebuttal ping-pong where you're only defending a point you already made;
  • speaking to agree, restate, or summarize;
  • speaking at all after you see a "#system ADJOURN" message — the meeting is over, fall silent (unless @mentioned).

Prefer \`--to all\` for a genuinely new lens; reserve 1:1 \`--to <id>\` for a direct, decision-changing rebuttal.
When in doubt, STAY SILENT. Your value is the DISTINCTNESS of your framework, not volume or consensus.
You may run \`chat history --room ${ROOM} --limit 15\` to catch up before deciding.

Stay in character. Be terse. Add a decision-changing lens — or say nothing.
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
  // Pre-trust all persona folders (claude + codex) so sessions launch with zero confirmation screens.
  const trusted = pretrustPersonaFolders(listPersonas());
  pretrustCodexFolders(listPersonas());
  if (trusted) process.stdout.write(`init: pre-trusted ${trusted} persona folder(s) for zero-confirm launch.\n`);
  process.stdout.write(`init: layers ready -> mem/, kb/company/, kb/external/\n`);
}

function cmdAdd(args: string[]): void {
  // boardroom add <id> [name] [--runtime claude|codex]
  let runtime = '';
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--runtime') {
      runtime = (args[++i] || '').toLowerCase();
    } else {
      rest.push(args[i]);
    }
  }
  const id = rest[0] || die('usage: boardroom add <id> [name] [--runtime claude|codex]');
  const name = rest[1] || id;
  ensureLayers();
  const dir = personaDir(id);
  mkdirSync(join(dir, 'corpus'), { recursive: true });
  const md = join(dir, 'CLAUDE.md');
  if (!existsSync(md)) writeFileSync(md, defaultClaudeMd(id, name), 'utf8');
  // Dual-runtime: codex reads AGENTS.md. Mirror the persona so a thinker works with either runtime.
  const agentsMd = join(dir, 'AGENTS.md');
  if (!existsSync(agentsMd)) writeFileSync(agentsMd, defaultClaudeMd(id, name), 'utf8');
  if (runtime === 'claude' || runtime === 'codex') {
    writeFileSync(join(dir, 'runtime'), runtime + '\n', 'utf8');
  }
  pretrustAll([id]);
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

// ── chat passthrough (for watch / minutes / digest) ───────────────────────────

function chatCapture(args: string[]): string {
  try {
    return execFileSync('chat', args, {
      env: { ...process.env, CHAT_HOME },
      encoding: 'utf8',
      shell: process.platform === 'win32',
    }).toString();
  } catch {
    return '';
  }
}

function cmdWatch(): void {
  // The Slack-style TUI: live members + message stream + an input box so you can
  // join the discussion yourself. Falls back to a plain tail if not a TTY.
  const sub = process.stdout.isTTY ? 'tui' : 'watch';
  try {
    execFileSync('chat', [sub, '--room', ROOM, '--id', PRINCIPAL], {
      env: { ...process.env, CHAT_HOME },
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
  } catch {
    /* user Ctrl-C */
  }
}

function cmdMinutes(args: string[]): void {
  process.stdout.write(chatCapture(['history', '--room', ROOM, '--limit', args[0] || '40']));
}

function cmdDigest(args: string[]): void {
  ensureLayers();
  const f = join(BOARD_HOME, 'mem', 'minutes.md');
  const body = chatCapture(['history', '--room', ROOM, '--limit', args[0] || '60']);
  appendFileSync(f, `\n## Boardroom session digest\n${body}\n`, 'utf8');
  process.stdout.write(`digest appended -> ${f}\n`);
}

// ── convene / ask / adjourn (tmux carrier) ────────────────────────────────────

function cmdConvene(args: string[]): void {
  ensureLayers();
  if (!tmuxAvailable()) {
    die(
      'tmux not found. The boardroom carries live claude sessions in tmux windows.\n' +
        '  macOS:  brew install tmux\n' +
        '  Linux:  apt/yum install tmux\n' +
        '  Windows: run boardroom inside WSL (a native carrier can be added later).',
    );
  }
  const ids = args.length ? args : listPersonas();
  if (!ids.length) die('no personas (run: boardroom init, or boardroom add <id>)');
  // Ensure zero-confirm launch for both claude- and codex-backed personas.
  pretrustAll(ids);

  if (!sessionExists()) {
    // Create the session detached with the first persona in window 0.
    const first = ids[0];
    const r = tmux([
      'new-session', '-d', '-s', SESSION, '-n', first, '-c', personaDir(first),
    ]);
    if (!r.ok) die(`failed to create tmux session: ${r.out}`);
    tmux(['send-keys', '-t', windowFor(first), personaCommand(first), 'C-m']);
    process.stdout.write(`convened: ${first}\n`);
    for (const id of ids.slice(1)) convenePersona(id);
  } else {
    for (const id of ids) convenePersona(id);
  }

  process.stdout.write(
    `Boardroom in session (tmux '${SESSION}'). Live claude sessions are booting.\n` +
      `  boardroom ask "<your topic>"   # send-keys a topic to every thinker\n` +
      `  boardroom watch                # see their inputs stream into the room\n` +
      `  boardroom attach               # watch the thinkers think (Ctrl-b d to detach)\n`,
  );
}

function convenePersona(id: string): void {
  if (!existsSync(personaDir(id))) {
    process.stdout.write(`  skip ${id}: no folder\n`);
    return;
  }
  if (windowExists(id)) {
    process.stdout.write(`  ${id}: already convened\n`);
    return;
  }
  const r = tmux(['new-window', '-t', SESSION, '-n', id, '-c', personaDir(id)]);
  if (!r.ok) {
    process.stdout.write(`  ${id}: failed (${r.out.trim()})\n`);
    return;
  }
  tmux(['send-keys', '-t', windowFor(id), personaCommand(id), 'C-m']);
  process.stdout.write(`convened: ${id}\n`);
}

function injectTopic(id: string, text: string): boolean {
  if (!windowExists(id)) return false;
  // happy's lesson: send the text and the Enter key as SEPARATE send-keys calls.
  const a = tmux(['send-keys', '-t', windowFor(id), '-l', text]); // -l: literal, no key-name parsing
  const b = tmux(['send-keys', '-t', windowFor(id), 'C-m']);
  return a.ok && b.ok;
}

// ── relay: the "real-time inject" transport ───────────────────────────────────
// A persona's live agent is a passive REPL — it only acts on input. The relay is
// what makes the room a real group chat: it tails the room and pushes each new
// message into the right agent window(s) via send-keys, so every member perceives
// what others said and can choose to reply (or stay silent). This is the piece
// happy-cli's cloud daemon did via SDK-stream injection; here it's plain tmux.
//
// Routing by the message's mentions (set by `chat send --to ...`):
//   • mentions includes "all"  -> everyone except the sender (broadcast page)
//   • mentions has specific ids -> only those windows (point-to-point)
//   • no mentions (bare message) -> everyone except the sender (room broadcast)
// The principal ("you") is never injected (they read via the TUI), but messages
// addressed to a persona by the principal are delivered normally.

const BUSY_TAIL_RE = /(esc to interrupt|Thinking|Churn|Quantum|Working|running|tokens|⏵⏵.*on)/i;

// Heuristic: is the agent in this window mid-turn (so injecting now would corrupt input)?
function windowBusy(id: string): boolean {
  const { ok, out } = tmux(['capture-pane', '-t', windowFor(id), '-p']);
  if (!ok) return false;
  const lines = out.split('\n').filter((l) => l.trim() !== '');
  const tail = lines.slice(-4).join(' ');
  // "esc to interrupt" / a running spinner means the agent is actively working.
  // A bare prompt (❯ / ›) with no spinner means idle and safe to inject.
  if (/esc to interrupt|to interrupt/i.test(tail)) return true;
  return false;
}

// Members the supervisor has throttled for dominating the room. Throttled members
// can still receive/answer DIRECT @mentions, but their un-addressed broadcasts are
// not fanned out, and room broadcasts are not pushed INTO them — this quiets a
// dominator without silencing them entirely. (happy-cli's "stop relaying to/from a
// saturated agent", realized as a filter on the existing relay.)
function readThrottled(): Set<string> {
  const path = join(CHAT_HOME, ROOM, 'throttle.json');
  if (!existsSync(path)) return new Set();
  try {
    const arr = JSON.parse(readFileSync(path, 'utf8'));
    return new Set(Array.isArray(arr) ? arr : []);
  } catch {
    return new Set();
  }
}

function routeTargets(fromId: string, mentions: string[] | undefined): string[] {
  const throttled = readThrottled();
  const isBroadcast = !mentions || mentions.length === 0 || mentions.includes('all');
  // A throttled member's broadcast does not fan out (it can still answer @mentions).
  if (isBroadcast && throttled.has(fromId)) return [];
  let targets: string[];
  if (!mentions || mentions.length === 0 || mentions.includes('all')) {
    targets = listPersonas().filter((id) => id !== fromId && windowExists(id));
  } else {
    targets = mentions.filter((m) => m !== fromId && m !== PRINCIPAL && windowExists(m));
  }
  // Don't push un-addressed room broadcasts INTO a throttled member (mute its inbox
  // for noise, but keep direct @mentions flowing so it stays reachable).
  if (isBroadcast) targets = targets.filter((t) => !throttled.has(t));
  return targets;
}

function relayLine(fromId: string, fromDisplay: string, content: string): string {
  // What the recipient agent sees injected into its window. Their persona protocol
  // tells them to read it and decide whether to chat send a reply (or stay silent).
  return `[群消息] ${fromDisplay || fromId}: ${content}`;
}

interface RelayState {
  lastId: string;
  // messages waiting because their target window was busy: targetId -> queued lines
  pending: Map<string, string[]>;
}

function cmdRelay(args: string[]): void {
  if (!sessionExists()) die('no session — run: boardroom convene (or discuss) first');
  const intervalMs = Math.max(300, Number(args[0] || '1') * 1000) || 1000;
  process.stdout.write(`relay: live. Pushing room messages into agent windows (Ctrl-C to stop).\n`);
  const state: RelayState = { lastId: '', pending: new Map() };

  // Seed lastId to "now" so the relay only forwards messages from this point on
  // (history already sits in each agent's context if they were just convened).
  const seed = readHistoryJson(1);
  if (seed.length) state.lastId = seed[seed.length - 1].id;

  const tick = () => {
    // 1) flush any queued messages whose target window is now idle.
    for (const [target, lines] of state.pending) {
      if (!lines.length) {
        state.pending.delete(target);
        continue;
      }
      if (!windowBusy(target)) {
        const line = lines.shift()!;
        injectTopic(target, line);
        if (!lines.length) state.pending.delete(target);
      }
    }
    // 2) pull new messages and route them.
    const msgs = readHistoryJson(200).filter((m) => (state.lastId ? m.id > state.lastId : true));
    for (const m of msgs) {
      state.lastId = m.id;
      if (m.from === PRINCIPAL && (!m.mentions || m.mentions.length === 0)) {
        // a bare message from the principal is a topic for everyone (handled by discuss/ask)
      }
      const targets = routeTargets(m.from, m.mentions);
      const line = relayLine(m.from, m.fromDisplayName || m.from, m.content);
      for (const t of targets) {
        if (windowBusy(t)) {
          const q = state.pending.get(t) || [];
          q.push(line);
          state.pending.set(t, q);
        } else {
          injectTopic(t, line);
        }
      }
    }
  };

  // Run forever until Ctrl-C.
  const loop = setInterval(tick, intervalMs);
  const stop = () => {
    clearInterval(loop);
    process.stdout.write('\nrelay: stopped.\n');
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

interface HistMsg {
  id: string;
  from: string;
  fromDisplayName?: string;
  content: string;
  mentions?: string[];
  type?: string;
}

function readHistoryJson(limit: number): HistMsg[] {
  const raw = chatCapture(['history', '--room', ROOM, '--limit', String(limit), '--json']);
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? (arr as HistMsg[]) : [];
  } catch {
    return [];
  }
}

// ── supervisor: a deterministic observer (NO LLM, NO adjourn) ──────────────────
// Ported from happy-cli's supervisorScheduler, trimmed to a pure observer. It does
// NOT end the meeting — the facilitator "master" owns convergence/ADJOURN. The
// supervisor only (1) THROTTLES a dominator (relative imbalance) by writing
// throttle.json that the relay honors, and (2) PAGES master when a member has gone
// quiet or the room degrades into 1:1 rebuttal ping-pong, so master can act.
function writeThrottled(ids: string[]): void {
  ensureRoomCtrlDir();
  atomicWriteFile(join(CHAT_HOME, ROOM, 'throttle.json'), JSON.stringify(ids));
}
function ensureRoomCtrlDir(): void {
  const d = join(CHAT_HOME, ROOM);
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
}
function atomicWriteFile(path: string, data: string): void {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, data, 'utf8');
  renameSync(tmp, path); // atomic on local fs
}

function cmdSupervise(args: string[]): void {
  if (!sessionExists()) die('no session — run: boardroom convene (or discuss) first');
  const intervalMs = Math.max(1000, Number(process.env.SUP_INTERVAL_S || args[0] || '5') * 1000);
  // A member dominates if it has spoken more than DOMINATE_FACTOR x the median.
  const DOMINATE_FACTOR = Number(process.env.SUP_DOMINATE_FACTOR || '1.8');
  const MIN_TO_JUDGE = Number(process.env.SUP_MIN_TO_JUDGE || '8'); // need some volume before throttling
  const DRIFT_WINDOW = 10;
  const DRIFT_THRESH = Number(process.env.SUP_DRIFT_THRESH || '0.8');
  const QUIET_PAGE_S = Number(process.env.SUP_QUIET_PAGE_S || '40'); // page master if a member silent this long while room active
  process.stdout.write(`supervisor: live (observe + throttle + page master; master owns ADJOURN). Ctrl-C to stop.\n`);

  let lastId = '';
  const seed = readHistoryJson(1);
  if (seed.length) lastId = seed[seed.length - 1].id;
  const speak = new Map<string, { count: number; lastTs: number }>();
  let lastPagedDrift = 0;
  const pagedQuiet = new Set<string>();
  let adjournSeen = false;

  const tick = () => {
    const all = readHistoryJson(400);
    const fresh = all.filter((m) => (lastId ? m.id > lastId : true));
    if (fresh.length) lastId = fresh[fresh.length - 1].id;
    const now = Date.now();

    for (const m of fresh) {
      if (m.from === PRINCIPAL || m.from === 'master' || m.from === 'supervisor') {
        if (m.type === 'system' && /ADJOURN/i.test(m.content)) adjournSeen = true;
        continue;
      }
      const s = speak.get(m.from) || { count: 0, lastTs: 0 };
      s.count += 1;
      s.lastTs = Number(m.id.slice(0, 13)) || now;
      speak.set(m.from, s);
    }
    if (adjournSeen) {
      // Meeting is over (master adjourned). Clear throttles and exit.
      writeThrottled([]);
      process.stdout.write('supervisor: master adjourned — exiting.\n');
      clearInterval(loop);
      process.exit(0);
    }

    const counts = [...speak.values()].map((s) => s.count).sort((a, b) => a - b);
    const total = counts.reduce((a, b) => a + b, 0);
    if (total >= MIN_TO_JUDGE && counts.length >= 3) {
      const median = counts[Math.floor(counts.length / 2)] || 1;
      const dominators: string[] = [];
      for (const [id, s] of speak) {
        if (s.count > Math.max(2, DOMINATE_FACTOR * median)) dominators.push(id);
      }
      writeThrottled(dominators);
      // call-on-quiet: a member who has spoken far less and not recently -> page master
      const recentActive = total > 0;
      if (recentActive) {
        for (const id of listPersonas().filter((p) => p !== 'master' && windowExists(p))) {
          const s = speak.get(id);
          const silentMs = s ? now - s.lastTs : Infinity;
          const lowVolume = !s || s.count <= Math.max(1, median - 1);
          if (lowVolume && silentMs > QUIET_PAGE_S * 1000 && !pagedQuiet.has(id)) {
            chatCapture(['send', '--room', ROOM, '--from', 'supervisor', '--to', 'master', '--message', `quiet=${id}`]);
            pagedQuiet.add(id);
          } else if (s && s.count > median) {
            pagedQuiet.delete(id); // they've spoken; allow future paging
          }
        }
      }
    }

    // drift detection: last DRIFT_WINDOW persona msgs that are 1:1 @rebuttals
    const personaMsgs = all.filter((m) => m.from !== PRINCIPAL && m.from !== 'master' && m.from !== 'supervisor');
    const lastN = personaMsgs.slice(-DRIFT_WINDOW);
    if (lastN.length >= DRIFT_WINDOW) {
      const p2p = lastN.filter((m) => m.mentions && m.mentions.length === 1 && !m.mentions.includes('all')).length;
      if (p2p / lastN.length >= DRIFT_THRESH && now - lastPagedDrift > 30000) {
        chatCapture(['send', '--room', ROOM, '--from', 'supervisor', '--to', 'master', '--message', 'drift']);
        lastPagedDrift = now;
      }
    }
  };

  const loop = setInterval(tick, intervalMs);
  const stop = () => {
    clearInterval(loop);
    writeThrottled([]);
    process.stdout.write('\nsupervisor: stopped.\n');
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}



function askPrompt(id: string, topic: string): string {
  return (
    `[BOARDROOM 议题] ${topic} ` +
    `（只用你自己的框架，参考 ./corpus/，给一条最高杠杆输入 + 一个可证伪判断，` +
    `然后运行：chat send --room ${ROOM} --from ${id} --to all --type notification "..."。` +
    `之后群里别人发言会推给你，有新观点再说，没有就沉默。）`
  );
}

function cmdAsk(args: string[]): void {
  const topic = args.join(' ').trim();
  if (!topic) die('usage: boardroom ask "<topic>"');
  if (!sessionExists()) die('no session — run: boardroom convene');
  // Record the principal's question into the room so minutes are complete.
  chatCapture(['send', '--room', ROOM, '--from', PRINCIPAL, '--message', `议题: ${topic}`]);
  const targets = listPersonas().filter(windowExists);
  const asked: string[] = [];
  for (const id of targets) {
    if (injectTopic(id, askPrompt(id, topic))) asked.push(id);
  }
  process.stdout.write(`asked: ${asked.join(', ') || '(none live)'}\n`);
  process.stdout.write(`Watch replies:  boardroom watch\n`);
}

// Start a SELF-DRIVING discussion: seed the goal to everyone, then start the relay
// in its own tmux window so room messages are pushed into agents automatically —
// one member's reply becomes the next member's input, and the chat self-propagates.
function startSidecar(name: string, verb: string): void {
  const win = `${SESSION}:${name}`;
  const has = tmux(['list-windows', '-t', SESSION, '-F', '#{window_name}']).out
    .split('\n')
    .map((s) => s.trim())
    .includes(name);
  if (has) return;
  tmux(['new-window', '-t', SESSION, '-n', name]);
  const selfBin = process.argv[1];
  const cmd =
    `CHAT_HOME=${shq(CHAT_HOME)} BOARD_HOME=${shq(BOARD_HOME)} BOARD_ROOM=${shq(ROOM)} ` +
    `BOARD_PRINCIPAL=${shq(PRINCIPAL)} exec ${shq(process.execPath)} ${shq(selfBin)} ${verb}`;
  tmux(['send-keys', '-t', win, cmd, 'C-m']);
  process.stdout.write(`${name} started (window '${name}').\n`);
}

function cmdDiscuss(args: string[]): void {
  const goal = args.join(' ').trim();
  if (!goal) die('usage: boardroom discuss "<goal>"');
  if (!sessionExists()) die('no session — run: boardroom convene first');

  // Start the transport (relay) and the observer (supervisor) in their own windows.
  startSidecar('relay', 'relay');
  startSidecar('supervise', 'supervise');

  // Hand the goal to the FACILITATOR (master), who runs the meeting: it SEEDs the
  // agenda with convergence criteria, calls on the quiet, redirects drift, and
  // declares ADJOURN. If there's no master persona, fall back to broadcasting the
  // goal to everyone (legacy self-drive).
  chatCapture(['send', '--room', ROOM, '--from', PRINCIPAL, '--message', `议题: ${goal}`]);
  if (windowExists('master')) {
    injectTopic(
      'master',
      `[BOARDROOM 议题] ${PRINCIPAL} 给你的议题：${goal}\n` +
        `你是主持人 master。请按你的 CLAUDE.md：把它重述成带"收敛判据"的议程，` +
        `chat send --from master --to all --type system "议题: ... | 收敛判据: (1)... (2)..."，` +
        `然后主持讨论，judge 够了就 ADJOURN。`,
    );
    process.stdout.write(`discussing: ${goal}\n`);
    process.stdout.write(`handed to facilitator 'master'. The board self-drives; master will converge.\n`);
  } else {
    const seeded: string[] = [];
    for (const id of listPersonas().filter(windowExists)) {
      if (injectTopic(id, askPrompt(id, goal))) seeded.push(id);
    }
    process.stdout.write(`discussing: ${goal}\n`);
    process.stdout.write(`seeded: ${seeded.join(', ') || '(none live)'} (no master persona — legacy self-drive)\n`);
  }
  process.stdout.write(`Watch it:  boardroom watch\n`);
}

function cmdAskOne(args: string[]): void {
  const id = args[0] || die('usage: boardroom ask-one <id> "<topic>"');
  const topic = args.slice(1).join(' ').trim();
  if (!topic) die('need a topic');
  if (!sessionExists()) die('no session — run: boardroom convene');
  const ok = injectTopic(id, askPrompt(id, topic));
  process.stdout.write(ok ? `asked ${id}. Watch: boardroom watch\n` : `failed to reach ${id} (is it convened?)\n`);
}

function cmdStatus(): void {
  const inSession = sessionExists();
  process.stdout.write(`session: ${inSession ? `in session (tmux '${SESSION}')` : 'idle'}\n`);
  const personas = listPersonas();
  process.stdout.write(
    `personas (folders): ${personas.map((id) => `${id}[${personaRuntime(id)}]`).join(', ') || '(none)'}\n`,
  );
  if (inSession) {
    const { out } = tmux(['list-windows', '-t', SESSION, '-F', '#{window_name}']);
    process.stdout.write(`live windows: ${out.split('\n').map((s) => s.trim()).filter(Boolean).join(', ')}\n`);
  }
}

function cmdAttach(): void {
  if (!sessionExists()) die('no session — run: boardroom convene');
  // Replace this process with an attached tmux client.
  const res = spawnSync('tmux', ['attach', '-t', SESSION], { stdio: 'inherit' });
  process.exit(res.status ?? 0);
}

function cmdAdjourn(): void {
  if (!sessionExists()) {
    process.stdout.write('no active session.\n');
    return;
  }
  for (const id of listPersonas()) {
    if (windowExists(id)) chatCapture(['leave', '--room', ROOM, '--id', id]);
  }
  tmux(['kill-session', '-t', SESSION]);
  process.stdout.write('adjourned (folders persist).\n');
}

function cmdRuntime(args: string[]): void {
  const id = args[0] || die('usage: boardroom runtime <id> [claude|codex]');
  if (!existsSync(personaDir(id))) die(`unknown persona: ${id}`);
  const val = (args[1] || '').toLowerCase();
  if (!val) {
    process.stdout.write(`${id}: ${personaRuntime(id)}\n`);
    return;
  }
  if (val !== 'claude' && val !== 'codex') die('runtime must be claude or codex');
  writeFileSync(join(personaDir(id), 'runtime'), val + '\n', 'utf8');
  process.stdout.write(`${id} runtime set to ${val}\n`);
}

function usage(): void {
  process.stdout.write(`boardroom — AI 经营外脑 on chat-cli (a live agent per thinker, carried by tmux)

Setup / roster (everything is just folders):
  boardroom init                    Scaffold $BOARD_HOME, import personas, pre-trust for zero-confirm launch.
  boardroom add <id> [name] [--runtime claude|codex]   Create a persona folder (CLAUDE.md + AGENTS.md + corpus/).
  boardroom seed <id> <file>        Append a file into persona <id>'s corpus.
  boardroom runtime <id> [claude|codex]   Show or set which agent runtime backs a persona.
  boardroom list                    List personas (folders).

Your layers (also folders):
  boardroom remember <text>         Append a note to YOUR long-term memory (mem/).
  boardroom doc <file> [company|external]   Import a doc into the fact layer (kb/).

Run the board (each persona = a live claude/codex in a tmux window; topic via send-keys):
  boardroom convene [ids...]        Open one live persona window per id (default: all). Zero confirmation screens.
  boardroom discuss "<goal>"        Self-driving group chat: seed the goal + start the relay so members
                                    perceive each other's messages and reply on their own (@all / @id routing).
  boardroom relay [intervalS]       (internal) push room messages into agent windows; started by discuss.
  boardroom supervise [intervalS]   (internal) observe + throttle a dominator + page master; started by discuss.
  boardroom ask "<topic>"           One-shot: send-keys a topic into every live persona (no relay).
  boardroom ask-one <id> "<topic>"  Ask a single thinker.
  boardroom watch                   Slack-style TUI of the room (members + stream + input).
  boardroom minutes [N]             Print the last N messages as meeting minutes.
  boardroom digest                  Append the current minutes into YOUR memory (mem/).
  boardroom attach                  Attach to the tmux session (Ctrl-b d to detach).
  boardroom status                  Show session + live windows + each persona's runtime.
  boardroom adjourn                 Kill the tmux session (folders persist).

Env: BOARD_HOME, BOARD_ROOM, BOARD_PRINCIPAL, BOARD_MODEL, BOARD_RUNTIME (claude|codex),
     BOARD_CLAUDE_BIN, BOARD_CODEX_BIN, BOARD_TMUX (session name), CHAT_HOME.
`);
}

function main(): void {
  const [cmd, ...args] = process.argv.slice(2);
  switch (cmd) {
    case 'init': return cmdInit();
    case 'add': return cmdAdd(args);
    case 'seed': return cmdSeed(args);
    case 'runtime': return cmdRuntime(args);
    case 'list': process.stdout.write(listPersonas().join('\n') + '\n'); return;
    case 'remember': return cmdRemember(args);
    case 'doc': return cmdDoc(args);
    case 'convene': return cmdConvene(args);
    case 'discuss': return cmdDiscuss(args);
    case 'relay': return cmdRelay(args);
    case 'supervise': return cmdSupervise(args);
    case 'ask': return cmdAsk(args);
    case 'ask-one': return cmdAskOne(args);
    case 'watch': return cmdWatch();
    case 'minutes': return cmdMinutes(args);
    case 'digest': return cmdDigest(args);
    case 'status': return cmdStatus();
    case 'attach': return cmdAttach();
    case 'adjourn': return cmdAdjourn();
    case 'help': case '-h': case '--help': case undefined: return usage();
    default: usage(); process.exit(1);
  }
}

main();
