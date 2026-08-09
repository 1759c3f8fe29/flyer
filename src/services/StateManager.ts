import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import { Limits } from '@/src/config/env';
import type {
  CallRecord,
  CallState,
  CallType,
  ChatSummary,
  Contact,
  ContactRequest,
  Message,
  UserProfile,
} from '@/src/config/types';

/**
 * StateManager — single global store.
 *
 * Messages are held per-chat rather than only for the active chat so that
 * switching back to a recent chat renders instantly from memory while its
 * listener re-attaches.
 */

export interface ActiveCall {
  callId: string;
  peerId: string;
  peer: UserProfile | null;
  type: CallType;
  direction: 'incoming' | 'outgoing';
  state: CallState;
  /** Set when the peer connection reports `connected`; drives the timer. */
  connectedAt: number | null;
  micMuted: boolean;
  videoEnabled: boolean;
  speakerOn: boolean;
  frontCamera: boolean;
  /** True while ICE is restarting after a drop. */
  reconnecting: boolean;
  endedReason: CallRecord['endedReason'];
}

export type NetworkStatus = 'online' | 'offline' | 'reconnecting';

interface AppState {
  // --- auth / me ---
  currentUser: UserProfile | null;
  authReady: boolean;

  // --- chats ---
  chats: Record<string, ChatSummary>;
  activeChatId: string | null;
  messages: Record<string, Message[]>;
  /** chatId -> uid -> last keystroke ms */
  typingState: Record<string, Record<string, number>>;
  /** Cache of peer profiles, keyed by uid. */
  users: Record<string, UserProfile>;

  // --- calls ---
  callState: CallState;
  activeCall: ActiveCall | null;

  // --- connectivity ---
  networkStatus: NetworkStatus;
  pendingCount: number;

  // --- contacts ---
  contacts: Contact[];
  /** Incoming and outgoing pending requests share one list. */
  requests: ContactRequest[];

  // --- prefs ---
  themeMode: 'system' | 'light' | 'dark';
  blocked: Record<string, boolean>;

  // --- actions ---
  setCurrentUser: (u: UserProfile | null) => void;
  patchCurrentUser: (patch: Partial<UserProfile>) => void;
  setAuthReady: (v: boolean) => void;

  setChats: (chats: Record<string, ChatSummary>) => void;
  upsertChat: (chat: ChatSummary) => void;
  removeChat: (chatId: string) => void;
  setActiveChat: (chatId: string | null) => void;

  setMessages: (chatId: string, messages: Message[]) => void;
  upsertMessage: (chatId: string, message: Message) => void;
  removeMessage: (chatId: string, messageId: string) => void;

  setTyping: (chatId: string, map: Record<string, number>) => void;
  cacheUser: (user: UserProfile) => void;
  cacheUsers: (users: UserProfile[]) => void;
  /**
   * Fold partial knowledge of a user into the cache.
   *
   * Distinct from `cacheUser`, which replaces. A directory search returns a
   * projection — name, handle, photo, and nothing else — so replacing with it
   * would blank the `about` and `lastSeen` of someone you already have a chat
   * with the moment they turn up in a search result.
   */
  mergeUser: (user: Partial<UserProfile> & { uid: string }) => void;

  setCallState: (s: CallState) => void;
  startCall: (call: ActiveCall) => void;
  patchCall: (patch: Partial<ActiveCall>) => void;
  clearCall: () => void;

  setNetworkStatus: (s: NetworkStatus) => void;
  setPendingCount: (n: number) => void;

  setThemeMode: (m: 'system' | 'light' | 'dark') => void;
  setBlocked: (map: Record<string, boolean>) => void;

  setContacts: (list: Contact[]) => void;
  setRequests: (list: ContactRequest[]) => void;

  reset: () => void;
}

const initial = {
  currentUser: null as UserProfile | null,
  authReady: false,
  chats: {} as Record<string, ChatSummary>,
  activeChatId: null as string | null,
  messages: {} as Record<string, Message[]>,
  typingState: {} as Record<string, Record<string, number>>,
  users: {} as Record<string, UserProfile>,
  callState: 'idle' as CallState,
  activeCall: null as ActiveCall | null,
  networkStatus: 'online' as NetworkStatus,
  pendingCount: 0,
  themeMode: 'system' as 'system' | 'light' | 'dark',
  blocked: {} as Record<string, boolean>,
  contacts: [] as Contact[],
  requests: [] as ContactRequest[],
};

/** Messages are kept sorted ascending; dedup by id (server echo vs local). */
function mergeMessage(list: Message[], message: Message): Message[] {
  const idx = list.findIndex((m) => m.id === message.id);
  if (idx === -1) {
    const next = [...list, message];
    next.sort((a, b) => a.timestamp - b.timestamp);
    return next;
  }
  const next = [...list];
  next[idx] = { ...next[idx], ...message };
  return next;
}

export const useAppStore = create<AppState>((set) => ({
  ...initial,

  setCurrentUser: (currentUser) => set({ currentUser }),
  patchCurrentUser: (patch) =>
    set((s) => (s.currentUser ? { currentUser: { ...s.currentUser, ...patch } } : s)),
  setAuthReady: (authReady) => set({ authReady }),

  setChats: (chats) => set({ chats }),
  upsertChat: (chat) => set((s) => ({ chats: { ...s.chats, [chat.id]: chat } })),
  removeChat: (chatId) =>
    set((s) => {
      const chats = { ...s.chats };
      delete chats[chatId];
      const messages = { ...s.messages };
      delete messages[chatId];
      return { chats, messages };
    }),
  setActiveChat: (activeChatId) => set({ activeChatId }),

  setMessages: (chatId, list) =>
    set((s) => ({ messages: { ...s.messages, [chatId]: list } })),
  upsertMessage: (chatId, message) =>
    set((s) => ({
      messages: {
        ...s.messages,
        [chatId]: mergeMessage(s.messages[chatId] ?? [], message),
      },
    })),
  removeMessage: (chatId, messageId) =>
    set((s) => ({
      messages: {
        ...s.messages,
        [chatId]: (s.messages[chatId] ?? []).filter((m) => m.id !== messageId),
      },
    })),

  setTyping: (chatId, map) =>
    set((s) => ({ typingState: { ...s.typingState, [chatId]: map } })),
  cacheUser: (user) => set((s) => ({ users: { ...s.users, [user.uid]: user } })),
  cacheUsers: (list) =>
    set((s) => {
      const users = { ...s.users };
      for (const u of list) users[u.uid] = u;
      return { users };
    }),
  mergeUser: (user) =>
    set((s) => {
      const existing = s.users[user.uid];
      // Undefined means "not fetched", so it must not overwrite. An explicit
      // null does mean "cleared" and is allowed through.
      const patch = Object.fromEntries(
        Object.entries(user).filter(([, v]) => v !== undefined)
      ) as Partial<UserProfile>;
      return { users: { ...s.users, [user.uid]: { ...existing, ...patch } as UserProfile } };
    }),

  setCallState: (callState) =>
    set((s) => ({
      callState,
      activeCall: s.activeCall ? { ...s.activeCall, state: callState } : null,
    })),
  startCall: (activeCall) => set({ activeCall, callState: activeCall.state }),
  patchCall: (patch) =>
    set((s) => (s.activeCall ? { activeCall: { ...s.activeCall, ...patch } } : s)),
  clearCall: () => set({ activeCall: null, callState: 'idle' }),

  setNetworkStatus: (networkStatus) => set({ networkStatus }),
  setPendingCount: (pendingCount) => set({ pendingCount }),

  setThemeMode: (themeMode) => set({ themeMode }),
  setBlocked: (blocked) => set({ blocked }),

  setContacts: (contacts) => set({ contacts }),
  setRequests: (requests) => set({ requests }),

  reset: () => set({ ...initial, authReady: true }),
}));

/** Non-reactive access, for use inside services and background handlers. */
export const appState = {
  get: () => useAppStore.getState(),
  set: useAppStore.setState,
};

// --- selectors ---

/**
 * Pinned chats first, then most-recent. Archived chats are excluded — they live
 * behind the "Archived" row, exactly like WhatsApp.
 */
export const selectSortedChats = (s: AppState): ChatSummary[] =>
  Object.values(s.chats)
    .filter((c) => !c.archived)
    .sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return b.lastTimestamp - a.lastTimestamp;
    });

export const selectArchivedChats = (s: AppState): ChatSummary[] =>
  Object.values(s.chats)
    .filter((c) => c.archived)
    .sort((a, b) => b.lastTimestamp - a.lastTimestamp);

/**
 * Memoised hooks for the derived-array selectors above.
 *
 * These must be used instead of `useAppStore(selectSortedChats)`. zustand 5
 * dropped the automatic equality check that v4's `useStore(selector, shallow)`
 * gave you — the default `useStore` compares with `Object.is`, so a selector
 * building a fresh array (which every one of these does: filter + sort) is a new
 * reference on every single store write. That re-renders the whole chat list on
 * each keystroke of a typing indicator, and React 18's `useSyncExternalStore`
 * can escalate it to a "getSnapshot should be cached" infinite loop.
 *
 * `useShallow` keeps the previous array when its elements are pairwise ===,
 * which holds because the store replaces chat objects only when they change.
 */
export const useSortedChats = (): ChatSummary[] =>
  useAppStore(useShallow(selectSortedChats));

export const useArchivedChats = (): ChatSummary[] =>
  useAppStore(useShallow(selectArchivedChats));

/**
 * Count of archived chats. A number, so it needs no shallow wrapper — deriving
 * it here rather than in the screen keeps the length out of the render path.
 */
export const selectArchivedCount = (s: AppState): number => {
  let n = 0;
  for (const c of Object.values(s.chats)) if (c.archived) n++;
  return n;
};

/**
 * Unread across archived chats too: the count on the Archived row is what tells
 * the user something is waiting in there.
 */
export const selectArchivedUnread = (s: AppState): number => {
  const uid = s.currentUser?.uid;
  if (!uid) return 0;
  return Object.values(s.chats)
    .filter((c) => c.archived)
    .reduce((sum, c) => sum + (c.unread?.[uid] ?? 0), 0);
};

export const selectTotalUnread = (s: AppState): number => {
  const uid = s.currentUser?.uid;
  if (!uid) return 0;
  return Object.values(s.chats).reduce((sum, c) => sum + (c.unread?.[uid] ?? 0), 0);
};

/**
 * How long a typing flag that was never cleared keeps showing.
 *
 * The writer removes the node one idle window after the last keystroke, and that
 * removal — not this cutoff — is what normally ends the indicator. The cutoff
 * only governs flags whose removal never ran: the app was backgrounded
 * mid-keystroke, which suspends the clearing timer on both platforms.
 *
 * Derived rather than the flat 6000 it used to be. At double the idle window, a
 * peer who backgrounded the app stayed "typing…" for twice as long as they had
 * actually been idle. The extra second is slack for write latency, so a flag
 * still being refreshed is never judged stale between keystrokes.
 */
const TYPING_STALE_MS = Limits.typingIdleMs + 1000;

export const selectPeerTyping = (chatId: string, myUid: string) => (s: AppState) => {
  const map = s.typingState[chatId];
  if (!map) return false;
  const cutoff = Date.now() - TYPING_STALE_MS;
  return Object.entries(map).some(([uid, ts]) => uid !== myUid && ts > cutoff);
};

export const selectIncomingRequests = (s: AppState): ContactRequest[] =>
  s.requests.filter((r) => r.direction === 'incoming');

export const selectOutgoingRequests = (s: AppState): ContactRequest[] =>
  s.requests.filter((r) => r.direction === 'outgoing');

export const useIncomingRequests = (): ContactRequest[] =>
  useAppStore(useShallow(selectIncomingRequests));

export const useOutgoingRequests = (): ContactRequest[] =>
  useAppStore(useShallow(selectOutgoingRequests));

/** Drives the badge on the Contacts tab. */
export const selectIncomingRequestCount = (s: AppState): number =>
  s.requests.reduce((n, r) => n + (r.direction === 'incoming' ? 1 : 0), 0);
