/**
 * Core types for the chat broker.
 *
 * Shapes are adapted from happy-cli's team message system but the routing
 * center is a LOCAL FILE BROKER (no cloud server, no runtime-specific SDK).
 * Any process that can read/write files can participate: Claude Code, Codex,
 * a bash script, anything.
 */

export type MessageType =
  | 'chat'
  | 'task-update'
  | 'notification'
  | 'help-needed'
  | 'handoff'
  | 'system';

export type Priority = 'normal' | 'high' | 'urgent';

/** A single message in a room's append-only log. */
export interface ChatMessage {
  /** Stable unique id (used for dedupe + read cursors). */
  id: string;
  /** Room (a.k.a. team/channel) this message belongs to. */
  room: string;
  /** Free-form body. */
  content: string;
  /** Optional short summary (<=150 chars) for dense logs. */
  shortContent?: string;
  /** Message classification. */
  type: MessageType;
  /** Unix ms. */
  timestamp: number;
  /** Sender member id (the role/handle that joined). */
  from: string;
  /** Optional human display name. */
  fromDisplayName?: string;
  /**
   * Targeted recipients (member ids). Empty/undefined => broadcast to room.
   * This is the "pager addressing": a @mention that makes a message land on a
   * specific member's pager instead of (or in addition to) the room feed.
   */
  mentions?: string[];
  priority?: Priority;
  /** Arbitrary extra metadata; never required by routing. */
  metadata?: Record<string, unknown>;
}

/** A member currently (or recently) present in a room. */
export interface Member {
  /** Stable member id within the room (e.g. "architect", "tester-1"). */
  id: string;
  /** Declared role/title. */
  role: string;
  /** Optional human display name. */
  displayName?: string;
  /** Free-form runtime tag: "claude-code" | "codex" | "shell" | ... */
  runtime?: string;
  /** Unix ms when the member joined. */
  joinedAt: number;
  /** Unix ms of last heartbeat / activity. */
  lastSeen: number;
  /** Optional self-description shown in the roster. */
  bio?: string;
}

export type Presence = 'alive' | 'idle' | 'dead';

/** Roster entry enriched with computed liveness. */
export interface RosterEntry extends Member {
  presence: Presence;
}

/** Result of a poll: new messages plus the cursor to pass next time. */
export interface PollResult {
  messages: ChatMessage[];
  /** Pass this back as `since` on the next poll to get only newer messages. */
  cursor: string;
}
