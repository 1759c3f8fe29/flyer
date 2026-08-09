import { firebase } from '@react-native-firebase/database';
import type {
  FirebaseDatabaseTypes,
} from '@react-native-firebase/database';
import { Env } from '@/src/config/env';

/**
 * FirebaseService — the only module that talks to the Realtime Database
 * directly. Everything else goes through these helpers so that path
 * construction lives in exactly one place and listener teardown is uniform.
 */

/**
 * The database handle, created on first use rather than at import time.
 *
 * This used to run at module scope, and it is the single worst place in the app
 * to put it. Three separate things here throw, all of them before React mounts,
 * so there is no error boundary and no red box — the process just dies between
 * the splash screen and the first frame:
 *
 *   - `firebase.app()` throws "No Firebase App '[DEFAULT]' has been created" if
 *     the native module has not finished initialising.
 *   - `database(url)` throws on a malformed URL, which includes the empty string
 *     `env.ts` returns for a missing EXPO_PUBLIC_RTDB_URL.
 *   - `setPersistenceEnabled` throws "must be made before any other usage of
 *     FirebaseDatabase instance" if anything touched the database first. On a
 *     cold start from a push that is exactly what happens: index.js imports
 *     BackgroundTaskManager (which calls `messaging()`) before the router, and
 *     the handler can reach the database before this module is even evaluated.
 *
 * Deferring to first call fixes all three: by then native init has completed,
 * and the persistence call is wrapped because failing to enable a disk cache is
 * not worth losing the app over.
 */
let dbInstance: FirebaseDatabaseTypes.Module | null = null;

function getDb(): FirebaseDatabaseTypes.Module {
  if (dbInstance) return dbInstance;

  // An empty rtdbUrl means the env var is missing; the default app's configured
  // URL from google-services.json is a better guess than a certain throw.
  let instance: FirebaseDatabaseTypes.Module;
  try {
    instance = Env.rtdbUrl ? firebase.app().database(Env.rtdbUrl) : firebase.database();
  } catch (e) {
    console.warn('[Flyer/db] could not open the configured RTDB URL, falling back', e);
    instance = firebase.database();
  }

  // Cache reads to disk so a cold start renders the last known chat list before
  // the socket connects. Non-fatal: throws if the database was already used.
  try {
    instance.setPersistenceEnabled(true);
  } catch (e) {
    console.warn('[Flyer/db] disk persistence unavailable', e);
  }

  dbInstance = instance;
  return instance;
}

/**
 * Proxy kept so the ~40 `db.ref(...)` call sites below need no edit. Every
 * property access routes through `getDb()`, so the handle is still created
 * lazily on the first real use.
 */
const db = new Proxy({} as FirebaseDatabaseTypes.Module, {
  get(_target, prop, receiver) {
    const real = getDb() as unknown as Record<string | symbol, unknown>;
    const value = Reflect.get(real, prop, receiver);
    return typeof value === 'function' ? value.bind(real) : value;
  },
});

export type Ref = FirebaseDatabaseTypes.Reference;
/**
 * A filtered/ordered view of a path. `ref(p).orderByChild(...).limitToLast(n)`
 * returns this, not a Reference — subscribing is all the listeners below need,
 * so they accept either.
 */
export type Query = FirebaseDatabaseTypes.Query;
export type Snapshot = FirebaseDatabaseTypes.DataSnapshot;
export type Unsubscribe = () => void;

export const ServerValue = firebase.database.ServerValue;

/** Path builders. Keeping them here prevents drift from database.rules.json. */
export const Paths = {
  user: (uid: string) => `users/${uid}`,
  users: () => 'users',
  userPresence: (uid: string) => `users/${uid}/online`,
  userLastSeen: (uid: string) => `users/${uid}/lastSeen`,
  userTokens: (uid: string) => `fcmTokens/${uid}`,
  userToken: (uid: string, token: string) => `fcmTokens/${uid}/${token}`,

  // Reverse index for handle lookup and, more importantly, uniqueness: RTDB has
  // no unique constraint, so the claim is the write to this node succeeding.
  usernames: () => 'usernames',
  username: (handle: string) => `usernames/${handle}`,
  userUsername: (uid: string) => `users/${uid}/username`,

  chat: (chatId: string) => `chats/${chatId}`,
  chats: () => 'chats',
  userChats: (uid: string) => `userChats/${uid}`,
  userChat: (uid: string, chatId: string) => `userChats/${uid}/${chatId}`,
  unread: (chatId: string, uid: string) => `chats/${chatId}/unread/${uid}`,
  muted: (chatId: string, uid: string) => `chats/${chatId}/mutedBy/${uid}`,
  clearedAt: (chatId: string, uid: string) => `chats/${chatId}/clearedAt/${uid}`,

  // Pin and archive are personal preferences, not shared chat state: they live
  // under the owner's private userChats index so a peer can neither read nor
  // change them. (chats/$chatId seals unknown children with $other:false.)
  pinned: (uid: string, chatId: string) => `userChats/${uid}/${chatId}/pinned`,
  archived: (uid: string, chatId: string) => `userChats/${uid}/${chatId}/archived`,

  messages: (chatId: string) => `messages/${chatId}`,
  message: (chatId: string, messageId: string) => `messages/${chatId}/${messageId}`,
  reaction: (chatId: string, messageId: string, uid: string) =>
    `messages/${chatId}/${messageId}/reactions/${uid}`,
  seenBy: (chatId: string, messageId: string, uid: string) =>
    `messages/${chatId}/${messageId}/seenBy/${uid}`,

  typing: (chatId: string) => `typing/${chatId}`,
  typingUser: (chatId: string, uid: string) => `typing/${chatId}/${uid}`,

  starred: (uid: string) => `starred/${uid}`,
  starredItem: (uid: string, chatId: string, messageId: string) =>
    `starred/${uid}/${chatId}__${messageId}`,

  blocks: (uid: string) => `blocks/${uid}`,
  block: (uid: string, otherUid: string) => `blocks/${uid}/${otherUid}`,

  // Enforcement mirror for 1:1 blocking. `blocks` is owner-only, so the message
  // write rule cannot consult it; this node is keyed by chat id and readable by
  // both participants. See the `blockPairs` comment in database.rules.json.
  blockPairs: (chatId: string) => `blockPairs/${chatId}`,
  blockPair: (chatId: string, uid: string) => `blockPairs/${chatId}/${uid}`,

  reports: () => 'reports',

  call: (callId: string) => `calls/${callId}`,
  callState: (callId: string) => `calls/${callId}/state`,
  callOffer: (callId: string) => `calls/${callId}/offer`,
  callAnswer: (callId: string) => `calls/${callId}/answer`,
  callCandidates: (callId: string, uid: string) => `calls/${callId}/candidates/${uid}`,
  incoming: (uid: string) => `incoming/${uid}`,
  callHistory: (uid: string) => `callHistory/${uid}`,
  callHistoryItem: (uid: string, callId: string) => `callHistory/${uid}/${callId}`,

  // Contacts are mutual once accepted; requests are one-directional until then.
  contacts: (uid: string) => `contacts/${uid}`,
  contact: (uid: string, contactUid: string) => `contacts/${uid}/${contactUid}`,
  requests: (uid: string) => `contactRequests/${uid}`,
  request: (uid: string, fromUid: string) => `contactRequests/${uid}/${fromUid}`,
  sentRequests: (uid: string) => `sentRequests/${uid}`,
  sentRequest: (uid: string, toUid: string) => `sentRequests/${uid}/${toUid}`,

  connected: () => '.info/connected',
} as const;

export const ref = (path: string): Ref => db.ref(path);

export function serverTimestamp(): object {
  return ServerValue.TIMESTAMP;
}

/** What a listener was doing when the database cancelled it. */
export interface ListenerError {
  /** Full path, not the leaf key — a bare `chatId` is unattributable in logs. */
  path: string;
  event: 'value' | 'child_added';
  error: Error;
}

type ListenerErrorObserver = (info: ListenerError) => void;

const listenerErrorObservers = new Set<ListenerErrorObserver>();

/**
 * Subscribe to *every* listener cancellation in the app.
 *
 * RTDB does not retry a cancelled listener: when the server rejects a read
 * (permission denied on a stale rule, a path the signed-out user no longer
 * owns) the callback fires once and the subscription is dead. Logging that and
 * moving on is why this app could show a permanently empty chat list with no
 * indication anything was wrong. Anything that renders connection state — a
 * banner, a retry affordance, crash reporting — subscribes here.
 */
export function onListenerError(observer: ListenerErrorObserver): Unsubscribe {
  listenerErrorObservers.add(observer);
  return () => {
    listenerErrorObservers.delete(observer);
  };
}

/**
 * The absolute path of a Ref or Query. `.key` is only the leaf, so a listener on
 * `messages/{chatId}` logged as `{chatId}` cannot be told apart from a listener
 * on `chats/{chatId}`. `toString()` is a full URL; the origin is noise.
 */
function describePath(path: string | Ref | Query, r: Ref | Query): string {
  if (typeof path === 'string') return path;
  try {
    return r.ref.toString().replace(/^https?:\/\/[^/]+\//, '');
  } catch {
    return r.ref.key ?? '(unknown)';
  }
}

function reportListenerError(
  path: string,
  event: ListenerError['event'],
  error: Error,
  onError?: (e: Error) => void
): void {
  console.warn(`[Flyer/rtdb] ${event} listener cancelled at ${path}`, error);
  onError?.(error);

  for (const observer of listenerErrorObservers) {
    // An observer that throws must not take down the other observers, and it
    // certainly must not surface as an unhandled error inside a DB callback.
    try {
      observer({ path, event, error });
    } catch (e) {
      console.warn('[Flyer/rtdb] listener-error observer threw', e);
    }
  }
}

/**
 * Subscribe to a path; returns an unsubscribe you can call unconditionally.
 *
 * Pass a Query only if you keep *this* unsubscribe alongside it: `off` detaches
 * by (query object, handler) pair, so calling an old unsubscribe after rebuilding
 * an equivalent query leaves the original listener attached and leaking.
 */
export function onValue(
  path: string | Ref | Query,
  cb: (snap: Snapshot) => void,
  onError?: (e: Error) => void
): Unsubscribe {
  const r = typeof path === 'string' ? ref(path) : path;
  const label = describePath(path, r);
  const handler = r.on(
    'value',
    (snap) => cb(snap),
    (err) => reportListenerError(label, 'value', err as Error, onError)
  );
  return () => r.off('value', handler);
}

export function onChildAdded(
  path: string | Ref | Query,
  cb: (snap: Snapshot) => void,
  onError?: (e: Error) => void
): Unsubscribe {
  const r = typeof path === 'string' ? ref(path) : path;
  const label = describePath(path, r);
  const handler = r.on(
    'child_added',
    (snap) => cb(snap),
    (err) => reportListenerError(label, 'child_added', err as Error, onError)
  );
  return () => r.off('child_added', handler);
}

export async function readOnce<T = unknown>(path: string): Promise<T | null> {
  const snap = await ref(path).once('value');
  return (snap.val() as T) ?? null;
}

/**
 * Keep a path warm in the disk cache whether or not anything is listening.
 *
 * `setPersistenceEnabled(true)` caches what the app *has already read this
 * install*, which is not the same as having data on a cold start: the cache is
 * populated by live listeners, so the very first frame after launch has nothing
 * to draw until the socket connects. Launch on a plane and the chat list is
 * empty rather than stale — which reads as data loss, not as offline.
 *
 * Marking the chat-list index synced makes the SDK persist and restore it
 * across launches independently of listener lifetime. Deliberately narrow: a
 * synced path is refetched in the background forever, so this is worth it for
 * the one node that gates first paint and not for message history, which is
 * unbounded and already paged.
 *
 * Returns a release function. Idempotent, and safe to call before sign-in
 * completes — the path just stays empty.
 */
export function keepSynced(path: string): Unsubscribe {
  const r = ref(path);
  try {
    void r.keepSynced(true);
  } catch (e) {
    // Non-fatal: without it the list is merely empty until the socket connects,
    // which is the behaviour we had before.
    console.warn('[Flyer/db] keepSynced failed', path, e);
  }
  return () => {
    try {
      void r.keepSynced(false);
    } catch {
      // Signing out while offline; nothing to release.
    }
  };
}

/**
 * True if the database rejected this operation on rules grounds.
 *
 * Worth having in one place because RTDB reports a rules rejection as an
 * untyped error with the reason only in `code`/`message`, and the distinction
 * matters constantly: a denied *read* is frequently the normal case rather than
 * a fault. Read rules are evaluated against the data at the path, so a rule like
 * `data.child('participants').child(auth.uid).exists()` denies a path that does
 * not exist yet — an "is this here?" probe on a node you cannot see until you are
 * already in it comes back as a denial, not as null. Callers use this to tell
 * "not there" from "genuinely not allowed" instead of surfacing every absence as
 * a failure.
 */
export function isPermissionDenied(e: unknown): boolean {
  const code = (e as { code?: string })?.code ?? '';
  const message = (e as { message?: string })?.message ?? '';
  return /permission[-_ ]denied/i.test(`${code} ${message}`);
}

export async function write(path: string, value: unknown): Promise<void> {
  await ref(path).set(value);
}

export async function update(path: string, value: object): Promise<void> {
  await ref(path).update(value);
}

/** Multi-path atomic update from the database root. */
export async function fanOut(updates: Record<string, unknown>): Promise<void> {
  await db.ref().update(updates);
}

export async function remove(path: string): Promise<void> {
  await ref(path).remove();
}

export function pushKey(path: string): string {
  const key = ref(path).push().key;
  if (!key) throw new Error(`Failed to generate push key for ${path}`);
  return key;
}

export async function increment(path: string, by: number): Promise<number> {
  const result = await ref(path).transaction((current: number | null) => (current ?? 0) + by);
  return (result.snapshot?.val() as number) ?? 0;
}

/**
 * Register a value to be written by the server if this client disconnects
 * uncleanly (crash, airplane mode, battery pull). This is what makes presence
 * honest — a client that is killed cannot write "offline" itself.
 */
export function onDisconnectSet(path: string, value: unknown) {
  return ref(path).onDisconnect().set(value);
}

/**
 * Delete a path if this client disconnects uncleanly. The counterpart to
 * `onDisconnectSet` for nodes whose absence is the resting state — a typing
 * flag, for instance, where writing `false` would be a value the readers would
 * then have to filter out.
 */
export function onDisconnectRemove(path: string) {
  return ref(path).onDisconnect().remove();
}

export function cancelOnDisconnect(path: string) {
  return ref(path).onDisconnect().cancel();
}

export async function goOffline(): Promise<void> {
  db.goOffline();
}

export async function goOnline(): Promise<void> {
  db.goOnline();
}

export const database = db;
