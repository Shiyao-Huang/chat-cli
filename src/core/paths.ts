/**
 * Filesystem layout + small id/atomic-write helpers shared by the broker.
 *
 *   <root>/<room>/messages.jsonl     append-only message log
 *   <root>/<room>/members.json       roster (presence)
 *   <root>/<room>/cursors/<id>.json  per-member read cursor (the "pager seen" mark)
 *
 * <root> defaults to $CHAT_HOME or ~/.chat-cli/rooms so that independent
 * processes on the same machine rendezvous on the same broker by default.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  mkdirSync,
  writeFileSync,
  renameSync,
  existsSync,
} from 'node:fs';
import { randomUUID, randomBytes } from 'node:crypto';

export function brokerRoot(explicit?: string): string {
  if (explicit) return explicit;
  if (process.env.CHAT_HOME) return process.env.CHAT_HOME;
  return join(homedir(), '.chat-cli', 'rooms');
}

/** Reject room/member ids that could escape the broker dir. */
const SAFE_ID = /^[A-Za-z0-9._-]{1,128}$/;
export function assertSafeId(kind: string, id: string): void {
  if (!SAFE_ID.test(id)) {
    throw new Error(
      `Invalid ${kind} id ${JSON.stringify(id)}: must match ${SAFE_ID} ` +
        `(letters, digits, dot, dash, underscore; 1-128 chars).`,
    );
  }
}

export function roomDir(root: string, room: string): string {
  assertSafeId('room', room);
  return join(root, room);
}

export function messagesPath(root: string, room: string): string {
  return join(roomDir(root, room), 'messages.jsonl');
}

export function membersPath(root: string, room: string): string {
  return join(roomDir(root, room), 'members.json');
}

export function cursorPath(root: string, room: string, memberId: string): string {
  assertSafeId('member', memberId);
  return join(roomDir(root, room), 'cursors', `${memberId}.json`);
}

export function ensureRoomDir(root: string, room: string): string {
  const dir = roomDir(root, room);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const cursors = join(dir, 'cursors');
  if (!existsSync(cursors)) mkdirSync(cursors, { recursive: true });
  return dir;
}

/** Monotonic-ish sortable message id: <ms>-<rand>. Sorts lexicographically. */
export function newMessageId(now: number): string {
  // zero-pad ms to 13 digits so string sort == time sort within this era
  const ms = String(now).padStart(13, '0');
  return `${ms}-${randomBytes(5).toString('hex')}`;
}

export function newUuid(): string {
  return randomUUID();
}

/** Atomic full-file write (temp + rename) to avoid torn reads on crash. */
export function atomicWrite(path: string, data: string): void {
  const tmp = `${path}.tmp-${randomBytes(4).toString('hex')}`;
  writeFileSync(tmp, data, 'utf8');
  renameSync(tmp, path);
}
