import { Platform } from 'react-native';
import messaging, {
  type FirebaseMessagingTypes,
} from '@react-native-firebase/messaging';
import { Paths, remove, serverTimestamp, write } from './FirebaseService';
import { appState } from './StateManager';

/**
 * NotificationManager — FCM token lifecycle, foreground handling, and taps.
 *
 * Background/terminated delivery is handled in BackgroundTaskManager (registered
 * before React mounts). This module owns everything that needs the app to be
 * alive: the in-app banner, the token registry, and navigation on tap.
 */

export interface Banner {
  chatId: string;
  senderId: string;
  title: string;
  body: string;
  messageId?: string;
}

type Navigate = (path: string) => void;

let navigate: Navigate | null = null;
let bannerHandler: ((b: Banner) => void) | null = null;
let teardown: (() => void)[] = [];
let currentToken: string | null = null;

export function setNavigator(fn: Navigate) {
  navigate = fn;
}

export function setBannerHandler(fn: (b: Banner) => void) {
  bannerHandler = fn;
}

export function getToken(): string | null {
  return currentToken;
}

/**
 * Tokens are stored as a set per user (`fcmTokens/{uid}/{token}`) rather than a
 * single field, because one account can be signed in on several devices and a
 * single field would silently stop the others from ringing.
 */
async function persistToken(uid: string, token: string) {
  currentToken = token;
  await write(Paths.userToken(uid, token), {
    platform: Platform.OS,
    updatedAt: serverTimestamp(),
  }).catch((e) => console.warn('[Flyer/fcm] token persist failed', e));
}

export async function start(uid: string): Promise<void> {
  stop();

  try {
    // iOS will not issue an FCM token until APNs registration completes.
    if (Platform.OS === 'ios') {
      await messaging().registerDeviceForRemoteMessages();
    }

    const token = await messaging().getToken();
    if (token) await persistToken(uid, token);
  } catch (e) {
    console.warn('[Flyer/fcm] could not obtain token', e);
  }

  const offRefresh = messaging().onTokenRefresh(async (token) => {
    // Drop the stale entry so Cloud Functions is not sending into the void.
    if (currentToken && currentToken !== token) {
      await remove(Paths.userToken(uid, currentToken)).catch(() => {});
    }
    await persistToken(uid, token);
  });
  teardown.push(offRefresh);

  const offMessage = messaging().onMessage(handleForeground);
  teardown.push(offMessage);

  // Tapped a notification while the app was backgrounded (not killed).
  const offOpened = messaging().onNotificationOpenedApp(handleTap);
  teardown.push(offOpened);

  // Tapped a notification that cold-started the app.
  const initial = await messaging().getInitialNotification();
  if (initial) {
    // Defer: the router is not mounted yet on the very first tick. Tracked so
    // stop() can cancel it — a sign-out inside the window would otherwise land
    // the next session on the previous account's chat.
    const timer = setTimeout(() => handleTap(initial), 600);
    teardown.push(() => clearTimeout(timer));
  }
}

export function stop() {
  for (const fn of teardown) {
    try {
      fn();
    } catch {
      /* ignore */
    }
  }
  teardown = [];
}

export async function unregisterToken(uid: string): Promise<void> {
  if (!currentToken) return;
  await remove(Paths.userToken(uid, currentToken)).catch(() => {});
  currentToken = null;
}

/**
 * Foreground delivery. FCM does not draw a notification while the app is in the
 * foreground, which is correct — we show an in-app banner instead, and suppress
 * it entirely for the chat the user is already looking at.
 */
function handleForeground(message: FirebaseMessagingTypes.RemoteMessage) {
  const data = message.data as Record<string, string> | undefined;
  if (!data) return;

  // Reactions banner through the same path as messages: both are "someone did
  // something in a chat you are not looking at", and both open that chat.
  if (data.kind === 'message' || data.kind === 'reaction') {
    const { chatId, senderId, messageId } = data;
    if (!chatId) return;

    // Blocked first: a delivery receipt confirms activity to someone the user
    // blocked, so a blocked sender gets neither banner nor receipt.
    const blocked = Boolean(senderId && appState.get().blocked[senderId]);

    // N-02: a push that reached a live app is delivered, whether or not the
    // user opens the chat. The background handler covers the killed case.
    const myUid = appState.get().currentUser?.uid;
    if (!blocked && data.kind === 'message' && myUid && messageId && senderId !== myUid) {
      void write(Paths.deliveredTo(chatId, messageId, myUid), serverTimestamp()).catch(
        () => {}
      );
    }

    if (appState.get().activeChatId === chatId) return;
    if (blocked) return;

    bannerHandler?.({
      chatId,
      senderId: senderId ?? '',
      title: message.notification?.title ?? 'New message',
      body: message.notification?.body ?? '',
      messageId,
    });
  }

  // Call pushes need no foreground handling: the RTDB `incoming/{uid}` listener
  // in CallManager is already live and rings faster than the push arrives.
}

function handleTap(message: FirebaseMessagingTypes.RemoteMessage) {
  const data = message.data as Record<string, string> | undefined;
  if (!data || !navigate) return;

  if ((data.kind === 'message' || data.kind === 'reaction') && data.chatId) {
    navigate(`/chat/${data.chatId}`);
  }
  // N-04: a missed call is over — the live call screen would show a dead call.
  // Route to the caller's chat instead, carrying who rang.
  if (data.kind === 'missed_call' && data.chatId) {
    navigate(`/chat/${data.chatId}`);
  }
  if (data.kind === 'call') {
    navigate('/call');
  }
}

// N-05 badge, deliberately absent: the icon count must be the *total* across
// all chats, and the function does not have it without reading every chat per
// message. RNFirebase messaging v21 exposes no client badge API either, so the
// honest state is "no icon badge" until either a badge-capable dependency or a
// server-side unread total lands — not a wrong number.

// No exported ensureChannels: there is intentionally no per-call channel setup
// in JS. RNFirebase does not create notification channels natively (a payload
// channelId the device has never seen falls back to FCM's auto-created
// "Miscellaneous" channel, default importance — still delivered, just not
// tuned), and react-native-callkeep creates its own high-importance call
// channel during setup(). A real Android channel set belongs with a designed
// notification-tuning feature, not an empty hook. See Part 4 of
// FLYER_MASTER_PROMPT.md, entry for ensureChannels.
