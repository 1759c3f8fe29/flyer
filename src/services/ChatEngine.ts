import { Limits, chatIdFor } from '@/src/config/env';
import type {
  ChatSummary,
  Message,
  MessageType,
  QueuedSend,
  ReplyRef,
  StarredRef,
  SystemEvent,
  UserProfile,
} from '@/src/config/types';
import {
  Paths,
  cancelOnDisconnect,
  fanOut,
  increment,
  isPermissionDenied,
  keepSynced,
  onDisconnectRemove,
  onValue,
  pushKey,
  readOnce,
  ref,
  remove,
  serverNow,
  serverTimestamp,
  update,
  write,
  type Unsubscribe,
} from './FirebaseService';
import {
  clearQueueForChat,
  enqueue,
  pendingFor,
  registerSender,
  dequeue,
} from './OfflineQueue';
import { appState } from './StateManager';
import { uploadToCloudinary, videoPoster } from './MediaManager';

/**
 * ChatEngine — all conversation mutations and listeners.
 *
 * Two invariants worth stating up front:
 *
 *  1. Writes that touch more than one path go through `fanOut` (a single
 *     multi-location update). A message write touches messages/, chats/ and
 *     both userChats/ indexes; doing that as four sequential sets means a
 *     crash halfway leaves a message that no chat list points at.
 *
 *  2. `timestamp` is always ServerValue.TIMESTAMP. Client clocks are wrong often
 *     enough that trusting them visibly misorders conversations.
 */

// --- normalisation --------------------------------------------------------

function normaliseMessage(id: string, chatId: string, raw: Record<string, unknown>): Message {
  return {
    id,
    chatId,
    senderId: String(raw.senderId ?? ''),
    type: (raw.type as MessageType) ?? 'text',
    text: (raw.text as string | null) ?? null,
    mediaUrl: (raw.mediaUrl as string | null) ?? null,
    thumbUrl: (raw.thumbUrl as string | null) ?? null,
    width: (raw.width as number | null) ?? null,
    height: (raw.height as number | null) ?? null,
    durationMs: (raw.durationMs as number | null) ?? null,
    timestamp: (raw.timestamp as number) ?? 0,
    seenBy: (raw.seenBy as Record<string, number>) ?? {},
    deliveredTo: (raw.deliveredTo as Record<string, number>) ?? {},
    edited: Boolean(raw.edited),
    deleted: Boolean(raw.deleted),
    reactions: (raw.reactions as Record<string, string>) ?? {},
    hiddenFor: (raw.hiddenFor as Record<string, boolean>) ?? {},
    replyTo: (raw.replyTo as ReplyRef | null) ?? null,
    forwardedFrom: (raw.forwardedFrom as string | null) ?? null,
    event: (raw.event as SystemEvent | null) ?? null,
  };
}

/** Per-user flags from `userChats/{uid}/{chatId}`, merged in by listenToChats. */
interface UserChatFlags {
  pinned: boolean;
  archived: boolean;
}

function normaliseChat(
  id: string,
  raw: Record<string, unknown>,
  flags: UserChatFlags
): ChatSummary {
  return {
    id,
    participants: (raw.participants as Record<string, boolean>) ?? {},
    lastMessage: (raw.lastMessage as ChatSummary['lastMessage']) ?? null,
    lastTimestamp: (raw.lastTimestamp as number) ?? 0,
    mutedBy: (raw.mutedBy as Record<string, number>) ?? {},
    clearedAt: (raw.clearedAt as Record<string, number>) ?? {},
    unread: (raw.unread as Record<string, number>) ?? {},
    pinned: flags.pinned,
    archived: flags.archived,
    isGroup: raw.isGroup === true,
    name: (raw.name as string | null) ?? null,
    photoURL: (raw.photoURL as string | null) ?? null,
    description: (raw.description as string | null) ?? null,
    admins: (raw.admins as Record<string, boolean>) ?? {},
    createdBy: (raw.createdBy as string | null) ?? null,
    createdAt: (raw.createdAt as number) ?? 0,
  };
}

export function previewFor(type: MessageType, text: string | null): string {
  switch (type) {
    case 'image':
      return '📷 Photo';
    case 'video':
      return '🎥 Video';
    case 'audio':
      return '🎤 Voice note';
    default:
      return text ?? '';
  }
}

// --- listeners -----------------------------------------------------------

/**
 * Subscribes to the signed-in user's chat list.
 *
 * We fan out through `userChats/{uid}` rather than querying `/chats` because
 * security rules cannot filter a list read — a query over /chats would be
 * rejected wholesale for any user who is not a participant in every result.
 */
export function listenToChats(uid: string): Unsubscribe {
  const perChat = new Map<string, Unsubscribe>();
  // Latest flags per chat, so a chat-node update can re-emit without waiting
  // for the index to fire again (and vice versa).
  const flags = new Map<string, UserChatFlags>();
  const latest = new Map<string, Record<string, unknown>>();

  // Survives this listener's lifetime in the disk cache, so the next cold start
  // paints the last known chat list instead of an empty screen while offline.
  const releaseSync = keepSynced(Paths.userChats(uid));

  const emit = (chatId: string) => {
    const raw = latest.get(chatId);
    if (!raw) return;
    const f = flags.get(chatId) ?? { pinned: false, archived: false };
    appState.get().upsertChat(normaliseChat(chatId, raw, f));
  };

  const offIndex = onValue(Paths.userChats(uid), (snap) => {
    const index = (snap.val() as Record<string, Record<string, unknown>> | null) ?? {};
    const ids = new Set(Object.keys(index));

    for (const [chatId, off] of perChat) {
      if (!ids.has(chatId)) {
        off();
        perChat.delete(chatId);
        flags.delete(chatId);
        latest.delete(chatId);
        appState.get().removeChat(chatId);
      }
    }

    for (const chatId of ids) {
      const entry = index[chatId] ?? {};
      flags.set(chatId, {
        pinned: entry.pinned === true,
        archived: entry.archived === true,
      });

      if (perChat.has(chatId)) {
        // Already subscribed — the index fired because a flag changed.
        emit(chatId);
        continue;
      }

      const off = onValue(Paths.chat(chatId), (chatSnap) => {
        const raw = chatSnap.val() as Record<string, unknown> | null;
        if (!raw) {
          latest.delete(chatId);
          appState.get().removeChat(chatId);
          return;
        }
        latest.set(chatId, raw);
        emit(chatId);
      });
      perChat.set(chatId, off);
    }
  });

  return () => {
    offIndex();
    releaseSync();
    for (const off of perChat.values()) off();
    perChat.clear();
    flags.clear();
    latest.clear();
  };
}

/**
 * Message listener for one chat, limited to the most recent page.
 *
 * `clearedAt` is applied client-side: "clear chat" is per-user, so the messages
 * still exist for the other participant and must not be deleted server-side.
 */
export function listenToMessages(chatId: string, uid: string): Unsubscribe {
  const query = ref(Paths.messages(chatId))
    .orderByChild('timestamp')
    .limitToLast(Limits.messagePageSize);

  return onValue(query, (snap) => {
    const raw = (snap.val() as Record<string, Record<string, unknown>> | null) ?? {};
    const clearedAt = appState.get().chats[chatId]?.clearedAt?.[uid] ?? 0;

    const list = Object.entries(raw)
      .map(([id, value]) => normaliseMessage(id, chatId, value))
      .filter((m) => m.timestamp > clearedAt)
      // "Delete for me" is a per-user flag, so it filters here rather than
      // removing the row that the other participant still needs.
      .filter((m) => !m.hiddenFor[uid])
      .sort((a, b) => a.timestamp - b.timestamp);

    // Queued-but-unsent messages are appended so they appear in the transcript
    // with a clock icon instead of vanishing until connectivity returns.
    const queued = pendingFor(chatId).map<Message>((q) => ({
      ...(q.draft as unknown as Message),
      id: q.id,
      chatId,
      timestamp: q.queuedAt,
      seenBy: {},
      deliveredTo: {},
      pending: true,
    }));

    // Messages that are mid-flight but in neither place yet.
    //
    // `sendMedia` inserts an optimistic bubble via `upsertMessage` and only
    // writes to RTDB once Cloudinary returns, so for the whole upload it exists
    // in the store alone — not in this snapshot, and not in the outbox either
    // (that is the offline path). A blind `setMessages` therefore deletes the
    // bubble, and its progress spinner with it, the instant any other write
    // touches `messages/{chatId}` — the peer replying mid-upload is enough.
    // Carrying them forward keeps the bubble until the real row supersedes it.
    const serverIds = new Set(list.map((m) => m.id));
    const queuedIds = new Set(queued.map((m) => m.id));
    const inFlight = (appState.get().messages[chatId] ?? []).filter(
      (m) => m.pending && !serverIds.has(m.id) && !queuedIds.has(m.id)
    );

    appState
      .get()
      .setMessages(
        chatId,
        [...list, ...inFlight, ...queued].sort((a, b) => a.timestamp - b.timestamp)
      );
  });
}

/**
 * Older pages, for infinite scroll upward.
 *
 * The boundary is inclusive (`endAt(before)`, not `endAt(before - 1)`) because
 * timestamps are milliseconds and ties are common: a fan-out stamps several rows
 * from one server clock read, and two quick taps land in the same millisecond.
 * An exclusive boundary drops the *entire* tie group at `before`, so a sibling
 * of the oldest loaded message is skipped permanently — the transcript silently
 * loses a message, and no amount of further scrolling brings it back.
 *
 * Inclusive means the caller gets back rows it already has, so one extra row is
 * requested to keep a full page of new ones, and the overlap is removed here —
 * not in the caller. The dedupe used to live in the chat screen, so every
 * future caller had to remember it or render doubles (BUG-17).
 */
/** One-shot read of a single message, for screens the live listener never fed. */
export async function readMessage(
  chatId: string,
  messageId: string
): Promise<Message | null> {
  const raw = await readOnce<Record<string, unknown>>(Paths.message(chatId, messageId));
  if (!raw) return null;
  return normaliseMessage(messageId, chatId, raw);
}

export async function loadOlderMessages(
  chatId: string,
  before: number,
  uid: string,
  excludeIds: Set<string> = new Set()
): Promise<Message[]> {
  const snap = await ref(Paths.messages(chatId))
    .orderByChild('timestamp')
    .endAt(before)
    .limitToLast(Limits.messagePageSize + 1)
    .once('value');

  const raw = (snap.val() as Record<string, Record<string, unknown>> | null) ?? {};
  const clearedAt = appState.get().chats[chatId]?.clearedAt?.[uid] ?? 0;

  return Object.entries(raw)
    .map(([id, value]) => normaliseMessage(id, chatId, value))
    .filter((m) => !excludeIds.has(m.id))
    .filter((m) => m.timestamp > clearedAt)
    .filter((m) => !m.hiddenFor[uid])
    .sort((a, b) => a.timestamp - b.timestamp);
}

export function listenToTyping(chatId: string): Unsubscribe {
  return onValue(Paths.typing(chatId), (snap) => {
    appState.get().setTyping(chatId, (snap.val() as Record<string, number>) ?? {});
  });
}

export function listenToUser(uid: string): Unsubscribe {
  return onValue(Paths.user(uid), (snap) => {
    const raw = snap.val() as UserProfile | null;
    if (raw) appState.get().cacheUser({ ...raw, uid });
  });
}

export function listenToBlocks(uid: string): Unsubscribe {
  return onValue(Paths.blocks(uid), (snap) => {
    appState.get().setBlocked((snap.val() as Record<string, boolean>) ?? {});
  });
}

// --- chat lifecycle ------------------------------------------------------

/**
 * Idempotent: safe to call every time a chat is opened.
 *
 * The existence probe has to tolerate a permission error. `chats/{chatId}` is
 * readable only by a participant, and that rule is evaluated against the data
 * at the path — so for a chat that does not exist there is no participant list
 * to match against and the read is *denied* rather than returning null. Letting
 * that propagate meant the first-ever chat with anyone failed with "Could not
 * open chat", and only opening it a second time worked... except the first
 * attempt never created it, so it never did.
 *
 * A denial and a null are therefore the same answer here: nothing readable is
 * there, so try to create it. If it does exist and someone else created it
 * first, the create write is refused by `!data.exists()` and that refusal is
 * swallowed — by then the chat is present, which is all the caller wanted.
 */
export async function ensureChat(myUid: string, peerUid: string): Promise<string> {
  const chatId = chatIdFor(myUid, peerUid);

  let existing: ChatSummary | null = null;
  try {
    existing = await readOnce<ChatSummary>(Paths.chat(chatId));
  } catch (e) {
    if (!isPermissionDenied(e)) throw e;
  }

  if (!existing) {
    try {
      await fanOut({
        [Paths.chat(chatId)]: {
          participants: { [myUid]: true, [peerUid]: true },
          lastMessage: null,
          lastTimestamp: serverTimestamp(),
          unread: { [myUid]: 0, [peerUid]: 0 },
        },
        [Paths.userChat(myUid, chatId)]: { lastTimestamp: serverTimestamp() },
        [Paths.userChat(peerUid, chatId)]: { lastTimestamp: serverTimestamp() },
      });
    } catch (e) {
      // Lost a race with the peer opening the same chat, or with our own
      // double-tap. Either way the chat now exists, which is the postcondition.
      if (!isPermissionDenied(e)) throw e;
    }
  }

  return chatId;
}

export function peerOf(chat: ChatSummary, myUid: string): string | null {
  if (chat.isGroup) return null;
  return Object.keys(chat.participants ?? {}).find((uid) => uid !== myUid) ?? null;
}

/**
 * Everyone who needs their chat index bumped and unread badge incremented.
 *
 * Groups have no single peer, so the list comes from the chat's participants.
 * Reading from the store rather than the database keeps the send path off the
 * network: the sender is looking at the chat, so its participants are already
 * subscribed and current.
 */
function recipientsFor(chatId: string, senderId: string, peerId: string | null): string[] {
  const chat = appState.get().chats[chatId];
  if (chat?.isGroup) {
    return Object.keys(chat.participants ?? {}).filter((uid) => uid !== senderId);
  }
  return peerId ? [peerId] : [];
}

// --- sending -------------------------------------------------------------

interface SendOptions {
  chatId: string;
  senderId: string;
  /**
   * The other party in a 1:1 chat. Groups pass `recipients` instead; exactly one
   * of the two is set.
   */
  peerId: string | null;
  /** Every participant except the sender. Groups only. */
  recipients?: string[];
  type: MessageType;
  text?: string | null;
  mediaUrl?: string | null;
  thumbUrl?: string | null;
  width?: number | null;
  height?: number | null;
  durationMs?: number | null;
  replyTo?: ReplyRef | null;
  forwardedFrom?: string | null;
  /** `system` messages only — the group event this row describes. */
  event?: SystemEvent | null;
}

/** Writes the message and every participant's chat-list index atomically. */
async function commitMessage(opts: SendOptions, messageId: string): Promise<void> {
  const { chatId, senderId } = opts;
  const recipients = opts.recipients ?? recipientsFor(chatId, senderId, opts.peerId);

  const payload = {
    senderId,
    type: opts.type,
    text: opts.text ?? null,
    mediaUrl: opts.mediaUrl ?? null,
    thumbUrl: opts.thumbUrl ?? null,
    width: opts.width ?? null,
    height: opts.height ?? null,
    durationMs: opts.durationMs ?? null,
    timestamp: serverTimestamp(),
    seenBy: { [senderId]: serverTimestamp() },
    deliveredTo: {},
    edited: false,
    deleted: false,
    reactions: {},
    replyTo: opts.replyTo ?? null,
    forwardedFrom: opts.forwardedFrom ?? null,
    event: opts.event ?? null,
  };

  const updates: Record<string, unknown> = {
    [Paths.message(chatId, messageId)]: payload,
    [`${Paths.chat(chatId)}/lastMessage`]: {
      text: previewFor(opts.type, opts.text ?? null),
      type: opts.type,
      senderId,
      deleted: false,
    },
    [`${Paths.chat(chatId)}/lastTimestamp`]: serverTimestamp(),
    // Leaf writes, not `{lastTimestamp}` objects: setting the parent would
    // replace the node and wipe the owner's `pinned`/`archived` flags.
    [`${Paths.userChat(senderId, chatId)}/lastTimestamp`]: serverTimestamp(),
  };

  for (const uid of recipients) {
    updates[`${Paths.userChat(uid, chatId)}/lastTimestamp`] = serverTimestamp();
  }

  await fanOut(updates);

  // Separate transactions: a fan-out cannot express "increment" atomically.
  // Failures are swallowed per-recipient — a lagging badge beats a send that
  // reports failure after the message is already delivered.
  await Promise.all(
    recipients.map((uid) => increment(Paths.unread(chatId, uid), 1).catch(() => {}))
  );
}

export async function sendText(
  chatId: string,
  senderId: string,
  /** Null in a group, where recipients come from the chat's participants. */
  peerId: string | null,
  text: string,
  replyTo: ReplyRef | null = null
): Promise<void> {
  const trimmed = text.trim();
  if (!trimmed) return;

  const messageId = pushKey(Paths.messages(chatId));
  const opts: SendOptions = { chatId, senderId, peerId, type: 'text', text: trimmed, replyTo };

  if (appState.get().networkStatus === 'offline') {
    await enqueue({
      id: messageId,
      chatId,
      draft: {
        senderId,
        type: 'text',
        text: trimmed,
        mediaUrl: null,
        thumbUrl: null,
        width: null,
        height: null,
        durationMs: null,
        edited: false,
        deleted: false,
        reactions: {},
        hiddenFor: {},
        replyTo,
        forwardedFrom: null,
        event: null,
      },
      localUri: null,
      attempts: 0,
      queuedAt: serverNow(),
    });
    return;
  }

  await commitMessage(opts, messageId);
  await clearTyping(chatId, senderId);
}

/**
 * Media send. The bubble is rendered immediately from the local uri, so the
 * upload happens after the optimistic insert and the real url replaces it.
 */
export async function sendMedia(
  chatId: string,
  senderId: string,
  /** Null in a group, where recipients come from the chat's participants. */
  peerId: string | null,
  media: {
    uri: string;
    type: 'image' | 'video' | 'audio';
    width?: number | null;
    height?: number | null;
    durationMs?: number | null;
    thumbnailUri?: string | null;
  },
  onProgress?: (fraction: number) => void,
  replyTo: ReplyRef | null = null
): Promise<void> {
  const messageId = pushKey(Paths.messages(chatId));

  const draft: QueuedSend['draft'] = {
    senderId,
    type: media.type,
    text: null,
    mediaUrl: media.uri,
    thumbUrl: media.thumbnailUri ?? null,
    width: media.width ?? null,
    height: media.height ?? null,
    durationMs: media.durationMs ?? null,
    edited: false,
    deleted: false,
    reactions: {},
    hiddenFor: {},
    replyTo,
    forwardedFrom: null,
    event: null,
  };

  // Optimistic bubble with a progress spinner.
  appState.get().upsertMessage(chatId, {
    ...(draft as unknown as Message),
    id: messageId,
    chatId,
    timestamp: serverNow(),
    seenBy: {},
    deliveredTo: {},
    pending: true,
  });

  if (appState.get().networkStatus === 'offline') {
    await enqueue({
      id: messageId,
      chatId,
      draft,
      localUri: media.uri,
      attempts: 0,
      queuedAt: serverNow(),
    });
    return;
  }

  try {
    // Cloudinary treats audio as a 'video' resource; there is no audio endpoint.
    const resource = media.type === 'image' ? 'image' : 'video';
    const uploaded = await uploadToCloudinary(media.uri, resource, onProgress);

    await commitMessage(
      {
        chatId,
        senderId,
        peerId,
        type: media.type,
        mediaUrl: uploaded.url,
        thumbUrl: media.type === 'video' ? videoPoster(uploaded.url) : null,
        width: uploaded.width ?? media.width ?? null,
        height: uploaded.height ?? media.height ?? null,
        durationMs: uploaded.durationMs ?? media.durationMs ?? null,
        replyTo,
      },
      messageId
    );
  } catch (e) {
    // The log used to say "queueing" while queueing nothing: an upload that
    // fails mid-flight (offline flip, Cloudinary 5xx) marked the bubble failed
    // and rethrew, so unlike the offline branch it never retried on reconnect.
    // The draft keeps the *local* uri, so the replay path re-uploads it.
    console.warn('[Flyer/chat] media send failed, queueing', e);
    await enqueue({
      id: messageId,
      chatId,
      draft,
      localUri: media.uri,
      attempts: 0,
      queuedAt: serverNow(),
    });
    appState.get().upsertMessage(chatId, {
      ...(draft as unknown as Message),
      id: messageId,
      chatId,
      timestamp: serverNow(),
      seenBy: {},
      deliveredTo: {},
      pending: false,
      failed: true,
    });
    throw e;
  }
}

/** Replays a queued send once connectivity returns. */
registerSender(async (item: QueuedSend) => {
  const chat = appState.get().chats[item.chatId];
  const myUid = item.draft.senderId;
  // Groups have no peer; `commitMessage` resolves their recipients from the
  // participant list instead. Only a 1:1 chat with no peer is unreplayable.
  const peerId = chat ? peerOf(chat, myUid) : null;
  if (!peerId && !chat?.isGroup) {
    throw new Error(`Cannot resolve peer for chat ${item.chatId}`);
  }

  let mediaUrl = item.draft.mediaUrl;
  let thumb = item.draft.thumbUrl;

  if (item.localUri) {
    const resource = item.draft.type === 'image' ? 'image' : 'video';
    const uploaded = await uploadToCloudinary(item.localUri, resource);
    mediaUrl = uploaded.url;
    thumb = item.draft.type === 'video' ? videoPoster(uploaded.url) : null;
  }

  await commitMessage(
    {
      chatId: item.chatId,
      senderId: myUid,
      peerId,
      type: item.draft.type,
      text: item.draft.text,
      mediaUrl,
      thumbUrl: thumb,
      width: item.draft.width,
      height: item.draft.height,
      durationMs: item.draft.durationMs,
      replyTo: item.draft.replyTo,
      forwardedFrom: item.draft.forwardedFrom,
    },
    item.id
  );
});

// --- mutations -----------------------------------------------------------

/**
 * BUG-10 windows, mirrored in database.rules.json (`text`/`edited` vs
 * `deleted`). WhatsApp's caps: edits 15 minutes, delete-for-everyone ~2 days.
 * The UI hides the actions past expiry; the rules enforce it server-side
 * against the message's own `timestamp`, so a tampered client is denied.
 */
export const EDIT_WINDOW_MS = 15 * 60 * 1000;
export const DELETE_WINDOW_MS = 2 * 24 * 60 * 60 * 1000;

export async function editMessage(
  chatId: string,
  messageId: string,
  text: string
): Promise<void> {
  const trimmed = text.trim();
  if (!trimmed) return;
  await update(Paths.message(chatId, messageId), { text: trimmed, edited: true });

  // Keep the chat-list preview honest if the edited message was the latest.
  const chat = appState.get().chats[chatId];
  const messages = appState.get().messages[chatId] ?? [];
  const latest = messages[messages.length - 1];
  if (chat && latest?.id === messageId) {
    await update(`${Paths.chat(chatId)}/lastMessage`, { text: trimmed });
  }
}

/**
 * Delete for everyone. Soft delete — the row stays so both sides render
 * "This message was deleted", which is what makes the deletion visible rather
 * than silently rewriting history.
 *
 * Only the sender may do this; the rules enforce it too, so a tampered client
 * gets a permission error rather than a wiped message.
 */
export async function deleteMessage(chatId: string, messageId: string): Promise<void> {
  // The flag expires per BUG-10's window, but scrubbing the payload never does:
  // null writes skip .validate and the text/media rules exempt them, so an old
  // message is still wiped, just no longer flaggable after ~2 days.
  await update(Paths.message(chatId, messageId), {
    deleted: true,
    text: null,
    mediaUrl: null,
    thumbUrl: null,
  });

  const messages = appState.get().messages[chatId] ?? [];
  if (messages[messages.length - 1]?.id === messageId) {
    await update(`${Paths.chat(chatId)}/lastMessage`, {
      text: 'This message was deleted',
      deleted: true,
    });
  }
}

/**
 * Delete for me. The message still exists for the other participant, so it can
 * only be flagged, not removed — `hiddenFor/{uid}` is filtered out client-side
 * by listenToMessages. Anyone may do this to any message, including received
 * ones, which is the difference from delete-for-everyone.
 */
export async function deleteMessageForMe(
  chatId: string,
  messageId: string,
  uid: string
): Promise<void> {
  await write(`${Paths.message(chatId, messageId)}/hiddenFor/${uid}`, true);
  appState.get().removeMessage(chatId, messageId);
}

/** Bulk variant for multi-select. One fan-out, so the list settles once. */
export async function deleteMessagesForMe(
  chatId: string,
  messageIds: string[],
  uid: string
): Promise<void> {
  if (messageIds.length === 0) return;
  const updates: Record<string, unknown> = {};
  for (const id of messageIds) {
    updates[`${Paths.message(chatId, id)}/hiddenFor/${uid}`] = true;
  }
  await fanOut(updates);
  for (const id of messageIds) appState.get().removeMessage(chatId, id);
}

/** Multi-select delete-for-everyone. Skips anything I did not send. */
export async function deleteMessagesForEveryone(
  chatId: string,
  messageIds: string[],
  uid: string
): Promise<void> {
  const mine = new Set(
    (appState.get().messages[chatId] ?? [])
      .filter((m) => m.senderId === uid)
      .map((m) => m.id)
  );

  const updates: Record<string, unknown> = {};
  for (const id of messageIds) {
    if (!mine.has(id)) continue;
    const base = Paths.message(chatId, id);
    updates[`${base}/deleted`] = true;
    updates[`${base}/text`] = null;
    updates[`${base}/mediaUrl`] = null;
    updates[`${base}/thumbUrl`] = null;
  }
  if (Object.keys(updates).length === 0) return;
  await fanOut(updates);

  const messages = appState.get().messages[chatId] ?? [];
  const latest = messages[messages.length - 1];
  if (latest && messageIds.includes(latest.id) && mine.has(latest.id)) {
    await update(`${Paths.chat(chatId)}/lastMessage`, {
      text: 'This message was deleted',
      deleted: true,
    });
  }
}

/** Last toggle ms per chat:message:uid, backing the BUG-27 throttle below. */
const reactionToggles = new Map<string, number>();

export async function toggleReaction(
  chatId: string,
  messageId: string,
  uid: string,
  emoji: string
): Promise<void> {
  // BUG-27: per-key toggle throttle. Reaction count cannot be capped in rules
  // (the language has no child counter, and distinct reactors are already
  // bounded by group membership), so the remaining abuse is one client
  // rage-toggling — a read plus a write per tap, each fanning a push to the
  // author. Taps inside the window are almost always double-tap accidents.
  const key = `${chatId}:${messageId}:${uid}`;
  const now = serverNow();
  const last = reactionToggles.get(key) ?? 0;
  if (now - last < 1000) return;
  reactionToggles.set(key, now);

  const path = Paths.reaction(chatId, messageId, uid);
  const current = await readOnce<string>(path);
  // Tapping the same emoji twice removes it.
  await write(path, current === emoji ? null : emoji);
}

/**
 * Marks messages seen. Respects the mutual read-receipt setting: if I have
 * receipts off, I do not broadcast mine either.
 */
export async function markSeen(
  chatId: string,
  uid: string,
  messages: Message[]
): Promise<void> {
  const me = appState.get().currentUser;
  if (me?.privacy?.readReceipts === false) {
    await write(Paths.unread(chatId, uid), 0).catch(() => {});
    return;
  }

  const updates: Record<string, unknown> = {};
  for (const m of messages) {
    if (m.senderId === uid || m.pending) continue;
    if (m.seenBy?.[uid]) continue;
    updates[Paths.seenBy(chatId, m.id, uid)] = serverTimestamp();
  }

  updates[Paths.unread(chatId, uid)] = 0;
  await fanOut(updates).catch((e) => console.warn('[Flyer/chat] markSeen failed', e));
}

/**
 * N-02: records that a message reached this device. Unlike `markSeen` this is
 * legitimate to write without the user looking at anything — it fires from the
 * push handler — and unlike `markSeen` it must NOT clear unread or consult
 * read-receipt privacy: "delivered" is a transport fact, not a reading one.
 */
export async function markDelivered(
  chatId: string,
  messageId: string,
  uid: string
): Promise<void> {
  await write(Paths.deliveredTo(chatId, messageId, uid), serverTimestamp()).catch(() => {});
}

// --- typing --------------------------------------------------------------

const typingTimers = new Map<string, ReturnType<typeof setTimeout>>();

export function setTyping(chatId: string, uid: string): void {
  const key = `${chatId}:${uid}`;
  // BUG-32: server time, not wall clock — the peer judges this value against
  // their own clock, so both sides must mean the same thing by "now".
  write(Paths.typingUser(chatId, uid), serverNow()).catch(() => {});

  /**
   * The server clears the flag if this client dies.
   *
   * `clearTyping` runs on a timer, and a process that is killed mid-keystroke —
   * force-stop, crash, battery pull — never gets to run it. The node then stays
   * set forever and the peer sees a permanent "typing…". Registering the removal
   * with the server means the disconnect itself clears it.
   */
  onDisconnectRemove(Paths.typingUser(chatId, uid)).catch(() => {});

  const existing = typingTimers.get(key);
  if (existing) clearTimeout(existing);

  typingTimers.set(
    key,
    setTimeout(() => {
      void clearTyping(chatId, uid);
      typingTimers.delete(key);
    }, Limits.typingIdleMs)
  );
}

export async function clearTyping(chatId: string, uid: string): Promise<void> {
  const key = `${chatId}:${uid}`;
  const existing = typingTimers.get(key);
  if (existing) {
    clearTimeout(existing);
    typingTimers.delete(key);
  }
  // Cancel first: leaving it armed would re-remove a node the *next* session may
  // legitimately own, since onDisconnect registrations outlive the write itself.
  await cancelOnDisconnect(Paths.typingUser(chatId, uid)).catch(() => {});
  await remove(Paths.typingUser(chatId, uid)).catch(() => {});
}

/**
 * Session teardown for this module's timers.
 *
 * `typingTimers` is module-level, so it outlives a sign-out. A pending timer
 * would fire under the next account and write to `typing/{chatId}/{previousUid}`
 * — a path the new session cannot write, so it fails, but it also means the old
 * user is left mid-typing in a chat the device is no longer signed into.
 */
export function stopTypingTimers(): void {
  for (const timer of typingTimers.values()) clearTimeout(timer);
  typingTimers.clear();
}

// --- starred / forward / mute / block ------------------------------------

export async function toggleStar(
  uid: string,
  chatId: string,
  messageId: string
): Promise<boolean> {
  // Transaction, not read-then-write: two devices toggling at once both read
  // null (or both read set) and one toggle is silently lost.
  // Transaction, not read-then-write: two devices toggling at once both read
  // null (or both read set) and one toggle is silently lost. The timestamp is
  // a plain number rather than a server value — updaters must stay side-effect
  // free and re-runnable, and it is only a sort key anyway.
  const path = Paths.starredItem(uid, chatId, messageId);
  const result = await ref(path).transaction((current: unknown) =>
    current ? null : { chatId, messageId, starredAt: serverNow() }
  );
  return Boolean(result.snapshot.val());
}

export function listenToStarred(uid: string, cb: (items: StarredRef[]) => void): Unsubscribe {
  return onValue(Paths.starred(uid), (snap) => {
    const raw = (snap.val() as Record<string, StarredRef> | null) ?? {};
    cb(
      Object.entries(raw)
        .map(([key, value]) => ({ ...value, key }))
        .sort((a, b) => b.starredAt - a.starredAt)
    );
  });
}

/** Internal-only forward: re-sends the payload into another chat. */
export async function forwardMessage(
  message: Message,
  myUid: string,
  targetPeerUid: string
): Promise<void> {
  const chatId = await ensureChat(myUid, targetPeerUid);
  const messageId = pushKey(Paths.messages(chatId));

  // Unlike sendText/sendMedia this had no offline branch: an offline forward
  // relied on the RTDB SDK's in-memory buffer, so killing the app before
  // reconnect silently lost it.
  if (appState.get().networkStatus === 'offline') {
    await enqueue({
      id: messageId,
      chatId,
      draft: {
        senderId: myUid,
        type: message.type,
        text: message.text,
        mediaUrl: message.mediaUrl,
        thumbUrl: message.thumbUrl,
        width: message.width,
        height: message.height,
        durationMs: message.durationMs,
        edited: false,
        deleted: false,
        reactions: {},
        hiddenFor: {},
        replyTo: message.replyTo,
        forwardedFrom: message.senderId,
        event: null,
      },
      localUri: null,
      attempts: 0,
      queuedAt: serverNow(),
    });
    return;
  }

  await commitMessage(
    {
      chatId,
      senderId: myUid,
      peerId: targetPeerUid,
      type: message.type,
      text: message.text,
      mediaUrl: message.mediaUrl,
      thumbUrl: message.thumbUrl,
      width: message.width,
      height: message.height,
      durationMs: message.durationMs,
      forwardedFrom: message.senderId,
    },
    messageId
  );
}

export async function setChatMuted(
  chatId: string,
  uid: string,
  until: number | null
): Promise<void> {
  await write(Paths.muted(chatId, uid), until ?? 0);
}

/**
 * Pin and archive write to the caller's own `userChats` index, so they are
 * invisible to the peer and survive independently of the shared chat node.
 * Both write `false` rather than removing the key, because the index entry's
 * `.validate` requires `lastTimestamp` to remain present.
 */
export async function setChatPinned(
  uid: string,
  chatId: string,
  pinned: boolean
): Promise<void> {
  await write(Paths.pinned(uid, chatId), pinned);
}

export async function setChatArchived(
  uid: string,
  chatId: string,
  archived: boolean
): Promise<void> {
  await write(Paths.archived(uid, chatId), archived);
}

export function isChatMuted(chat: ChatSummary | undefined, uid: string): boolean {
  const until = chat?.mutedBy?.[uid] ?? 0;
  // -1 is the sentinel for "mute forever". Compared on the server clock like
  // every other timestamp the app writes — the writers below stamp serverNow.
  return until === -1 || until > serverNow();
}

/**
 * Clears my unread badge without opening the chat. Deliberately does *not*
 * touch `seenBy` on the messages — the peer's read receipts should only turn
 * blue when the messages were actually on screen.
 */
export async function markChatRead(chatId: string, uid: string): Promise<void> {
  await write(Paths.unread(chatId, uid), 0);
}

/** Per-user clear: hides history for me, leaves the peer's copy intact. */
export async function clearChat(chatId: string, uid: string): Promise<void> {
  await write(Paths.clearedAt(chatId, uid), serverTimestamp());
  await write(Paths.unread(chatId, uid), 0);
  appState.get().setMessages(chatId, []);
}

/**
 * Block, in both halves: the private list that drives my own UI, and the
 * pair-keyed mirror the message write rule actually enforces against.
 *
 * One fan-out, so the enforcement mirror can never disagree with the list. The
 * mirror is keyed by chat id and stores only *who* set it, never who it points
 * at — which is what lets both parties read it without the blocked side learning
 * they were blocked rather than the reverse.
 */
export async function blockUser(myUid: string, otherUid: string): Promise<void> {
  const chatId = chatIdFor(myUid, otherUid);
  await fanOut({
    [Paths.block(myUid, otherUid)]: true,
    [Paths.blockPair(chatId, myUid)]: true,
  });
}

export async function unblockUser(myUid: string, otherUid: string): Promise<void> {
  const chatId = chatIdFor(myUid, otherUid);
  await fanOut({
    [Paths.block(myUid, otherUid)]: null,
    [Paths.blockPair(chatId, myUid)]: null,
  });
}

/**
 * Live "is this conversation blocked, in either direction".
 *
 * Replaces an `isBlockedByPeer` that read the peer's private block list, was
 * denied every time, caught the denial and returned `false` — a check that
 * always reported "not blocked" while callers treated it as authoritative.
 *
 * `blockPairs/{chatId}` is readable by both participants, so this is a real
 * answer rather than a guess. It deliberately does not distinguish direction:
 * the caller pairs it with `blocked[peerUid]` from the store (my own list, which
 * only I can read) to tell "I blocked them" from "they blocked me".
 */
export function listenToBlockPair(
  chatId: string,
  cb: (blockedEitherWay: boolean) => void
): Unsubscribe {
  return onValue(
    Paths.blockPairs(chatId),
    (snap) => cb(snap.exists()),
    // A denial here means this is not a 1:1 chat I am part of; nothing to report.
    () => cb(false)
  );
}

export async function reportUser(
  reporterId: string,
  reportedId: string,
  reason: string,
  chatId: string | null
): Promise<void> {
  const key = pushKey(Paths.reports());
  await write(`${Paths.reports()}/${key}`, {
    reporterId,
    reportedId,
    reason,
    chatId,
    createdAt: serverTimestamp(),
  });
}

export async function deleteChatForMe(chatId: string, uid: string): Promise<void> {
  // BUG-30: queued offline sends would otherwise replay after reconnect,
  // re-writing userChats/lastTimestamp and resurrecting the deleted chat.
  await clearQueueForChat(chatId);
  await clearChat(chatId, uid);
  await remove(Paths.userChat(uid, chatId));
  appState.get().removeChat(chatId);
}

// --- contacts / search ---------------------------------------------------

// `fetchAllUsers` used to sit here and download the entire `users` node. It had
// no callers, and the rules no longer grant the parent read it needed. Finding
// strangers is DirectoryService.searchDirectory; `searchChats` below is a local
// filter over chats you are already in and reads nothing.

export function searchChats(
  chats: ChatSummary[],
  users: Record<string, UserProfile>,
  myUid: string,
  term: string
): ChatSummary[] {
  const q = term.trim().toLowerCase();
  if (!q) return chats;

  return chats.filter((chat) => {
    const peer = peerOf(chat, myUid);
    const name = chat.isGroup ? (chat.name ?? '') : peer ? (users[peer]?.name ?? '') : '';
    const last = chat.lastMessage?.text ?? '';
    return name.toLowerCase().includes(q) || last.toLowerCase().includes(q);
  });
}

// --- date grouping -------------------------------------------------------

export function dayLabel(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return 'Today';

  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';

  const withinWeek = now.getTime() - ts < 7 * 24 * 60 * 60 * 1000;
  if (withinWeek) return d.toLocaleDateString(undefined, { weekday: 'long' });

  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

export type ChatListItem =
  | { kind: 'day'; id: string; label: string }
  | { kind: 'unread'; id: string; count: number }
  | { kind: 'message'; id: string; message: Message; showTail: boolean };

/**
 * Flattens messages into a render list with date separators, and marks which
 * bubbles get a tail (last in a run from the same sender).
 *
 * `unreadCount` inserts the "unread messages" divider above the first message
 * the user has not seen. It is passed in rather than derived here because the
 * count has to be captured when the chat opens: `markSeen` clears it a moment
 * later, and a divider that vanishes while you are reading is worse than none.
 */
export function buildMessageList(messages: Message[], unreadCount = 0): ChatListItem[] {
  const items: ChatListItem[] = [];
  let lastDay = '';

  // The unread run is the tail of the list, so the divider goes before the
  // last `unreadCount` messages. Clamped because the count comes from a
  // counter the peer increments and this list may be a partial page.
  const dividerAt =
    unreadCount > 0 && unreadCount <= messages.length ? messages.length - unreadCount : -1;

  messages.forEach((message, i) => {
    const label = dayLabel(message.timestamp);
    if (label !== lastDay) {
      items.push({ kind: 'day', id: `day-${label}-${message.id}`, label });
      lastDay = label;
    }

    // After the day pill: the divider belongs immediately above the message.
    if (i === dividerAt) {
      items.push({ kind: 'unread', id: `unread-${message.id}`, count: unreadCount });
    }

    const next = messages[i + 1];
    const showTail =
      !next ||
      next.senderId !== message.senderId ||
      next.timestamp - message.timestamp > 60_000;

    items.push({ kind: 'message', id: message.id, message, showTail });
  });

  return items;
}

export function formatClock(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  });
}

export { dequeue as dropQueued };
