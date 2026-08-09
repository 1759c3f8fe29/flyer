import AsyncStorage from '@react-native-async-storage/async-storage';
import NetInfo from '@react-native-community/netinfo';
import type { QueuedSend } from '@/src/config/types';
import { appState } from './StateManager';

/**
 * OfflineQueue
 *
 * The RTDB SDK already buffers writes in memory and replays them on reconnect,
 * but that buffer dies with the process. A message typed on the underground and
 * then swiped away would be silently lost. This queue persists the intent to
 * disk and replays it after a cold start.
 *
 * Media sends are queued with their *local* uri; the upload is retried too,
 * because a Cloudinary upload that failed offline has no url to store.
 */

/**
 * Storage key is per-uid.
 *
 * It used to be one shared key, and combined with a `stopOutbox` that left
 * `queue` populated that leaked one account's unsent messages into the next
 * session on the same device. Sign out of A with a queued message, sign in as B,
 * and B's outbox replayed A's text: the write failed the `senderId === auth.uid`
 * rule, retried to exhaustion, and then surfaced in B's chat as a failed bubble
 * containing A's words. Namespacing means a session can only ever see its own
 * queue, and an unclaimed queue survives on disk for whenever its owner returns.
 */
const STORAGE_PREFIX = '@flyer/outbox/v1';
const LEGACY_STORAGE_KEY = STORAGE_PREFIX;
const MAX_ATTEMPTS = 6;

type Sender = (item: QueuedSend) => Promise<void>;

let queue: QueuedSend[] = [];
let loaded = false;
let flushing = false;
let sender: Sender | null = null;
let netUnsub: (() => void) | null = null;
/** Whose queue is in memory. Null until `startOutbox` names a session. */
let ownerUid: string | null = null;

function storageKey(uid: string): string {
  return `${STORAGE_PREFIX}/${uid}`;
}

async function persist() {
  if (!ownerUid) return;
  try {
    await AsyncStorage.setItem(storageKey(ownerUid), JSON.stringify(queue));
  } catch (e) {
    console.warn('[Flyer/outbox] persist failed', e);
  }
  appState.get().setPendingCount(queue.length);
}

export async function loadQueue(): Promise<QueuedSend[]> {
  if (loaded) return queue;
  if (!ownerUid) return [];

  try {
    const raw = await AsyncStorage.getItem(storageKey(ownerUid));
    if (raw) {
      queue = JSON.parse(raw) as QueuedSend[];
    } else {
      // One-time migration off the shared key. Items are adopted only if this
      // session actually sent them; anything else belonged to another account and
      // is dropped rather than replayed under the wrong uid.
      const legacy = await AsyncStorage.getItem(LEGACY_STORAGE_KEY);
      const parsed = legacy ? (JSON.parse(legacy) as QueuedSend[]) : [];
      queue = parsed.filter((q) => q.draft?.senderId === ownerUid);
      await AsyncStorage.removeItem(LEGACY_STORAGE_KEY).catch(() => {});
    }
  } catch {
    queue = [];
  }

  loaded = true;
  appState.get().setPendingCount(queue.length);
  return queue;
}

/** Wired up by ChatEngine, which owns the actual send logic. */
export function registerSender(fn: Sender) {
  sender = fn;
}

export function startOutbox(uid: string) {
  // A different account on the same device must not inherit the in-memory queue.
  if (ownerUid !== uid) {
    queue = [];
    loaded = false;
    ownerUid = uid;
  }

  netUnsub?.();
  netUnsub = NetInfo.addEventListener((state) => {
    if (state.isConnected && state.isInternetReachable !== false) {
      void flush();
    }
  });
  void loadQueue().then(() => flush());
}

/**
 * Teardown for sign-out. Drops the in-memory queue as well as the listener:
 * the items stay on disk under their owner's key, so they are still waiting if
 * that account signs back in, but they are unreachable from the next session.
 */
export function stopOutbox() {
  netUnsub?.();
  netUnsub = null;
  queue = [];
  loaded = false;
  ownerUid = null;
  appState.get().setPendingCount(0);
}

export async function enqueue(item: QueuedSend): Promise<void> {
  await loadQueue();
  queue.push(item);
  await persist();
  void flush();
}

export async function dequeue(id: string): Promise<void> {
  queue = queue.filter((q) => q.id !== id);
  await persist();
}

export function pendingFor(chatId: string): QueuedSend[] {
  return queue.filter((q) => q.chatId === chatId);
}

export function pendingAll(): QueuedSend[] {
  return [...queue];
}

/**
 * Drains the queue oldest-first.
 *
 * Ordering is preserved *per chat*, not globally. The loop used to `break` on the
 * first failure to protect ordering, but that let one undeliverable item freeze
 * every other chat indefinitely — a message to a group you were removed from
 * fails permanently, and while it sat at the head nothing else ever sent. Now a
 * failure blocks only the chat it belongs to (where reordering would actually be
 * visible) and the other chats keep draining.
 */
export async function flush(): Promise<void> {
  if (flushing || !sender) return;
  await loadQueue();
  if (queue.length === 0) return;

  const net = await NetInfo.fetch();
  if (!net.isConnected || net.isInternetReachable === false) return;

  flushing = true;
  try {
    const ordered = [...queue].sort((a, b) => a.queuedAt - b.queuedAt);
    const stalled = new Set<string>();

    for (const item of ordered) {
      // An earlier message to this chat is still unsent; sending this one now
      // would land it out of order.
      if (stalled.has(item.chatId)) continue;

      try {
        await sender(item);
        await dequeue(item.id);
      } catch (e) {
        item.attempts += 1;
        console.warn(
          `[Flyer/outbox] send failed (attempt ${item.attempts}/${MAX_ATTEMPTS})`,
          e
        );

        if (item.attempts >= MAX_ATTEMPTS) {
          // Give up but keep it visible so the user can retry or delete it,
          // rather than dropping their message on the floor. The chat is *not*
          // marked stalled: this item has left the queue, so nothing behind it
          // is waiting on it any more.
          await dequeue(item.id);
          appState.get().upsertMessage(item.chatId, {
            ...item.draft,
            id: item.id,
            chatId: item.chatId,
            timestamp: item.queuedAt,
            seenBy: {},
            pending: false,
            failed: true,
          });
        } else {
          stalled.add(item.chatId);
          await persist();
        }
      }
    }
  } finally {
    flushing = false;
  }
}

export async function retryFailed(id: string, item: QueuedSend): Promise<void> {
  await enqueue({ ...item, id, attempts: 0, queuedAt: Date.now() });
}

export async function clearQueueForChat(chatId: string): Promise<void> {
  queue = queue.filter((q) => q.chatId !== chatId);
  await persist();
}
