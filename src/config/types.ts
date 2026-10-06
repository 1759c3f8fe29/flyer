/** Shared domain types. The RTDB shape is documented in database.rules.json. */

/**
 * `system` is not something a user can send. It carries group events ("Ana added
 * Ben", "Ana changed the group name") and renders as a centred pill rather than
 * a bubble, which is why it lives in the same union as the sendable types.
 */
export type MessageType = 'text' | 'image' | 'video' | 'audio' | 'system';

/** Sendable subset — everything a composer can produce. */
export type SendableMessageType = Exclude<MessageType, 'system'>;

/**
 * What a `system` message describes. Stored on the message as `event` so the
 * label can be re-rendered in the reader's own language and with current names,
 * rather than freezing English text at write time.
 */
export type SystemEvent =
  | { kind: 'group_created'; by: string }
  | { kind: 'members_added'; by: string; uids: string[] }
  | { kind: 'member_removed'; by: string; uid: string }
  | { kind: 'member_left'; uid: string }
  | { kind: 'group_renamed'; by: string; name: string }
  | { kind: 'group_photo_changed'; by: string }
  | { kind: 'admin_granted'; by: string; uid: string }
  | { kind: 'admin_revoked'; by: string; uid: string };

export type CallType = 'voice' | 'video';

export type CallState =
  | 'idle'
  | 'calling'
  | 'ringing'
  | 'accepted'
  | 'rejected'
  | 'ended';

export interface UserProfile {
  uid: string;
  name: string;
  /**
   * Lowercase handle, unique across the app. Nullable because accounts created
   * before usernames existed have none until the owner picks one.
   */
  username: string | null;
  email: string;
  photoURL: string | null;
  about: string;
  online: boolean;
  lastSeen: number;
  createdAt: number;
  privacy: PrivacySettings;
}

export interface PrivacySettings {
  /** When false, peers see "online"/"last seen" as hidden. */
  showLastSeen: boolean;
  showPhoto: boolean;
  showAbout: boolean;
  /** Read receipts are mutual: disabling also hides other people's from you. */
  readReceipts: boolean;
  /** N-10: lock-screen pushes carry "New message" instead of the preview. */
  hidePreview: boolean;
}

export const DEFAULT_PRIVACY: PrivacySettings = {
  showLastSeen: true,
  showPhoto: true,
  showAbout: true,
  readReceipts: true,
  hidePreview: false,
};

export interface ReplyRef {
  messageId: string;
  senderId: string;
  type: MessageType;
  preview: string;
}

export interface Message {
  id: string;
  chatId: string;
  senderId: string;
  type: MessageType;
  text: string | null;
  mediaUrl: string | null;
  /** Poster frame for video; also used as the blurred placeholder for images. */
  thumbUrl: string | null;
  width: number | null;
  height: number | null;
  /** Milliseconds, for audio and video. */
  durationMs: number | null;
  timestamp: number;
  seenBy: Record<string, number>;
  /** N-02: uid -> server ms when that device received the push (2nd tick). */
  deliveredTo: Record<string, number>;
  edited: boolean;
  deleted: boolean;
  reactions: Record<string, string>;
  /**
   * uids who deleted this message for themselves only. Filtered client-side —
   * the message still exists for everyone else, so it cannot be removed
   * server-side the way "delete for everyone" is.
   */
  hiddenFor: Record<string, boolean>;
  replyTo: ReplyRef | null;
  forwardedFrom: string | null;
  /** Set only on `system` messages; null on everything a user sent. */
  event: SystemEvent | null;
  /** Client-only: set for messages sitting in the offline queue. */
  pending?: boolean;
  /** Client-only: set when a queued send exhausted its retries. */
  failed?: boolean;
}

/** Upper bound on a group's membership, matching the rules' own cap. */
export const GROUP_MAX_MEMBERS = 256;

export const GROUP_NAME_MAX = 60;
export const GROUP_DESCRIPTION_MAX = 300;

export interface ChatSummary {
  id: string;
  participants: Record<string, boolean>;
  lastMessage: {
    text: string;
    type: MessageType;
    senderId: string;
    deleted: boolean;
  } | null;
  lastTimestamp: number;
  /** uid -> epoch ms until which the chat is muted (0 = not muted). */
  mutedBy: Record<string, number>;
  /** uid -> timestamp before which messages are hidden for that user only. */
  clearedAt: Record<string, number>;
  unread: Record<string, number>;
  /**
   * Per-user flags mirrored from `userChats/{myUid}/{chatId}`, not from the
   * shared chat node — only the signed-in user's own values are ever readable,
   * so these describe *me*, not the conversation.
   */
  pinned: boolean;
  archived: boolean;

  /*
   * --- group fields ------------------------------------------------------
   * Absent on 1:1 chats. `isGroup` is the discriminant rather than
   * `participants.length > 2`: a group that has shrunk to two people is still a
   * group, and must not start behaving like a direct chat.
   */
  isGroup: boolean;
  /** Group display name. Null on 1:1, where the peer's own name is used. */
  name: string | null;
  photoURL: string | null;
  description: string | null;
  /** uid -> true. Admins can rename, change the photo, and add or remove. */
  admins: Record<string, boolean>;
  createdBy: string | null;
  createdAt: number;
}

/** A group member with their profile resolved, ready to render in a list. */
export interface GroupMember {
  uid: string;
  profile: UserProfile | null;
  isAdmin: boolean;
}

export interface CallRecord {
  id: string;
  callerId: string;
  calleeId: string;
  type: CallType;
  state: CallState;
  createdAt: number;
  answeredAt: number | null;
  endedAt: number | null;
  endedReason: 'hangup' | 'rejected' | 'missed' | 'failed' | 'busy' | null;
}

export interface CallHistoryEntry {
  callId: string;
  peerId: string;
  type: CallType;
  direction: 'incoming' | 'outgoing';
  state: CallState;
  startedAt: number;
  durationMs: number;
  missed: boolean;
}

/** An accepted, mutual contact. Stored under `contacts/{myUid}/{uid}`. */
export interface Contact {
  uid: string;
  addedAt: number;
}

/**
 * A pending contact request. The same shape is stored twice — under the
 * recipient's `contactRequests` (so they can see and answer it) and the
 * sender's `sentRequests` (so they can see it is pending and cancel it).
 */
export interface ContactRequest {
  /** The other party: sender for incoming, recipient for outgoing. */
  uid: string;
  createdAt: number;
  direction: 'incoming' | 'outgoing';
}

export interface StarredRef {
  key: string;
  chatId: string;
  messageId: string;
  starredAt: number;
}

/** A send that could not reach the server and is persisted until it can. */
export interface QueuedSend {
  id: string;
  chatId: string;
  draft: Omit<Message, 'id' | 'chatId' | 'timestamp' | 'seenBy' | 'deliveredTo'>;
  /** Local file uri that still needs uploading, if any. */
  localUri: string | null;
  attempts: number;
  /** Earliest server-ms to retry after a failure (backoff). Absent = due. */
  nextRetryAt?: number;
  queuedAt: number;
}
