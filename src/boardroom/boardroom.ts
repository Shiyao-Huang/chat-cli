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
  readdirSync,
  statSync,
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
// tmux session that holds one window per persona.
const SESSION = process.env.BOARD_TMUX || 'boardroom';
// Permission posture for the spawned claude sessions. Personas only need to run
// the `chat` CLI; bypass keeps them from blocking on prompts in an unattended window.
const PERMISSION_MODE = process.env.BOARD_PERMISSION_MODE || 'bypassPermissions';

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

// Build the shell command a persona window runs: join the room, then launch claude
// in the persona folder so it auto-loads CLAUDE.md as its character.
function personaCommand(id: string): string {
  const dir = personaDir(id);
  const modelFlag = MODEL ? `--model ${shq(MODEL)} ` : '';
  // chat join is best-effort; then exec claude (interactive, real PTY from tmux).
  return (
    `cd ${shq(dir)} && ` +
    `CHAT_HOME=${shq(CHAT_HOME)} chat join --room ${shq(ROOM)} --id ${shq(id)} --role ${shq(id)} >/dev/null 2>&1; ` +
    `CHAT_HOME=${shq(CHAT_HOME)} exec ${shq(CLAUDE_BIN)} ${modelFlag}--permission-mode ${shq(PERMISSION_MODE)}`
  );
}

// POSIX single-quote escaping for embedding in the tmux window command.
function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
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
  try {
    execFileSync('chat', ['watch', '--room', ROOM, '--id', PRINCIPAL], {
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

function askPrompt(id: string, topic: string): string {
  return (
    `[BOARDROOM 议题] ${topic} ` +
    `（只用你自己的框架，参考 ./corpus/，给一条最高杠杆输入 + 一个可证伪判断，` +
    `然后运行：chat send --room ${ROOM} --from ${id} --to ${PRINCIPAL} --type notification "..."）`
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
  process.stdout.write(`personas (folders): ${listPersonas().join(', ') || '(none)'}\n`);
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

function usage(): void {
  process.stdout.write(`boardroom — AI 经营外脑 on chat-cli (live claude per thinker, carried by tmux)

Setup / roster (everything is just folders):
  boardroom init                    Scaffold $BOARD_HOME and import persona templates.
  boardroom add <id> [name]         Create an empty persona folder (CLAUDE.md + corpus/).
  boardroom seed <id> <file>        Append a file into persona <id>'s corpus.
  boardroom list                    List personas (folders).

Your layers (also folders):
  boardroom remember <text>         Append a note to YOUR long-term memory (mem/).
  boardroom doc <file> [company|external]   Import a doc into the fact layer (kb/).

Run the board (each persona = a live claude in a tmux window; topic via send-keys):
  boardroom convene [ids...]        Open one live persona window per id (default: all).
  boardroom ask "<topic>"           send-keys a topic into every live persona; they reply into the room.
  boardroom ask-one <id> "<topic>"  Ask a single thinker.
  boardroom watch                   Tail the boardroom room live.
  boardroom minutes [N]             Print the last N messages as meeting minutes.
  boardroom digest                  Append the current minutes into YOUR memory (mem/).
  boardroom attach                  Attach to the tmux session (Ctrl-b d to detach).
  boardroom status                  Show session + live windows.
  boardroom adjourn                 Kill the tmux session (folders persist).

Env: BOARD_HOME, BOARD_ROOM, BOARD_PRINCIPAL, BOARD_MODEL, BOARD_CLAUDE_BIN,
     BOARD_TMUX (session name), BOARD_PERMISSION_MODE, CHAT_HOME.
`);
}

function main(): void {
  const [cmd, ...args] = process.argv.slice(2);
  switch (cmd) {
    case 'init': return cmdInit();
    case 'add': return cmdAdd(args);
    case 'seed': return cmdSeed(args);
    case 'list': process.stdout.write(listPersonas().join('\n') + '\n'); return;
    case 'remember': return cmdRemember(args);
    case 'doc': return cmdDoc(args);
    case 'convene': return cmdConvene(args);
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
