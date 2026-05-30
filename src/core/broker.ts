/**
 * ChatBroker — the local file broker that replaces happy-cli's cloud server.
 *
 * Routing model:
 *   - send()  appends one JSONL line (O_APPEND => atomic per line on local FS)
 *   - poll()  reads lines with id > the caller's cursor, then advances cursor
 *   - roster()/join()/heartbeat() maintain presence in members.json
 *
 * No daemon, no socket, no network. Every method is a pure file op, so any
 * runtime that can spawn a process to run the CLI (or import this module)
 * joins the same conversation. This is the "传呼机 + 通话口" substrate.
 */

import {
  appendFileSync,
  readFileSync,
  existsSync,
  readdirSync,
  statSync,
} from 'node:fs';
import {
  brokerRoot,
  ensureRoomDir,
  messagesPath,
  membersPath,
  cursorPath,
  roomDir,
  newMessageId,
  atomicWrite,
  assertSafeId,
} from './paths.js';
import type {
  ChatMessage,
  Member,
  MessageType,
  Priority,
  Presence,
  RosterEntry,
  PollResult,
} from './types.js';

/** A member is "idle" after this long without a heartbeat, "dead" after the next. */
export const IDLE_AFTER_MS = 90_000;
export const DEAD_AFTER_MS = 5 * 60_000;

export interface SendInput {
  room: string;
  from: string;
  content: string;
  shortContent?: string;
  type?: MessageType;
  mentions?: string[];
  priority?: Priority;
  fromDisplayName?: string;
  metadata?: Record<string, unknown>;
}

export interface JoinInput {
  room: string;
  id: string;
  role: string;
  displayName?: string;
  runtime?: string;
  bio?: string;
}

export interface PollOptions {
  /** Cursor from a previous poll; only messages strictly newer are returned. */
  since?: string;
  /** If true, only return messages that @mention this member. */
  mentionsOnly?: boolean;
  /** Max messages to return (default 100). */
  limit?: number;
  /** If false, do NOT advance the stored cursor (peek). Default true. */
  advance?: boolean;
}

export class ChatBroker {
  readonly root: string;

  constructor(root?: string) {
    this.root = brokerRoot(root);
  }

  private nowMs(): number {
    return Date.now();
  }

  // ── messages ───────────────────────────────────────────────────────────────

  private loadMessages(room: string): ChatMessage[] {
    const path = messagesPath(this.root, room);
    if (!existsSync(path)) return [];
    const raw = readFileSync(path, 'utf8');
    const byId = new Map<string, ChatMessage>();
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as ChatMessage;
        if (parsed && parsed.id) byId.set(parsed.id, parsed);
      } catch {
        // skip torn/partial line (extremely rare with O_APPEND single writes)
      }
    }
    // ids are time-sortable; sort ascending for stable ordering
    return [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  /** Append a message to the room log and return the stored record. */
  send(input: SendInput): ChatMessage {
    ensureRoomDir(this.root, input.room);
    const now = this.nowMs();
    const content = input.content;
    const msg: ChatMessage = {
      id: newMessageId(now),
      room: input.room,
      content,
      shortContent:
        input.shortContent ??
        (content.length > 150 ? content.slice(0, 150) + '…' : undefined),
      type: input.type ?? 'chat',
      timestamp: now,
      from: input.from,
      fromDisplayName: input.fromDisplayName,
      mentions:
        input.mentions && input.mentions.length > 0 ? input.mentions : undefined,
      priority: input.priority,
      metadata: input.metadata,
    };
    // O_APPEND single-line write is atomic across processes on local FS.
    appendFileSync(messagesPath(this.root, input.room), JSON.stringify(msg) + '\n', 'utf8');
    // Touch heartbeat so sending counts as activity.
    this.touch(input.room, input.from);
    return msg;
  }

  /** Recent history (most-recent-last), independent of any cursor. */
  history(room: string, opts: { limit?: number; before?: string } = {}): ChatMessage[] {
    const all = this.loadMessages(room);
    let end = all.length;
    if (opts.before) {
      const idx = all.findIndex((m) => m.id === opts.before);
      if (idx !== -1) end = idx;
    }
    const limit = opts.limit ?? 50;
    return all.slice(Math.max(0, end - limit), end);
  }

  // ── cursors (the "pager seen" mark) ──────────────────────────────────────────

  private readCursor(room: string, memberId: string): string {
    const path = cursorPath(this.root, room, memberId);
    if (!existsSync(path)) return '';
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as { cursor?: string };
      return parsed.cursor ?? '';
    } catch {
      return '';
    }
  }

  private writeCursor(room: string, memberId: string, cursor: string): void {
    ensureRoomDir(this.root, room);
    atomicWrite(cursorPath(this.root, room, memberId), JSON.stringify({ cursor }));
  }

  /**
   * Poll for messages newer than the caller's cursor (or `since` override).
   * Advances the stored cursor unless advance===false. Excludes the caller's
   * own messages so an agent never pages itself.
   */
  poll(room: string, memberId: string, opts: PollOptions = {}): PollResult {
    assertSafeId('member', memberId);
    const all = this.loadMessages(room);
    const since = opts.since ?? this.readCursor(room, memberId);
    const limit = opts.limit ?? 100;

    let fresh = all.filter((m) => (since ? m.id > since : true));
    fresh = fresh.filter((m) => m.from !== memberId);
    if (opts.mentionsOnly) {
      fresh = fresh.filter((m) => m.mentions?.includes(memberId));
    }
    const sliced = fresh.slice(0, limit);

    // Cursor advances past everything we *saw* (including filtered-out own msgs)
    // so we never re-scan them. Use the max id across the unfiltered tail.
    const sawUpTo = all.length > 0 ? all[all.length - 1].id : since;
    const cursor = sliced.length > 0 ? sliced[sliced.length - 1].id : sawUpTo;

    if (opts.advance !== false && cursor) {
      this.writeCursor(room, memberId, cursor);
    }
    // Polling is activity.
    this.touch(room, memberId, /*allowCreate*/ false);
    return { messages: sliced, cursor };
  }

  /** How many messages are waiting on this member's pager (unread, addressed or broadcast). */
  unreadCount(room: string, memberId: string, mentionsOnly = false): number {
    return this.poll(room, memberId, { mentionsOnly, advance: false, limit: 100000 })
      .messages.length;
  }

  // ── roster / presence ────────────────────────────────────────────────────────

  private loadMembers(room: string): Member[] {
    const path = membersPath(this.root, room);
    if (!existsSync(path)) return [];
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as Member[];
    } catch {
      return [];
    }
  }

  private saveMembers(room: string, members: Member[]): void {
    ensureRoomDir(this.root, room);
    atomicWrite(membersPath(this.root, room), JSON.stringify(members, null, 2));
  }

  /** Register/refresh a member. Idempotent: re-join updates the existing entry. */
  join(input: JoinInput): Member {
    assertSafeId('room', input.room);
    assertSafeId('member', input.id);
    ensureRoomDir(this.root, input.room);
    const now = this.nowMs();
    const members = this.loadMembers(input.room);
    const existing = members.find((m) => m.id === input.id);
    let member: Member;
    if (existing) {
      existing.role = input.role || existing.role;
      existing.displayName = input.displayName ?? existing.displayName;
      existing.runtime = input.runtime ?? existing.runtime;
      existing.bio = input.bio ?? existing.bio;
      existing.lastSeen = now;
      member = existing;
    } else {
      member = {
        id: input.id,
        role: input.role,
        displayName: input.displayName,
        runtime: input.runtime,
        bio: input.bio,
        joinedAt: now,
        lastSeen: now,
      };
      members.push(member);
    }
    this.saveMembers(input.room, members);
    return member;
  }

  /** Update lastSeen. If allowCreate is false, a no-op for unknown members. */
  touch(room: string, memberId: string, allowCreate = false): void {
    const members = this.loadMembers(room);
    const existing = members.find((m) => m.id === memberId);
    if (!existing) {
      if (!allowCreate) return;
      members.push({
        id: memberId,
        role: 'unknown',
        joinedAt: this.nowMs(),
        lastSeen: this.nowMs(),
      });
    } else {
      existing.lastSeen = this.nowMs();
    }
    this.saveMembers(room, members);
  }

  leave(room: string, memberId: string): void {
    const members = this.loadMembers(room).filter((m) => m.id !== memberId);
    this.saveMembers(room, members);
  }

  private presenceOf(member: Member, now: number): Presence {
    const age = now - member.lastSeen;
    if (age >= DEAD_AFTER_MS) return 'dead';
    if (age >= IDLE_AFTER_MS) return 'idle';
    return 'alive';
  }

  roster(room: string): RosterEntry[] {
    const now = this.nowMs();
    return this.loadMembers(room).map((m) => ({
      ...m,
      presence: this.presenceOf(m, now),
    }));
  }

  // ── rooms ────────────────────────────────────────────────────────────────────

  listRooms(): string[] {
    if (!existsSync(this.root)) return [];
    return readdirSync(this.root).filter((name) => {
      try {
        return statSync(roomDir(this.root, name)).isDirectory();
      } catch {
        return false;
      }
    });
  }
}
