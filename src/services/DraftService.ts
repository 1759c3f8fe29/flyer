import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * DraftService — unsent composer text, kept across restarts.
 *
 * The composer's text lived only in component state, so anything that unmounted
 * it threw the text away: backing out of a chat to check a name, a swipe-away,
 * an OS kill while the app sat in the background. That is not a lost keystroke,
 * it is a lost message — and the user has no way to tell it happened until they
 * come back and find an empty field.
 *
 * One key per (uid, chat) rather than one map per user. The composer needs
 * exactly its own chat's draft and that read is on the path to first paint, so a
 * targeted `getItem` beats parsing every draft the account has. Enumeration is
 * only needed to wipe an account, where `getAllKeys` is affordable.
 */

const STORAGE_PREFIX = '@flyer/drafts/v1';

/**
 * Namespaced per uid for the same reason the outbox is (see OfflineQueue): a
 * shared device must not show one person's unsent text to whoever signs in
 * next. Group chat ids are push keys and carry no participant information, so
 * the chat id alone would not separate them.
 */
function storageKey(uid: string, chatId: string): string {
  return `${STORAGE_PREFIX}/${uid}/${chatId}`;
}

/**
 * Long enough to coalesce a burst of typing into one write, short enough that
 * closing the app loses nothing a person would notice.
 */
const WRITE_INTERVAL_MS = 400;

/** Same ceiling the composer's TextInput enforces; a draft cannot exceed it. */
const MAX_DRAFT_LENGTH = 4096;

/** Newest value per key wins, so a fast typist still causes one write. */
const pending = new Map<string, string>();
let timer: ReturnType<typeof setTimeout> | null = null;

async function drain(): Promise<void> {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (pending.size === 0) return;

  const batch = [...pending.entries()];
  pending.clear();

  // An empty draft is an absent key, not a stored empty string — otherwise
  // every chat the user has ever opened leaves a row behind forever.
  const writes = batch.filter((entry): entry is [string, string] => entry[1] !== '');
  const deletes = batch.filter((entry) => entry[1] === '').map(([key]) => key);

  try {
    if (writes.length > 0) await AsyncStorage.multiSet(writes);
    if (deletes.length > 0) await AsyncStorage.multiRemove(deletes);
  } catch (e) {
    // Losing a draft is survivable; throwing inside a keystroke handler is not.
    console.warn('[Flyer/drafts] persist failed', e);
  }
}

/**
 * Queue a draft for writing. Returns immediately — this is called on every
 * keystroke.
 *
 * Throttled rather than debounced: the timer is armed by the first change and
 * not pushed back by later ones, so someone typing without pause still gets a
 * write every 400ms instead of nothing until they stop.
 */
export function saveDraft(uid: string, chatId: string, text: string): void {
  pending.set(storageKey(uid, chatId), text.slice(0, MAX_DRAFT_LENGTH));
  if (timer) return;
  timer = setTimeout(() => {
    void drain();
  }, WRITE_INTERVAL_MS);
}

/**
 * Write anything queued right now. Call this when the composer unmounts or the
 * app leaves the foreground — the throttle window is the one gap where a kill
 * still loses text.
 */
export async function flushDrafts(): Promise<void> {
  await drain();
}

export async function loadDraft(uid: string, chatId: string): Promise<string> {
  const key = storageKey(uid, chatId);

  // A queued write is newer than whatever is on disk. Without this, remounting
  // a composer inside the throttle window restores the previous text.
  const queued = pending.get(key);
  if (queued !== undefined) return queued;

  try {
    return (await AsyncStorage.getItem(key)) ?? '';
  } catch (e) {
    console.warn('[Flyer/drafts] load failed', e);
    return '';
  }
}

/**
 * Drop a draft immediately, bypassing the throttle. Used on send: the text is
 * in the thread now, and a crash in the next half-second must not resurrect it
 * as a duplicate.
 */
export async function clearDraft(uid: string, chatId: string): Promise<void> {
  const key = storageKey(uid, chatId);
  // A queued write would otherwise put it straight back.
  pending.delete(key);

  try {
    await AsyncStorage.removeItem(key);
  } catch (e) {
    console.warn('[Flyer/drafts] clear failed', e);
  }
}

/**
 * Wipe every draft belonging to an account.
 *
 * Deliberately *not* called on sign-out: the keys are namespaced, so no other
 * account can see them, and someone who signs back in expects their unsent text
 * to still be there — the same policy the outbox takes with an unclaimed queue.
 * This is for account deletion, where there is no owner left to return.
 */
export async function clearAllDrafts(uid: string): Promise<void> {
  const prefix = `${STORAGE_PREFIX}/${uid}/`;
  for (const key of [...pending.keys()]) {
    if (key.startsWith(prefix)) pending.delete(key);
  }

  try {
    const keys = await AsyncStorage.getAllKeys();
    const mine = keys.filter((key) => key.startsWith(prefix));
    if (mine.length > 0) await AsyncStorage.multiRemove(mine);
  } catch (e) {
    console.warn('[Flyer/drafts] clearAll failed', e);
  }
}
