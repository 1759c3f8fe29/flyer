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
