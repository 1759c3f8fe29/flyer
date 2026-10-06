import { after, before, describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
} from '@firebase/rules-unit-testing';
import { get, ref, serverTimestamp, set, update } from 'firebase/database';

/**
 * Rules tests for database.rules.json.
 *
 * Every case here maps to a bug that shipped, and each one fails against the
 * rules as they were before the corresponding fix. That is the point: the P0s in
 * Part 2 of the master prompt were all "the client reads a path the rules
 * reject", which is invisible in review, invisible to `tsc`, and only shows up
 * on a real device against real rules. This file is the cheapest place to make
 * that class of bug loud.
 *
 * A note on what `assertFails` means here. In RTDB a *read* denial is often the
 * normal case rather than a fault — rules are evaluated against the data at the
 * path, so a node that does not exist yet has nothing to match a participant
 * check against and comes back denied rather than empty. Several tests below
 * assert exactly that, because two P0s came from code that expected `null`.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Uids are 28-char alphanumeric strings in the real thing, and the length is
 * load-bearing rather than cosmetic: `blockPairs` and the 1:1 chat rules test
 * membership with `$chatId.contains(auth.uid)`, which is a substring match. A
 * short uid like "alice" could appear inside an unrelated chat id by accident
 * and would make these tests pass for the wrong reason.
 */
const ALICE = 'aaaaaaaaaaaaaaaaaaaaaaaaaaa1';
const BOB = 'bbbbbbbbbbbbbbbbbbbbbbbbbbb2';
const CAROL = 'ccccccccccccccccccccccccccc3';

/** Mirrors chatIdFor in src/config/env.ts — the sorted uid join. */
const chatIdFor = (a, b) => [a, b].sort().join('_');
const AB = chatIdFor(ALICE, BOB);

const profile = (uid, name) => ({
  uid,
  name,
  email: `${name.toLowerCase()}@example.com`,
  createdAt: 1,
});

let testEnv;

before(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: 'flyer-rules-test',
    database: {
      rules: readFileSync(join(root, 'database.rules.json'), 'utf8'),
      host: '127.0.0.1',
      port: 9000,
    },
  });
});

after(async () => {
  await testEnv?.cleanup();
});

/** Seed state that the rules would not let a client write directly. */
async function seed(fn) {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await fn(ctx.database());
  });
}

async function reset() {
  await testEnv.clearDatabase();
  await seed(async (db) => {
    await set(ref(db, `users/${ALICE}`), profile(ALICE, 'Alice'));
    await set(ref(db, `users/${BOB}`), profile(BOB, 'Bob'));
    await set(ref(db, `users/${CAROL}`), profile(CAROL, 'Carol'));
    await set(ref(db, 'usernames/alice'), ALICE);
    await set(ref(db, 'usernames/bob'), BOB);
  });
}

const asAlice = () => testEnv.authenticatedContext(ALICE).database();
const asBob = () => testEnv.authenticatedContext(BOB).database();
const asCarol = () => testEnv.authenticatedContext(CAROL).database();

/* ------------------------------------------------------------------ *
 * BUG-01 — every contact request failed
 * ------------------------------------------------------------------ */

describe('BUG-01 · contact requests', () => {
  before(reset);

  it('denies reading another user\'s block list', async () => {
    // The read ContactService.sendRequest used to make. It is *supposed* to
    // fail; the bug was that the caller put it in a Promise.all and let the
    // rejection take down the whole send.
    await assertFails(get(ref(asAlice(), `blocks/${BOB}/${ALICE}`)));
  });

  it('allows reading your own block list', async () => {
    await assertSucceeds(get(ref(asAlice(), `blocks/${ALICE}/${BOB}`)));
  });

  it('allows a request when nobody has blocked anybody', async () => {
    await assertSucceeds(
      update(ref(asAlice()), {
        [`contactRequests/${BOB}/${ALICE}`]: { uid: ALICE, createdAt: 1 },
        [`sentRequests/${ALICE}/${BOB}`]: { uid: BOB, createdAt: 1 },
      })
    );
  });

  it('denies a request when the recipient has blocked the sender', async () => {
    await reset();
    await seed(async (db) => {
      await set(ref(db, `blocks/${BOB}/${ALICE}`), true);
    });

    // The server enforcement the client-side probe was standing in for. This is
    // why removing that probe lost nothing.
    await assertFails(
      update(ref(asAlice()), {
        [`contactRequests/${BOB}/${ALICE}`]: { uid: ALICE, createdAt: 1 },
        [`sentRequests/${ALICE}/${BOB}`]: { uid: BOB, createdAt: 1 },
      })
    );
  });

  it('denies a request when the sender has blocked the recipient', async () => {
    await reset();
    await seed(async (db) => {
      await set(ref(db, `blocks/${ALICE}/${BOB}`), true);
    });

    await assertFails(
      update(ref(asAlice()), {
        [`contactRequests/${BOB}/${ALICE}`]: { uid: ALICE, createdAt: 1 },
        [`sentRequests/${ALICE}/${BOB}`]: { uid: BOB, createdAt: 1 },
      })
    );
  });
});

/* ------------------------------------------------------------------ *
 * BUG-02 — the first chat with any person failed
 * ------------------------------------------------------------------ */

describe('BUG-02 · first chat creation', () => {
  before(reset);

  it('denies reading a chat that does not exist yet', async () => {
    // The exact probe ensureChat used to make unguarded. `chats/$chatId/.read`
    // requires being in `participants`, and an absent chat has none — so this is
    // a denial, never a null. Treating it as an error meant the first chat with
    // anyone could never be created.
    await assertFails(get(ref(asAlice(), `chats/${AB}`)));
  });

  it('allows creating that chat', async () => {
    await assertSucceeds(
      update(ref(asAlice()), {
        [`chats/${AB}`]: {
          participants: { [ALICE]: true, [BOB]: true },
          lastTimestamp: serverTimestamp(),
          unread: { [ALICE]: 0, [BOB]: 0 },
        },
        [`userChats/${ALICE}/${AB}`]: { lastTimestamp: serverTimestamp() },
        [`userChats/${BOB}/${AB}`]: { lastTimestamp: serverTimestamp() },
      })
    );
  });

  it('allows both participants to read it once it exists', async () => {
    await assertSucceeds(get(ref(asAlice(), `chats/${AB}`)));
    await assertSucceeds(get(ref(asBob(), `chats/${AB}`)));
  });

  it('denies an outsider reading it', async () => {
    await assertFails(get(ref(asCarol(), `chats/${AB}`)));
  });

  it('denies creating a 1:1 chat you are not part of', async () => {
    await assertFails(
      set(ref(asCarol(), `chats/${AB}`), {
        participants: { [ALICE]: true, [BOB]: true },
        lastTimestamp: serverTimestamp(),
      })
    );
  });

  it('denies re-creating a chat that already exists', async () => {
    // The lost-create race ensureChat swallows: by the time this fails the chat
    // is present, which is all the caller wanted.
    await assertFails(
      set(ref(asAlice(), `chats/${AB}`), {
        participants: { [ALICE]: true, [BOB]: true },
        lastTimestamp: serverTimestamp(),
      })
    );
  });
});

/* ------------------------------------------------------------------ *
 * BUG-03 — blocking did not block anything
 * ------------------------------------------------------------------ */

describe('BUG-03 · blocking is enforced server-side', () => {
  const message = () => ({
    senderId: ALICE,
    type: 'text',
    text: 'hello',
    timestamp: serverTimestamp(),
  });

  before(async () => {
    await reset();
    await seed(async (db) => {
      await set(ref(db, `chats/${AB}`), {
        participants: { [ALICE]: true, [BOB]: true },
        lastTimestamp: 1,
      });
    });
  });

  it('allows a message when no block exists', async () => {
    await assertSucceeds(set(ref(asAlice(), `messages/${AB}/m1`), message()));
  });

  it('lets a blocker write their own half of the pair', async () => {
    await assertSucceeds(
      update(ref(asBob()), {
        [`blocks/${BOB}/${ALICE}`]: true,
        [`blockPairs/${AB}/${BOB}`]: true,
      })
    );
  });

  it('denies the blocked user sending into that chat', async () => {
    // The whole point. Before `blockPairs` the word "blocks" appeared nowhere in
    // the message write rule, so this write succeeded and the message arrived.
    await assertFails(set(ref(asAlice(), `messages/${AB}/m2`), message()));
  });

  it('denies the blocker sending too, so blocking is not a one-way mute', async () => {
    await assertFails(
      set(ref(asBob(), `messages/${AB}/m3`), {
        senderId: BOB,
        type: 'text',
        text: 'hello',
        timestamp: serverTimestamp(),
      })
    );
  });

  it('lets both parties read the pair node', async () => {
    // Readable by both is what makes it usable as enforcement: a rule may only
    // consult what the writer could read.
    await assertSucceeds(get(ref(asAlice(), `blockPairs/${AB}`)));
    await assertSucceeds(get(ref(asBob(), `blockPairs/${AB}`)));
  });

  it('hides the pair node from everyone else', async () => {
    await assertFails(get(ref(asCarol(), `blockPairs/${AB}`)));
  });

  it('still hides the private block list from the blocked party', async () => {
    // Direction stays secret: Alice can tell the conversation is blocked, but
    // not by whom, without reading a list only Bob can read.
    await assertFails(get(ref(asAlice(), `blocks/${BOB}/${ALICE}`)));
  });

  it('denies writing a pair entry under somebody else\'s uid', async () => {
    await assertFails(set(ref(asAlice(), `blockPairs/${AB}/${BOB}`), true));
  });

  it('denies writing a pair entry for a chat you are not in', async () => {
    const bc = chatIdFor(BOB, CAROL);
    await assertFails(set(ref(asAlice(), `blockPairs/${bc}/${ALICE}`), true));
  });

  it('allows sending again once unblocked', async () => {
    await assertSucceeds(
      update(ref(asBob()), {
        [`blocks/${BOB}/${ALICE}`]: null,
        [`blockPairs/${AB}/${BOB}`]: null,
      })
    );
    await assertSucceeds(set(ref(asAlice(), `messages/${AB}/m4`), message()));
  });
});

/* ------------------------------------------------------------------ *
 * BUG-37 — blocking did not block calls
 * ------------------------------------------------------------------ */

describe('BUG-37 · blocking is enforced on calls', () => {
  const call = (caller, callee) => ({
    callerId: caller,
    calleeId: callee,
    type: 'voice',
    state: 'ringing',
    createdAt: 1,
  });
  const pointer = (callId, caller) => ({
    callId,
    callerId: caller,
    type: 'voice',
    createdAt: 1,
  });

  before(async () => {
    await reset();
  });

  it('allows a call when no block exists', async () => {
    await assertSucceeds(set(ref(asAlice(), 'calls/c1'), call(ALICE, BOB)));
    await assertSucceeds(set(ref(asAlice(), `incoming/${BOB}/c1`), pointer('c1', ALICE)));
  });

  it('denies the blocked user creating a call node', async () => {
    await seed(async (db) => {
      await set(ref(db, `blocks/${BOB}/${ALICE}`), true);
      await set(ref(db, `blockPairs/${AB}/${BOB}`), true);
    });
    // Same pair id the message rule consults, in the caller->callee order and
    // the reverse — exactly one of the two joins can exist.
    await assertFails(set(ref(asAlice(), 'calls/c2'), call(ALICE, BOB)));
  });

  it('denies the blocked user writing the ring pointer', async () => {
    await assertFails(set(ref(asAlice(), `incoming/${BOB}/c2`), pointer('c2', ALICE)));
  });

  it('denies the blocker calling too, so blocking is not one-way', async () => {
    await assertFails(set(ref(asBob(), 'calls/c3'), call(BOB, ALICE)));
  });

  it('still lets the callee clear a stale pointer', async () => {
    await assertSucceeds(set(ref(asBob(), `incoming/${BOB}/c1`), null));
  });

  it('allows calling again once unblocked', async () => {
    await seed(async (db) => {
      await set(ref(db, `blocks/${BOB}/${ALICE}`), null);
      await set(ref(db, `blockPairs/${AB}/${BOB}`), null);
    });
    await assertSucceeds(set(ref(asAlice(), 'calls/c4'), call(ALICE, BOB)));
    await assertSucceeds(set(ref(asAlice(), `incoming/${BOB}/c4`), pointer('c4', ALICE)));
  });
});

/* ------------------------------------------------------------------ *
 * BUG-04 — any authenticated user could dump the user table
 * ------------------------------------------------------------------ */

describe('BUG-04 · the user table is not enumerable', () => {
  before(reset);

  it('denies reading the whole users node', async () => {
    // What fetchAllUsers did. `users/.read` was `auth != null`, so an account
    // made seconds ago could download every user, email and last-seen.
    await assertFails(get(ref(asAlice(), 'users')));
  });

  it('allows reading a single user row by uid', async () => {
    // The half that has to keep working: every chat participant, group member
    // and incoming request is resolved this way.
    await assertSucceeds(get(ref(asAlice(), `users/${BOB}`)));
  });

  it('denies enumerating the usernames node', async () => {
    // The other door into the same table: handle -> uid for every handle, then
    // per-uid profile reads to reassemble it.
    await assertFails(get(ref(asAlice(), 'usernames')));
  });

  it('allows resolving a single handle somebody gave you', async () => {
    await assertSucceeds(get(ref(asAlice(), 'usernames/bob')));
  });

  it('denies an unauthenticated read of a user row', async () => {
    const anon = testEnv.unauthenticatedContext().database();
    await assertFails(get(ref(anon, `users/${BOB}`)));
  });

  it('denies writing to another user\'s profile', async () => {
    await assertFails(set(ref(asAlice(), `users/${BOB}/name`), 'Not Bob'));
  });
});

/* ------------------------------------------------------------------ *
 * BUG-33 — the rules file did not parse at all
 * ------------------------------------------------------------------ */

describe('BUG-33 · the email rule accepts what Auth produces', () => {
  before(reset);

  /**
   * The parse failure itself is caught by every other test in this file: an
   * unparseable rules file makes `initializeTestEnvironment` throw, so the suite
   * cannot even start. What needs pinning separately is the replacement's
   * *behaviour*, since swapping a whitespace denylist for an atext allowlist is
   * the kind of change that silently narrows what it accepts.
   *
   * The awkward entries are the point. `/` and the backtick are legal atext and
   * exercise the two escapes whose meaning inside a character class is not
   * obvious — a bare `/` would close the regex literal, and if `\/` were read as
   * backslash-then-slash the class would be wrong in a way no ordinary address
   * would reveal.
   */
  const write = (value) => set(ref(asAlice(), `users/${ALICE}/email`), value);

  for (const good of [
    'a@b.co',
    'first.last+tag@sub.example.com',
    "o'brien@example.com",
    'x_y-z@mail-server.co.uk',
    'UPPER.Case@Example.COM',
    'has!hash#and$cash%@example.museum',
    'slash/in/local@example.com',
    'back`tick@example.com',
    'brace{pipe|brace}@example.com',
    // AuthManager writes this when the provider hands back no address.
    '',
  ]) {
    it(`accepts ${JSON.stringify(good)}`, async () => {
      await assertSucceeds(write(good));
    });
  }

  for (const bad of [
    'no-at-sign',
    'a@b',
    'a@.co',
    'a@b.',
    '@b.co',
    // Whitespace, the thing the original `\s` was reaching for. The trailing
    // newline matters on its own: in some dialects `$` matches before it.
    'a b@c.co',
    'a\tb@c.co',
    'a\nb@c.co',
    'a@ b.co',
    'a@b.co\n',
  ]) {
    it(`rejects ${JSON.stringify(bad)}`, async () => {
      await assertFails(write(bad));
    });
  }

  it('still enforces the length cap', async () => {
    await assertFails(write(`${'a'.repeat(250)}@example.com`));
  });

  it('still rejects a non-string', async () => {
    await assertFails(write(42));
  });
});

/* ------------------------------------------------------------------ *
 * Private subtrees — Part 0 rule 3, asserted rather than assumed
 * ------------------------------------------------------------------ */

describe('owner-only subtrees', () => {
  before(reset);

  for (const node of [
    'contacts',
    'contactRequests',
    'sentRequests',
    'starred',
    'userChats',
    'fcmTokens',
    'callHistory',
  ]) {
    it(`denies reading another user's ${node}`, async () => {
      await assertFails(get(ref(asAlice(), `${node}/${BOB}`)));
    });

    it(`allows reading your own ${node}`, async () => {
      await assertSucceeds(get(ref(asAlice(), `${node}/${ALICE}`)));
    });
  }
});

/* ------------------------------------------------------------------ *
 * BUG-10 — edit and delete-for-everyone expire
 * ------------------------------------------------------------------ */

describe('BUG-10 · edit/delete time window', () => {
  const OLD = Date.now() - 3 * 24 * 60 * 60 * 1000;

  before(async () => {
    await reset();
    await seed(async (db) => {
      await set(ref(db, `chats/${AB}`), {
        participants: { [ALICE]: true, [BOB]: true },
        lastTimestamp: 1,
      });
      await set(ref(db, `messages/${AB}/old`), {
        senderId: ALICE,
        type: 'text',
        text: 'ancient',
        timestamp: OLD,
      });
      await set(ref(db, `messages/${AB}/fresh`), {
        senderId: ALICE,
        type: 'text',
        text: 'just now',
        timestamp: Date.now(),
      });
    });
  });

  it('allows editing a fresh message', async () => {
    await assertSucceeds(update(ref(asAlice(), `messages/${AB}/fresh`), { text: 'edited' }));
  });

  it('denies editing a 3-day-old message', async () => {
    await assertFails(update(ref(asAlice(), `messages/${AB}/old`), { text: 'rewritten' }));
  });

  it('denies deleting a 3-day-old message for everyone', async () => {
    await assertFails(update(ref(asAlice(), `messages/${AB}/old`), { deleted: true }));
  });

  it('allows deleting a fresh message for everyone', async () => {
    await assertSucceeds(update(ref(asAlice(), `messages/${AB}/fresh`), { deleted: true }));
  });

  it('still allows scrubbing the payload of an old message', async () => {
    // Null writes skip .validate and the time-windowed leaves exempt them, so
    // delete-for-everyone keeps wiping content after the flag itself expires.
    await assertSucceeds(
      update(ref(asAlice(), `messages/${AB}/old`), { text: null, mediaUrl: null })
    );
  });

  it('denies the peer editing at any age', async () => {
    await assertFails(update(ref(asBob(), `messages/${AB}/fresh`), { text: 'hijacked' }));
  });
});

/* ------------------------------------------------------------------ *
 * BUG-25 — media payloads are host-pinned and bounded
 * ------------------------------------------------------------------ */

describe('BUG-25 · media validation', () => {
  const image = (overrides = {}) => ({
    senderId: ALICE,
    type: 'image',
    timestamp: serverTimestamp(),
    mediaUrl: 'https://res.cloudinary.com/demo/image/upload/x.jpg',
    width: 800,
    height: 600,
    ...overrides,
  });

  before(async () => {
    await reset();
    await seed(async (db) => {
      await set(ref(db, `chats/${AB}`), {
        participants: { [ALICE]: true, [BOB]: true },
        lastTimestamp: 1,
      });
    });
  });

  it('allows a Cloudinary-hosted image', async () => {
    await assertSucceeds(set(ref(asAlice(), `messages/${AB}/ok`), image()));
  });

  it('denies a bubble pointing at a third-party host', async () => {
    await assertFails(
      set(ref(asAlice(), `messages/${AB}/evil`), image({ mediaUrl: 'https://evil.example/x.jpg' }))
    );
  });

  it('denies non-positive dimensions', async () => {
    await assertFails(set(ref(asAlice(), `messages/${AB}/w0`), image({ width: 0 })));
    await assertFails(set(ref(asAlice(), `messages/${AB}/hn`), image({ height: -5 })));
  });

  it('denies absurd dimensions and durations', async () => {
    await assertFails(set(ref(asAlice(), `messages/${AB}/wbig`), image({ width: 20000 })));
    await assertFails(
      set(
        ref(asAlice(), `messages/${AB}/long`),
        image({ type: 'audio', mediaUrl: 'https://res.cloudinary.com/demo/video/upload/x.mp3', durationMs: 99999999 })
      )
    );
  });
});

/* ------------------------------------------------------------------ *
 * BUG-26 — `type` is sender-pinned
 * ------------------------------------------------------------------ */

describe('BUG-26 · message type is pinned to the sender', () => {
  before(async () => {
    await reset();
    await seed(async (db) => {
      await set(ref(db, `chats/${AB}`), {
        participants: { [ALICE]: true, [BOB]: true },
        lastTimestamp: 1,
      });
      await set(ref(db, `messages/${AB}/m1`), {
        senderId: ALICE,
        type: 'text',
        text: 'hello',
        timestamp: Date.now(),
      });
    });
  });

  it('denies the peer flipping the type', async () => {
    await assertFails(update(ref(asBob(), `messages/${AB}/m1`), { type: 'image' }));
  });
});

/* ------------------------------------------------------------------ *
 * N-02 — delivered receipts mirror seen receipts
 * ------------------------------------------------------------------ */

describe('N-02 · deliveredTo receipts', () => {
  before(async () => {
    await reset();
    await seed(async (db) => {
      await set(ref(db, `chats/${AB}`), {
        participants: { [ALICE]: true, [BOB]: true },
        lastTimestamp: 1,
      });
      await set(ref(db, `messages/${AB}/m1`), {
        senderId: ALICE,
        type: 'text',
        text: 'hello',
        timestamp: Date.now(),
      });
    });
  });

  it('lets the recipient mark delivery on their own key', async () => {
    await assertSucceeds(set(ref(asBob(), `messages/${AB}/m1/deliveredTo/${BOB}`), 1));
  });

  it('denies writing another device\'s key', async () => {
    await assertFails(set(ref(asAlice(), `messages/${AB}/m1/deliveredTo/${BOB}`), 1));
  });

  it('denies outsiders marking delivery', async () => {
    await assertFails(set(ref(asCarol(), `messages/${AB}/m1/deliveredTo/${CAROL}`), 1));
  });
});

/* ------------------------------------------------------------------ *
 * BUG-14 — join order lives in memberSince
 * ------------------------------------------------------------------ */

describe('BUG-14 · memberSince seniority', () => {
  const G = 'group1';

  before(async () => {
    await reset();
    await seed(async (db) => {
      await set(ref(db, `chats/${G}`), {
        participants: { [ALICE]: true, [BOB]: true },
        admins: { [ALICE]: true },
        isGroup: true,
        lastTimestamp: 1,
      });
    });
  });

  it('lets an admin record a join', async () => {
    await assertSucceeds(set(ref(asAlice(), `memberSince/${G}/${BOB}`), 100));
  });

  it('denies a non-admin recording joins', async () => {
    await assertFails(set(ref(asBob(), `memberSince/${G}/${CAROL}`), 200));
  });

  it('lets a member clear their own entry on leave', async () => {
    await assertSucceeds(set(ref(asBob(), `memberSince/${G}/${BOB}`), null));
  });

  it('lets participants read the node', async () => {
    await assertSucceeds(get(ref(asBob(), `memberSince/${G}`)));
  });

  it('hides the node from outsiders', async () => {
    await assertFails(get(ref(asCarol(), `memberSince/${G}`)));
  });

  it('accepts the optional hidePreview privacy flag', async () => {
    await assertSucceeds(
      set(ref(asAlice(), `users/${ALICE}/privacy`), {
        showLastSeen: true,
        showPhoto: true,
        showAbout: true,
        readReceipts: true,
        hidePreview: true,
      })
    );
  });
});
