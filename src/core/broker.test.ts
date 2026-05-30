import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatBroker } from './index.js';

/**
 * Tests for the FROZEN ChatBroker file broker.
 *
 * Each test gets a fresh temp dir as the broker root so state never leaks
 * across tests. We never rely on wall-clock time transitions (idle/dead) and
 * never assume insertion order between two messages minted in the same
 * millisecond — instead we read back the broker's own returned ids, which are
 * the only ground truth for ordering.
 */

let root: string;
let broker: ChatBroker;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'chat-test-'));
  broker = new ChatBroker(root);
});

/**
 * Busy-wait until Date.now() advances to the next millisecond.
 *
 * Message ids are `<13-digit ms>-<random hex>`. Two sends within the SAME ms
 * therefore sort by their random suffix, not by insertion order. Where a test
 * asserts a specific ORDER (e.g. "messages newer than m1"), we tick the clock
 * between sends so each id's ms prefix is strictly increasing and string-sort
 * order == insertion order. The wait is sub-millisecond, so tests stay fast.
 */
function tick(): void {
  const start = Date.now();
  while (Date.now() === start) {
    /* spin to next ms */
  }
}

describe('ChatBroker', () => {
  it('1. send + poll: bob receives alice broadcast, cursor advances, second poll is empty', () => {
    broker.join({ room: 'r', id: 'alice', role: 'lead' });
    broker.join({ room: 'r', id: 'bob', role: 'worker' });

    const sent = broker.send({ room: 'r', from: 'alice', content: 'hello team' });

    const first = broker.poll('r', 'bob');
    expect(first.messages).toHaveLength(1);
    expect(first.messages[0].id).toBe(sent.id);
    expect(first.messages[0].content).toBe('hello team');
    expect(first.messages[0].from).toBe('alice');
    // cursor advanced to the message we just consumed
    expect(first.cursor).toBe(sent.id);

    // Nothing new since the cursor advanced.
    const second = broker.poll('r', 'bob');
    expect(second.messages).toHaveLength(0);
    // Cursor holds steady at the last seen id.
    expect(second.cursor).toBe(sent.id);
  });

  it('2. own messages are excluded from the sender poll', () => {
    broker.join({ room: 'r', id: 'alice', role: 'lead' });
    broker.send({ room: 'r', from: 'alice', content: 'note to self / room' });

    const mine = broker.poll('r', 'alice');
    expect(mine.messages).toHaveLength(0);
    // But a different member does see it.
    const bobSees = broker.poll('r', 'bob');
    expect(bobSees.messages).toHaveLength(1);
    expect(bobSees.messages[0].from).toBe('alice');
  });

  it('3. mentionsOnly returns only messages mentioning the member', () => {
    broker.send({ room: 'r', from: 'alice', content: 'broadcast, nobody pinged' });
    const pinged = broker.send({
      room: 'r',
      from: 'alice',
      content: 'hey @bob look here',
      mentions: ['bob'],
    });
    broker.send({
      room: 'r',
      from: 'alice',
      content: 'this one is for carol',
      mentions: ['carol'],
    });

    const bobMentions = broker.poll('r', 'bob', { mentionsOnly: true });
    expect(bobMentions.messages).toHaveLength(1);
    expect(bobMentions.messages[0].id).toBe(pinged.id);
    expect(bobMentions.messages[0].mentions).toEqual(['bob']);

    // Without the filter (fresh member, fresh cursor) bob sees all three broadcasts.
    const bobAll = broker.poll('r', 'bob2');
    expect(bobAll.messages).toHaveLength(3);
  });

  it('4. peek (advance:false) does not advance the cursor; a later real poll still delivers', () => {
    const sent = broker.send({ room: 'r', from: 'alice', content: 'pending page' });

    const peek = broker.poll('r', 'bob', { advance: false });
    expect(peek.messages).toHaveLength(1);
    expect(peek.messages[0].id).toBe(sent.id);

    // A second peek STILL sees it (cursor never moved).
    const peekAgain = broker.poll('r', 'bob', { advance: false });
    expect(peekAgain.messages).toHaveLength(1);
    expect(peekAgain.messages[0].id).toBe(sent.id);

    // A real poll consumes it...
    const real = broker.poll('r', 'bob');
    expect(real.messages).toHaveLength(1);
    expect(real.messages[0].id).toBe(sent.id);

    // ...and now it is gone.
    const after = broker.poll('r', 'bob');
    expect(after.messages).toHaveLength(0);
  });

  it("5. 'since' override returns only messages strictly newer than the given cursor", () => {
    const m1 = broker.send({ room: 'r', from: 'alice', content: 'first' });
    tick();
    const m2 = broker.send({ room: 'r', from: 'alice', content: 'second' });
    tick();
    const m3 = broker.send({ room: 'r', from: 'alice', content: 'third' });

    // Use m1's id as an explicit since: only m2 and m3 should come back.
    const newer = broker.poll('r', 'bob', { since: m1.id });
    const ids = newer.messages.map((m) => m.id);
    expect(ids).toContain(m2.id);
    expect(ids).toContain(m3.id);
    expect(ids).not.toContain(m1.id);
    expect(newer.messages).toHaveLength(2);

    // since the newest id => nothing newer.
    const none = broker.poll('r', 'bob', { since: m3.id });
    expect(none.messages).toHaveLength(0);
  });

  it('6. roster presence: a freshly-joined member is alive', () => {
    broker.join({ room: 'r', id: 'alice', role: 'lead', displayName: 'Alice' });
    const roster = broker.roster('r');
    expect(roster).toHaveLength(1);
    const alice = roster.find((m) => m.id === 'alice');
    expect(alice).toBeDefined();
    expect(alice!.presence).toBe('alive');
    expect(alice!.role).toBe('lead');
    expect(alice!.displayName).toBe('Alice');
  });

  it('7. history returns oldest..newest and respects limit', () => {
    const sentIds: string[] = [];
    for (let i = 0; i < 5; i++) {
      sentIds.push(broker.send({ room: 'r', from: 'alice', content: `m${i}` }).id);
      tick();
    }

    const all = broker.history('r');
    expect(all).toHaveLength(5);
    // Oldest..newest == insertion order (clock ticked between sends).
    const ids = all.map((m) => m.id);
    expect(ids).toEqual(sentIds);
    expect(all.map((m) => m.content)).toEqual(['m0', 'm1', 'm2', 'm3', 'm4']);
    // Also consistent with the broker's lexicographic sort key.
    expect(ids).toEqual([...ids].sort());

    // limit selects the most-recent tail, still oldest..newest within it.
    const tail = broker.history('r', { limit: 2 });
    expect(tail).toHaveLength(2);
    expect(tail.map((m) => m.content)).toEqual(['m3', 'm4']);
    // The tail is the last 2 ids of the full ordered list.
    expect(tail.map((m) => m.id)).toEqual(ids.slice(-2));
  });

  it('8. unreadCount reflects pending pages and drops to 0 after a poll', () => {
    broker.send({ room: 'r', from: 'alice', content: 'one' });
    broker.send({ room: 'r', from: 'alice', content: 'two' });

    expect(broker.unreadCount('r', 'bob')).toBe(2);
    // unreadCount is a peek: it must NOT consume the pages.
    expect(broker.unreadCount('r', 'bob')).toBe(2);

    // A real poll consumes them.
    const drained = broker.poll('r', 'bob');
    expect(drained.messages).toHaveLength(2);
    expect(broker.unreadCount('r', 'bob')).toBe(0);

    // mentionsOnly variant: only the addressed page counts.
    tick();
    broker.send({ room: 'r', from: 'alice', content: 'ping @bob', mentions: ['bob'] });
    broker.send({ room: 'r', from: 'alice', content: 'plain broadcast' });
    expect(broker.unreadCount('r', 'bob', true)).toBe(1);
    expect(broker.unreadCount('r', 'bob', false)).toBe(2);
  });

  it('9. listRooms includes a room after first send and after join', () => {
    expect(broker.listRooms()).not.toContain('viasend');
    broker.send({ room: 'viasend', from: 'alice', content: 'hi' });
    expect(broker.listRooms()).toContain('viasend');

    broker.join({ room: 'viajoin', id: 'alice', role: 'lead' });
    const rooms = broker.listRooms();
    expect(rooms).toContain('viajoin');
    expect(rooms).toContain('viasend');
  });

  it('10. invalid ids throw on join and poll; valid ids do not', () => {
    expect(() => broker.join({ room: 'bad id!', id: 'x', role: 'r' })).toThrow();
    expect(() => broker.join({ room: 'ok', id: 'bad/id', role: 'r' })).toThrow();
    expect(() => broker.poll('ok', '../escape')).toThrow();
    expect(() => broker.poll('ok', 'has space')).toThrow();
    // Sanity: a legal id is accepted.
    expect(() => broker.join({ room: 'ok', id: 'good.id-1_2', role: 'r' })).not.toThrow();
    expect(() => broker.poll('ok', 'good.id-1_2')).not.toThrow();
  });

  it('11. cross-instance durability: a second broker on the same root reads the first broker writes', () => {
    const writer = new ChatBroker(root);
    writer.join({ room: 'shared', id: 'alice', role: 'lead', runtime: 'shell' });
    const sent = writer.send({ room: 'shared', from: 'alice', content: 'durable line' });

    // A brand-new instance with NO shared in-memory state, same root on disk.
    const reader = new ChatBroker(root);
    expect(reader.root).toBe(writer.root);

    // Room is visible.
    expect(reader.listRooms()).toContain('shared');
    // Roster persisted.
    const roster = reader.roster('shared');
    expect(roster.find((m) => m.id === 'alice')?.runtime).toBe('shell');
    // History persisted.
    const hist = reader.history('shared');
    expect(hist.map((m) => m.id)).toContain(sent.id);
    // Poll through the second instance delivers the first instance's message.
    const polled = reader.poll('shared', 'bob');
    expect(polled.messages).toHaveLength(1);
    expect(polled.messages[0].id).toBe(sent.id);
    expect(polled.messages[0].content).toBe('durable line');

    // Cursor written by the reader is itself durable: a THIRD instance sees it consumed.
    const third = new ChatBroker(root);
    expect(third.poll('shared', 'bob').messages).toHaveLength(0);
  });
});
