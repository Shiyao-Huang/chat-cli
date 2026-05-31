/**
 * tui.ts — a Slack-style group-chat TUI over the chat-cli broker.
 *
 * Zero dependencies: raw ANSI on a TTY. Layout (like Slack in the terminal):
 *
 *   ┌─ #room ──────────────────────────── you ─ N online ─┐   top bar
 *   │ MEMBERS        │  munger  ▸ message text…           │
 *   │ ● munger  arch │  bezos   ▸ another message @you     │   sidebar | message stream
 *   │ ● bezos   prod │  …                                  │
 *   │ ○ drucker mgmt │                                     │
 *   ├────────────────┴─────────────────────────────────────┤
 *   │ > your message_                                       │   input box
 *   └──────────────────────────────────────────────────────┘
 *
 * Live: polls the broker on an interval, redraws on change. You type to send
 * as your member id; @id tokens become mentions. Ctrl-C / Esc / q quits.
 *
 * This is the human window into the multi-agent room — agents (claude/codex)
 * post via `chat send`; you watch and join the same conversation here.
 */

import { ChatBroker } from './broker.js';
import type { ChatMessage, RosterEntry } from './types.js';

const ESC = '\x1b';
const CSI = `${ESC}[`;

// 256-color palette assigned deterministically per sender so each agent keeps a stable color.
const SENDER_COLORS = [39, 213, 208, 84, 220, 170, 51, 203, 141, 117, 228, 156];

interface TuiOptions {
  room: string;
  viewerId: string;
  intervalMs?: number;
}

function colorFor(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return SENDER_COLORS[h % SENDER_COLORS.length];
}

// Visual width: count CJK / fullwidth as 2 columns, control chars as 0.
function charWidth(cp: number): number {
  if (cp === 0) return 0;
  if (cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if (
    (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
    (cp >= 0x2e80 && cp <= 0xa4cf) || // CJK radicals .. Yi
    (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul syllables
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK compat
    (cp >= 0xfe30 && cp <= 0xfe4f) || // CJK compat forms
    (cp >= 0xff00 && cp <= 0xff60) || // Fullwidth forms
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) || // emoji
    (cp >= 0x20000 && cp <= 0x3fffd)
  ) {
    return 2;
  }
  return 1;
}

function strWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += charWidth(ch.codePointAt(0)!);
  return w;
}

// Truncate a string to a max visual width, optionally adding an ellipsis.
function truncWidth(s: string, max: number): string {
  if (max <= 0) return '';
  let w = 0;
  let out = '';
  for (const ch of s) {
    const cw = charWidth(ch.codePointAt(0)!);
    if (w + cw > max) return out;
    out += ch;
    w += cw;
  }
  return out;
}

// Word/char wrap a string to a visual width, returning display lines.
function wrapWidth(s: string, width: number): string[] {
  if (width <= 0) return [s];
  const lines: string[] = [];
  for (const rawLine of s.split('\n')) {
    let cur = '';
    let curW = 0;
    for (const ch of rawLine) {
      const cw = charWidth(ch.codePointAt(0)!);
      if (curW + cw > width) {
        lines.push(cur);
        cur = ch;
        curW = cw;
      } else {
        cur += ch;
        curW += cw;
      }
    }
    lines.push(cur);
  }
  return lines;
}

function fg(code: number): string {
  return `${CSI}38;5;${code}m`;
}
const RESET = `${CSI}0m`;
const BOLD = `${CSI}1m`;
const DIM = `${CSI}2m`;
const REVERSE = `${CSI}7m`;

function presenceDot(p: string): string {
  if (p === 'alive') return `${fg(84)}●${RESET}`; // green
  if (p === 'idle') return `${fg(220)}◐${RESET}`; // amber
  return `${fg(241)}○${RESET}`; // grey
}

function hhmmss(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export async function runTui(broker: ChatBroker, opts: TuiOptions): Promise<number> {
  const { room, viewerId } = opts;
  const intervalMs = Math.max(200, opts.intervalMs ?? 700);
  const out = process.stdout;

  if (!out.isTTY || !process.stdin.isTTY) {
    process.stderr.write('chat tui requires an interactive terminal (TTY).\n');
    return 1;
  }

  // Ensure the viewer is on the roster so agents can @ them and see presence.
  try {
    broker.join({ room, id: viewerId, role: 'human', runtime: 'tui' });
  } catch {
    /* invalid id will surface on first send */
  }

  let messages: ChatMessage[] = broker.history(room, { limit: 500 });
  let roster: RosterEntry[] = broker.roster(room);
  let input = '';
  let scroll = 0; // lines scrolled up from bottom (0 = newest)
  let status = '';
  let running = true;
  const SIDEBAR_W = 18;

  const write = (s: string) => out.write(s);
  const hideCursor = () => write(`${CSI}?25l`);
  const showCursor = () => write(`${CSI}?25h`);
  const enterAlt = () => write(`${CSI}?1049h`);
  const leaveAlt = () => write(`${CSI}?1049l`);
  const clear = () => write(`${CSI}2J${CSI}H`);
  const moveTo = (r: number, c: number) => write(`${CSI}${r};${c}H`);

  function buildMessageLines(width: number): string[] {
    const lines: string[] = [];
    for (const m of messages) {
      const isYou = m.from === viewerId;
      const mentionsYou = m.mentions?.includes(viewerId);
      const c = colorFor(m.from);
      const tag =
        m.type && m.type !== 'chat' ? ` ${DIM}#${m.type}${RESET}` : '';
      const pri =
        m.priority === 'urgent'
          ? ` ${fg(196)}${BOLD}!urgent${RESET}`
          : m.priority === 'high'
          ? ` ${fg(208)}!high${RESET}`
          : '';
      const namecol = isYou ? 250 : c;
      const header =
        `${DIM}${hhmmss(m.timestamp)}${RESET} ` +
        `${fg(namecol)}${BOLD}${m.from}${RESET}` +
        (mentionsYou ? ` ${fg(220)}${BOLD}@you${RESET}` : '') +
        pri +
        tag;
      lines.push(header);
      // body wrapped, indented 2 spaces
      const bodyWidth = width - 2;
      for (const bl of wrapWidth(m.content, bodyWidth)) {
        const prefix = mentionsYou ? `${fg(220)}▎${RESET} ` : '  ';
        lines.push(prefix + bl);
      }
    }
    return lines;
  }

  function render(): void {
    const rows = out.rows || 24;
    const cols = out.columns || 80;
    const mainW = Math.max(20, cols - SIDEBAR_W - 1);
    const bodyRows = rows - 2 - 2; // minus top bar (1) + sep (1) + input (2)

    let buf = '';
    // ── top bar ──
    const online = roster.filter((r) => r.presence === 'alive').length;
    const left = ` ${BOLD}#${room}${RESET}`;
    const right = `${fg(250)}${viewerId}${RESET} ${DIM}·${RESET} ${fg(84)}${online} online${RESET} `;
    const barTextW = strWidth(`#${room}`) + 1 + strWidth(`${viewerId} · ${online} online`) + 1;
    const pad = Math.max(1, cols - barTextW);
    buf += `${CSI}H${REVERSE}${left}${' '.repeat(pad)}${right}${RESET}${CSI}K\n`;

    // ── body: sidebar | messages ──
    const allLines = buildMessageLines(mainW);
    const maxScroll = Math.max(0, allLines.length - bodyRows);
    if (scroll > maxScroll) scroll = maxScroll;
    const start = Math.max(0, allLines.length - bodyRows - scroll);
    const visible = allLines.slice(start, start + bodyRows);

    const sortedRoster = [...roster].sort((a, b) => {
      const order = (p: string) => (p === 'alive' ? 0 : p === 'idle' ? 1 : 2);
      return order(a.presence) - order(b.presence) || a.id.localeCompare(b.id);
    });

    for (let i = 0; i < bodyRows; i++) {
      // sidebar cell
      let side = '';
      if (i === 0) {
        side = `${DIM}MEMBERS${RESET}`;
      } else {
        const member = sortedRoster[i - 1];
        if (member) {
          const dot = presenceDot(member.presence);
          const isYou = member.id === viewerId;
          const nm = truncWidth(member.id, SIDEBAR_W - 6);
          const nameCol = isYou ? 250 : colorFor(member.id);
          side = `${dot} ${fg(nameCol)}${nm}${RESET}`;
        }
      }
      const sideW = strWidth(stripAnsi(side));
      side += ' '.repeat(Math.max(0, SIDEBAR_W - sideW));

      const line = visible[i] ?? '';
      const lineW = strWidth(stripAnsi(line));
      const cappedLine =
        lineW > mainW ? line : line + ' '.repeat(Math.max(0, mainW - lineW));

      buf += `${side}${DIM}│${RESET}${cappedLine}${CSI}K\n`;
    }

    // ── separator ──
    buf += `${DIM}${'─'.repeat(cols)}${RESET}${CSI}K\n`;

    // ── input box ──
    const scrollHint = scroll > 0 ? ` ${DIM}(↑${scroll} — End to jump to latest)${RESET}` : '';
    const prompt = `${fg(84)}❯${RESET} `;
    const shownInput = truncWidth(input, mainW + SIDEBAR_W - 4);
    buf += `${prompt}${shownInput}${CSI}K\n`;
    const help = status
      ? `${fg(220)}${status}${RESET}`
      : `${DIM}@id to mention · PgUp/PgDn scroll · Enter send · Ctrl-C quit${RESET}`;
    buf += `${help}${scrollHint}${CSI}K`;

    // position cursor at end of input
    write(`${CSI}H${buf}`);
    moveTo(rows - 1, strWidth(stripAnsi(prompt)) + strWidth(shownInput) + 1);
  }

  function refresh(): void {
    const newMsgs = broker.history(room, { limit: 500 });
    messages = newMsgs;
    roster = broker.roster(room);
    // touch presence so the viewer stays alive
    try {
      broker.touch(room, viewerId);
    } catch {
      /* ignore */
    }
    render();
  }

  function send(text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    // @mentions: any @token that matches a roster id becomes a mention.
    const ids = new Set(roster.map((r) => r.id));
    const mentions: string[] = [];
    for (const tok of trimmed.match(/@([A-Za-z0-9._-]+)/g) || []) {
      const id = tok.slice(1);
      if (ids.has(id) && id !== viewerId) mentions.push(id);
    }
    try {
      broker.send({ room, from: viewerId, content: trimmed, mentions: mentions.length ? mentions : undefined });
      status = '';
    } catch (e) {
      status = `send failed: ${(e as Error).message}`;
    }
  }

  // ── terminal setup ──
  enterAlt();
  hideCursor();
  clear();
  process.stdin.setRawMode?.(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');

  const cleanup = () => {
    showCursor();
    leaveAlt();
    process.stdin.setRawMode?.(false);
    process.stdin.pause();
  };

  const timer = setInterval(() => {
    if (running) refresh();
  }, intervalMs);

  out.on('resize', () => render());

  refresh();

  await new Promise<void>((resolve) => {
    process.stdin.on('data', (d: string) => {
      for (const ch of splitKeys(d)) {
        if (ch === '\x03' || ch === '\x1b') {
          // Ctrl-C or Esc → quit
          running = false;
          resolve();
          return;
        } else if (ch === '\r' || ch === '\n') {
          if (input.trim()) {
            send(input);
            input = '';
            scroll = 0;
            refresh();
          }
        } else if (ch === '\x7f' || ch === '\b') {
          input = [...input].slice(0, -1).join('');
          render();
        } else if (ch === '\x1b[5~') {
          scroll += 5;
          render();
        } else if (ch === '\x1b[6~') {
          scroll = Math.max(0, scroll - 5);
          render();
        } else if (ch === '\x1b[F' || ch === '\x1bOF') {
          scroll = 0;
          render();
        } else if (ch.startsWith('\x1b')) {
          // ignore other escape sequences (arrows, etc.)
        } else if (ch >= ' ') {
          input += ch;
          render();
        }
      }
    });
  });

  clearInterval(timer);
  cleanup();
  return 0;
}

// Split a raw input chunk into individual keypresses, keeping CSI escape
// sequences (e.g. PgUp = \x1b[5~) as single tokens.
function splitKeys(s: string): string[] {
  const keys: string[] = [];
  let i = 0;
  while (i < s.length) {
    if (s[i] === '\x1b') {
      // consume an escape sequence
      let j = i + 1;
      if (s[j] === '[' || s[j] === 'O') {
        j++;
        while (j < s.length && !/[A-Za-z~]/.test(s[j])) j++;
        j++; // include final byte
        keys.push(s.slice(i, j));
        i = j;
      } else {
        keys.push('\x1b');
        i++;
      }
    } else {
      // handle surrogate pairs / multi-byte as single code points
      const cp = s.codePointAt(i)!;
      const ch = String.fromCodePoint(cp);
      keys.push(ch);
      i += ch.length;
    }
  }
  return keys;
}

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
}
