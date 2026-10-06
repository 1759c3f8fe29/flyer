import messaging, {
  type FirebaseMessagingTypes,
} from '@react-native-firebase/messaging';
import { AppRegistry, Platform } from 'react-native';
import * as CallKeep from './CallKeepService';
import { serverTimestamp, write } from './FirebaseService';

/**
 * BackgroundTaskManager
 *
 * This module is imported for its side effects from index.js, before the router
 * mounts. That ordering is load-bearing: `setBackgroundMessageHandler` must be
 * registered synchronously during the first JS tick, otherwise Android's headless
 * task finishes before the handler exists and the data message that was supposed
 * to ring an incoming call is dropped.
 *
 * Nothing here may touch React state, navigation, or the zustand store — on a
 * cold start none of that exists yet. The only jobs are:
 *   1. Ring the OS call UI via CallKeep.
 *   2. Dismiss it on cancel.
 * The rest of the call flow resumes in CallManager once React mounts and the
 * `incoming/{uid}` listener attaches.
 */

interface CallPush {
  kind: 'call';
  callId: string;
  callerId: string;
  callerName?: string;
  callerPhoto?: string;
  callType?: string;
}

interface CallCancelPush {
  kind: 'call_cancel';
  callId: string;
}

interface MessagePush {
  kind: 'message';
  chatId: string;
  messageId: string;
  /** Recipient uid — the push is fanned out per user, so this names the owner. */
  to?: string;
}

type KnownPush = CallPush | CallCancelPush | MessagePush;

function parse(message: FirebaseMessagingTypes.RemoteMessage): KnownPush | null {
  const data = message.data;
  if (!data || typeof data.kind !== 'string') return null;
  return data as unknown as KnownPush;
}

async function handleCallPush(push: CallPush) {
  // CallKit/ConnectionService require a lowercase RFC-4122 UUID; a mismatch in
  // case means the later `answerCall` event will not match our call id.
  const callId = String(push.callId).toLowerCase();

  await CallKeep.displayIncoming({
    callId,
    callerName: push.callerName || 'Flyer call',
    callerHandle: push.callerId,
    hasVideo: push.callType === 'video',
  });
}

/**
 * Fires when the app is in the background or fully terminated.
 * Must return a promise; Android keeps the headless task alive until it settles.
 *
 * The registration itself is wrapped, not just the handler body. This module is
 * imported from index.js on the very first JS tick — before `expo-router/entry`,
 * before React, before any error boundary exists. `messaging()` throws if the
 * native Firebase default app has not finished initialising at that instant, and
 * a throw here escapes index.js and kills the process: splash screen, then
 * straight back to the launcher, with no red box and nothing in the JS logs.
 *
 * Losing background call pushes is bad. Losing the entire app is worse, so a
 * failure here degrades instead of aborting: the foreground `incoming/{uid}`
 * listener in CallManager still rings calls once React mounts.
 */
function registerBackgroundHandler() {
  messaging().setBackgroundMessageHandler(async (message) => {
    const push = parse(message);
    if (!push) return;

    try {
      switch (push.kind) {
        case 'call':
          await handleCallPush(push);
          break;

        case 'call_cancel':
          // The caller gave up. Report 'missed' so it lands in the OS call log
          // correctly rather than looking like the user declined.
          CallKeep.endCall(String(push.callId).toLowerCase(), 'missed');
          break;

        case 'message': {
          // N-02: the push itself is the delivery signal. WhatsApp's second
          // tick means "their device has it", and it appears while the app is
          // closed — before this, nothing distinguished "phone off" from "has
          // not looked yet". The handler is async and Android holds the
          // headless task until the promise settles, so the write lands before
          // we return. (iOS only reaches here for a live-enough app, so iOS
          // delivery marks stay best-effort until a service extension lands.)
          const { chatId, messageId, to } = push;
          if (chatId && messageId && to) {
            await write(
              `messages/${chatId}/${messageId}/deliveredTo/${to}`,
              serverTimestamp()
            ).catch(() => {});
          }
          break;
        }
      }
    } catch (e) {
      console.warn('[Flyer/bg] background message handler failed', e);
    }
  });
}

try {
  registerBackgroundHandler();
} catch (e) {
  console.warn('[Flyer/bg] could not register the background message handler', e);
}

/**
 * Android-only headless task. When the user answers from the lock screen on a
 * killed app, the OS starts the ConnectionService, not our activity — this task
 * is the JS entry point for that. CallKeep replays the answer via
 * `didLoadWithEvents` once React mounts, so we only need to keep the process
 * alive and ensure CallKeep is initialised.
 *
 * Wrapped for the same reason as the handler above: this file is imported from
 * index.js on the very first JS tick, before React and before any error
 * boundary. `registerHeadlessTask` throws if the task name is already taken
 * (a fast kill-and-relaunch can re-evaluate this module while the previous
 * registration is still live), and an uncaught throw here kills the process
 * with no red box — splash, then straight back to the launcher. Losing
 * lock-screen answer replay is a bug; failing to start at all is fatal.
 */
if (Platform.OS === 'android') {
  try {
    AppRegistry.registerHeadlessTask(
      'RNCallKeepBackgroundMessage',
      () => async (data: { name: string; callUUID?: string; handle?: string }) => {
        try {
          await CallKeep.setup();
          if (data?.name === 'RNCallKeepPerformAnswerCallAction') {
            CallKeep.toForeground();
          }
        } catch (e) {
          console.warn('[Flyer/bg] callkeep headless task failed', e);
        }
      }
    );
  } catch (e) {
    console.warn('[Flyer/bg] could not register the callkeep headless task', e);
  }
}

export {};
