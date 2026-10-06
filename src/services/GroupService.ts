import {
  GROUP_DESCRIPTION_MAX,
  GROUP_MAX_MEMBERS,
  GROUP_NAME_MAX,
  type ChatSummary,
  type GroupMember,
  type SystemEvent,
  type UserProfile,
} from '@/src/config/types';
import {
  Paths,
  fanOut,
  onValue,
  pushKey,
  readOnce,
  remove,
  serverTimestamp,
  update,
  write,
  type Unsubscribe,
} from './FirebaseService';
import { appState } from './StateManager';
import { clearQueueForChat } from './OfflineQueue';
import { previewFor } from './ChatEngine';

/**
 * GroupService — creation and membership for group chats.
 *
 * Three things shape this file:
 *
 *  1. Group chat ids are push keys, not the sorted `a_b` join used for 1:1.
 *     A group's membership changes over its life, so an id derived from the
 *     members would stop identifying it the moment someone left.
 *
 *  2. Every membership or metadata change writes a `system` message. That is
 *     what makes the change visible in the transcript instead of the member list
 *     silently differing from what people remember.
 *
 *  3. System messages are written here rather than through ChatEngine's
 *     `sendText`, because they are never queued offline and never optimistic:
 *     they describe a write that either landed or did not.
 */

/** Fails loudly rather than writing a group nobody can moderate. */
function assertAdmin(chat: ChatSummary | undefined, uid: string): void {
  if (!chat) throw new Error('Group not found');
  if (chat.admins?.[uid] !== true) throw new Error('Only admins can do that');
}

function chatOf(chatId: string): ChatSummary | undefined {
  return appState.get().chats[chatId];
}

/**
 * Writes a `system` row plus the chat-list preview, in one fan-out.
 *
 * Unread counters are deliberately not bumped: a rename should not make a chat
 * look like it has unread messages waiting.
 */
async function writeSystemMessage(
  chatId: string,
  authorUid: string,
  event: SystemEvent,
  preview: string,
  /**
   * Whose chat index to bump. Defaults to the store's participant list, which is
   * right for every case except a group that was created moments ago and has not
   * reached the store yet — there the caller passes the list it just wrote.
   */
  recipients?: string[]
): Promise<void> {
  const messageId = pushKey(Paths.messages(chatId));
  const participants =
    recipients ?? Object.keys(chatOf(chatId)?.participants ?? { [authorUid]: true });

  const updates: Record<string, unknown> = {
    [Paths.message(chatId, messageId)]: {
      senderId: authorUid,
      type: 'system',
      text: null,
      mediaUrl: null,
      thumbUrl: null,
      width: null,
      height: null,
      durationMs: null,
      timestamp: serverTimestamp(),
      seenBy: {},
      deliveredTo: {},
      edited: false,
      deleted: false,
      reactions: {},
      replyTo: null,
      forwardedFrom: null,
      event,
    },
    [`${Paths.chat(chatId)}/lastMessage`]: {
      text: preview,
      type: 'system',
      senderId: authorUid,
      deleted: false,
    },
    [`${Paths.chat(chatId)}/lastTimestamp`]: serverTimestamp(),
  };

  for (const uid of participants) {
    updates[`${Paths.userChat(uid, chatId)}/lastTimestamp`] = serverTimestamp();
  }

  await fanOut(updates);
}

/**
 * Adds members to a group that already exists on the server.
 *
 * Split out of both `createGroup` and `addMembers` because the rules authorise
 * this write by looking the caller up in `chats/{chatId}/admins` — which requires
 * the chat to be there to look at. It deliberately does not consult the store, so
 * it works for a group created milliseconds ago that no listener has seen yet.
 */
async function seedMembers(chatId: string, uids: string[]): Promise<void> {
  if (uids.length === 0) return;
  const updates: Record<string, unknown> = {};
  for (const uid of uids) {
    updates[`${Paths.chat(chatId)}/participants/${uid}`] = true;
    updates[`${Paths.chat(chatId)}/unread/${uid}`] = 0;
    updates[Paths.userChat(uid, chatId)] = { lastTimestamp: serverTimestamp() };
    // BUG-14: join order for admin promotion. This is the single funnel every
    // group add flows through, so seniority is recorded exactly once per join.
    updates[Paths.memberSince(chatId, uid)] = serverTimestamp();
  }
  await fanOut(updates);
}

/**
 * Longest-standing remaining member, for admin promotion on leave.
 *
 * Reads `memberSince` rather than trusting key order: `Object.keys` is
 * insertion order of the local snapshot, which is uid order after a cold
 * start, not join order. Members who joined before the node existed have no
 * entry and sort last, preserving the old behaviour for old groups.
 */
async function longestStanding(chatId: string, candidates: string[]): Promise<string> {
  const fallback = candidates[0];
  try {
    const snap = await readOnce<Record<string, number>>(`memberSince/${chatId}`);
    if (!snap) return fallback;
    let best = fallback;
    let bestAt = Number.POSITIVE_INFINITY;
    for (const uid of candidates) {
      const at = snap[uid];
      if (typeof at === 'number' && at < bestAt) {
        best = uid;
        bestAt = at;
      }
    }
    return best;
  } catch {
    return fallback;
  }
}

/**
 * Creates the group and returns its id.
 *
 * The creator is the sole admin. `memberUids` is the invite list without the
 * creator; duplicates and the creator's own uid are tolerated so callers can
 * pass a raw selection.
 *
 * This is three sequential writes, not one, and it has to be. Every `userChats`
 * entry — including the creator's own — is authorised by looking the writer up in
 * `chats/{chatId}`, and the rules evaluate that against the *pre-write* tree. So
 * the chat has to land before any index entry pointing at it can be accepted, and
 * the creator has to be an admin of a chat that exists before they can seed
 * anybody else's.
 */
export async function createGroup(
  creatorUid: string,
  name: string,
  memberUids: string[],
  photoURL: string | null = null
): Promise<string> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('A group needs a name');
  if (trimmed.length > GROUP_NAME_MAX) throw new Error('That name is too long');

  const others = Array.from(new Set(memberUids)).filter((uid) => uid !== creatorUid);
  if (others.length === 0) throw new Error('Add at least one other person');
  if (others.length + 1 > GROUP_MAX_MEMBERS) {
    throw new Error(`A group can hold ${GROUP_MAX_MEMBERS} people`);
  }

  const chatId = pushKey(Paths.chats());

  await write(Paths.chat(chatId), {
    isGroup: true,
    name: trimmed,
    photoURL,
    description: null,
    participants: { [creatorUid]: true },
    admins: { [creatorUid]: true },
    createdBy: creatorUid,
    createdAt: serverTimestamp(),
    lastMessage: null,
    lastTimestamp: serverTimestamp(),
    unread: { [creatorUid]: 0 },
  });

  // The creator goes through `seedMembers` alongside everyone else. Their
  // participant and unread entries are already there from the write above, so
  // those two paths are rewritten to the same values; what this actually
  // accomplishes is their `userChats` index, which could not have been part of
  // the creation write.
  await seedMembers(chatId, [creatorUid, ...others]);

  const everyone = [creatorUid, ...others];
  await writeSystemMessage(
    chatId,
    creatorUid,
    { kind: 'group_created', by: creatorUid },
    previewFor('text', 'Group created'),
    everyone
  );
  await writeSystemMessage(
    chatId,
    creatorUid,
    { kind: 'members_added', by: creatorUid, uids: others },
    'Members added',
    everyone
  );

  return chatId;
}

/** Adds members. Admin-only, and capped at the same limit the rules enforce. */
export async function addMembers(
  chatId: string,
  byUid: string,
  uids: string[]
): Promise<void> {
  const chat = chatOf(chatId);
  assertAdmin(chat, byUid);

  const existing = Object.keys(chat!.participants ?? {});
  const fresh = Array.from(new Set(uids)).filter((uid) => !existing.includes(uid));
  if (fresh.length === 0) return;
  if (existing.length + fresh.length > GROUP_MAX_MEMBERS) {
    throw new Error(`A group can hold ${GROUP_MAX_MEMBERS} people`);
  }

  await seedMembers(chatId, fresh);

  await writeSystemMessage(
    chatId,
    byUid,
    { kind: 'members_added', by: byUid, uids: fresh },
    'Members added',
    [...existing, ...fresh]
  );
}

/**
 * Removes a member. Admin-only, and an admin cannot remove themselves this way
 * — that is `leaveGroup`, which has to hand over the last admin slot.
 */
export async function removeMember(
  chatId: string,
  byUid: string,
  uid: string
): Promise<void> {
  const chat = chatOf(chatId);
  assertAdmin(chat, byUid);
  if (uid === byUid) throw new Error('Use "leave group" to remove yourself');

  // The system message is written first, while the target is still a
  // participant: the rules only accept writes from members, and the removed
  // member's own client needs the row to explain why the chat went away.
  await writeSystemMessage(chatId, byUid, { kind: 'member_removed', by: byUid, uid }, 'Member removed');

  await fanOut({
    [`${Paths.chat(chatId)}/participants/${uid}`]: null,
    [`${Paths.chat(chatId)}/admins/${uid}`]: null,
    [`${Paths.chat(chatId)}/unread/${uid}`]: null,
    [Paths.memberSince(chatId, uid)]: null,
    [Paths.userChat(uid, chatId)]: null,
  });
}

/**
 * Leaves the group.
 *
 * If the leaver is the last admin, the longest-standing remaining member is
 * promoted — a group with no admin can never be renamed or moderated again.
 *
 * The last member out does not delete the chat node. Nothing in this app deletes
 * a shared chat — `deleteChatForMe` does not either — because the rules make
 * `chats/{id}` create-only, and a client that could delete the node could delete
 * a live conversation out from under everyone still in it. An emptied group is
 * left orphaned and unreadable instead: its read rule requires the reader to be a
 * participant, and by then nobody is.
 */
export async function leaveGroup(chatId: string, uid: string): Promise<void> {
  const chat = chatOf(chatId);
  if (!chat) throw new Error('Group not found');

  const others = Object.keys(chat.participants ?? {}).filter((u) => u !== uid);

  if (others.length === 0) {
    // BUG-30: same resurrection as deleteChatForMe — drop queued sends first.
    await clearQueueForChat(chatId);
    await fanOut({
      [`${Paths.chat(chatId)}/participants/${uid}`]: null,
      [`${Paths.chat(chatId)}/admins/${uid}`]: null,
      [`${Paths.chat(chatId)}/unread/${uid}`]: null,
      [Paths.memberSince(chatId, uid)]: null,
      [Paths.userChat(uid, chatId)]: null,
    });
    appState.get().removeChat(chatId);
    return;
  }

  await writeSystemMessage(chatId, uid, { kind: 'member_left', uid }, 'Member left');

  const admins = chat.admins ?? {};
  const remainingAdmins = others.filter((u) => admins[u] === true);
  const updates: Record<string, unknown> = {
    [`${Paths.chat(chatId)}/participants/${uid}`]: null,
    [`${Paths.chat(chatId)}/admins/${uid}`]: null,
    [`${Paths.chat(chatId)}/unread/${uid}`]: null,
    [Paths.memberSince(chatId, uid)]: null,
    [Paths.userChat(uid, chatId)]: null,
  };
  if (admins[uid] === true && remainingAdmins.length === 0) {
    updates[`${Paths.chat(chatId)}/admins/${await longestStanding(chatId, others)}`] = true;
  }

  await clearQueueForChat(chatId);
  await fanOut(updates);
  appState.get().removeChat(chatId);
}

export async function renameGroup(
  chatId: string,
  byUid: string,
  name: string
): Promise<void> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('A group needs a name');
  if (trimmed.length > GROUP_NAME_MAX) throw new Error('That name is too long');
  assertAdmin(chatOf(chatId), byUid);

  await update(Paths.chat(chatId), { name: trimmed });
  await writeSystemMessage(
    chatId,
    byUid,
    { kind: 'group_renamed', by: byUid, name: trimmed },
    'Group renamed'
  );
}

export async function setGroupPhoto(
  chatId: string,
  byUid: string,
  photoURL: string | null
): Promise<void> {
  assertAdmin(chatOf(chatId), byUid);
  await update(Paths.chat(chatId), { photoURL });
  await writeSystemMessage(
    chatId,
    byUid,
    { kind: 'group_photo_changed', by: byUid },
    photoURL ? 'Group photo changed' : 'Group photo removed'
  );
}

/** No system message: the description is not something people announce. */
export async function setGroupDescription(
  chatId: string,
  byUid: string,
  description: string
): Promise<void> {
  const trimmed = description.trim();
  if (trimmed.length > GROUP_DESCRIPTION_MAX) throw new Error('That description is too long');
  assertAdmin(chatOf(chatId), byUid);
  await update(Paths.chat(chatId), { description: trimmed || null });
}

export async function grantAdmin(chatId: string, byUid: string, uid: string): Promise<void> {
  const chat = chatOf(chatId);
  assertAdmin(chat, byUid);
  if (chat!.participants?.[uid] !== true) throw new Error('That person is not in this group');

  await write(`${Paths.chat(chatId)}/admins/${uid}`, true);
  await writeSystemMessage(chatId, byUid, { kind: 'admin_granted', by: byUid, uid }, 'New admin');
}

export async function revokeAdmin(chatId: string, byUid: string, uid: string): Promise<void> {
  const chat = chatOf(chatId);
  assertAdmin(chat, byUid);
  if (uid === chat!.createdBy) throw new Error('The group creator stays an admin');

  const admins = Object.keys(chat!.admins ?? {}).filter((u) => chat!.admins[u] === true);
  // No-op first: revoking a non-admin in a single-admin group used to throw
  // "needs at least one admin" for an operation that changes nothing.
  if (!admins.includes(uid)) return;
  if (admins.length <= 1) throw new Error('A group needs at least one admin');

  await remove(`${Paths.chat(chatId)}/admins/${uid}`);
  await writeSystemMessage(chatId, byUid, { kind: 'admin_revoked', by: byUid, uid }, 'Admin removed');
}

/**
 * Resolves the member list for the group info screen.
 *
 * Profiles come from the store's cache when present and are fetched once
 * otherwise; a member whose profile cannot be read renders as null rather than
 * dropping out of the list, so the count always matches the group.
 */
export function listenToGroupMembers(
  chatId: string,
  cb: (members: GroupMember[]) => void
): Unsubscribe {
  const cache = new Map<string, UserProfile | null>();

  return onValue(Paths.chat(chatId), (snap) => {
    const raw = snap.val() as Record<string, unknown> | null;
    if (!raw) {
      cb([]);
      return;
    }
    const participants = (raw.participants as Record<string, boolean>) ?? {};
    const admins = (raw.admins as Record<string, boolean>) ?? {};
    const uids = Object.keys(participants).filter((uid) => participants[uid] === true);

    const emit = () => {
      cb(
        uids
          .map((uid) => ({
            uid,
            profile: cache.get(uid) ?? appState.get().users[uid] ?? null,
            isAdmin: admins[uid] === true,
          }))
          // Admins first, then alphabetically — the order WhatsApp uses.
          .sort((a, b) => {
            if (a.isAdmin !== b.isAdmin) return a.isAdmin ? -1 : 1;
            return (a.profile?.name ?? '').localeCompare(b.profile?.name ?? '');
          })
      );
    };

    emit();

    for (const uid of uids) {
      if (cache.has(uid) || appState.get().users[uid]) continue;
      cache.set(uid, null);
      readOnce<UserProfile>(Paths.user(uid))
        .then((profile) => {
          cache.set(uid, profile ? { ...profile, uid } : null);
          emit();
        })
        .catch(() => {});
    }
  });
}
