'use strict';

/**
 * Flyer — Cloud Functions (2nd gen, Node 20).
 *
 * Responsibilities that cannot live on the client:
 *   - Waking a callee's device for an incoming call (FCM data push).
 *   - Notifying message recipients while their app is backgrounded or killed.
 *   - Writing call history (both participants must get an entry, but neither
 *     client can write into the other's tree — see database.rules.json).
 *   - Reaping calls whose caller vanished.
 *
 * Everything here runs with the Admin SDK, which bypasses database rules. That
 * is deliberate: `callHistory` is client-read-only and `incoming/{uid}` is
 * client-write-only, so only this code can maintain them coherently.
 */

const { initializeApp } = require('firebase-admin/app');
const { getDatabase } = require('firebase-admin/database');
const { getMessaging } = require('firebase-admin/messaging');
const { setGlobalOptions } = require('firebase-functions/v2');
const { defineSecret } = require('firebase-functions/params');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onValueCreated, onValueUpdated } = require('firebase-functions/v2/database');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const logger = require('firebase-functions/logger');

initializeApp();

// 2nd-gen RTDB triggers must be deployed in a region that serves the database
// instance. Override via functions/.env (firebase-functions loads it at deploy
// analysis time) if the Flyer database does not live in us-central1.
setGlobalOptions({
  region: process.env.FLYER_FUNCTIONS_REGION || 'us-central1',
  maxInstances: 20,
});

/** How long a call push stays worth delivering. Matches Limits.callRingTimeoutMs. */
const CALL_PUSH_TTL_MS = 45 * 1000;

/**
 * Server-side backstop for abandoned calls. Deliberately longer than the 45s
 * client ring timeout so a healthy client always wins the race and writes its
 * own, more accurate `endedReason`.
 */
const STALE_CALL_MS = 60 * 1000;

/** Notification body cap for text messages. */
const PREVIEW_MAX = 120;

/**
 * Directory search limits.
 *
 * The floor matters more than the cap. A one-character prefix matches a large
 * slice of the handle space, so repeated short queries would rebuild the user
 * table the rules just stopped serving — a cap alone only makes that slower.
 * Three characters is also the minimum handle length, so no handle is unfindable
 * by its exact name.
 */
const SEARCH_MIN_PREFIX = 3;
const SEARCH_MAX_RESULTS = 20;

/**
 * Mistral API key for smart replies.
 *
 * A secret, not an env var, and specifically not an `EXPO_PUBLIC_*` value:
 * everything with that prefix is inlined into the JS bundle at build time and
 * is trivially recoverable from a shipped APK. Only `smartReply` below binds
 * this, so no other function's runtime can read it.
 *
 * Set before first deploy:
 *   firebase functions:secrets:set MISTRAL_API_KEY
 */
const MISTRAL_API_KEY = defineSecret('MISTRAL_API_KEY');

/** Chat turns accepted per smart-reply request. Matches the client's window. */
const SMART_REPLY_MAX_TURNS = 10;

/** Per-turn character cap, enforced server-side so a client cannot inflate cost. */
const SMART_REPLY_MAX_CHARS = 500;

/** Mistral's small model: fast, cheap, and more than capable of a 3-word reply. */
const MISTRAL_MODEL = 'mistral-small-latest';

/** Upstream deadline. The client gives up at 12s, so fail before it does. */
const MISTRAL_TIMEOUT_MS = 9000;

/** sendEachForMulticast accepts at most 500 tokens per call. */
const MULTICAST_CHUNK = 500;

/** RTDB rejects very large multi-path updates; chunk deletes to stay well under. */
const UPDATE_CHUNK = 500;

/**
 * FCM error codes that mean "this token is dead, stop storing it".
 * `invalid-argument` is included because FCM returns it for structurally
 * corrupt tokens, but see the guard in sendToUser() — it is also what you get
 * back when the *message* is malformed.
 */
const DEAD_TOKEN_CODES = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
  'messaging/invalid-argument',
]);

/* ------------------------------------------------------------------ *
 * FCM helpers
 * ------------------------------------------------------------------ */

/** Token strings are stored as the child keys of `fcmTokens/{uid}`. */
async function readTokens(uid) {
  const snap = await getDatabase().ref(`fcmTokens/${uid}`).once('value');
  const val = snap.val();
  return val ? Object.keys(val) : [];
}

async function pruneTokens(uid, tokens) {
  if (!tokens.length) return;
  const updates = {};
  for (const token of tokens) updates[token] = null;
  await getDatabase().ref(`fcmTokens/${uid}`).update(updates);
  logger.info('Pruned dead FCM tokens', { uid, count: tokens.length });
}

/**
 * Fan a message out to every device a user owns, pruning tokens FCM rejects.
 * Never throws for an empty token list — a user with notifications off is a
 * normal state, not an error.
 */
async function sendToUser(uid, tokens, message) {
  if (!tokens.length) return { sent: 0, failed: 0 };

  let sent = 0;
  let failed = 0;
  const dead = [];

  for (let i = 0; i < tokens.length; i += MULTICAST_CHUNK) {
    const chunk = tokens.slice(i, i + MULTICAST_CHUNK);
    let result;
    try {
      result = await getMessaging().sendEachForMulticast({ ...message, tokens: chunk });
    } catch (err) {
      // A throw here is transport/credential level, not per-token. Never prune.
      logger.error('FCM multicast failed', { uid, error: err.message });
      failed += chunk.length;
      continue;
    }

    sent += result.successCount;
    failed += result.failureCount;

    // If *every* token failed with invalid-argument the payload is almost
    // certainly at fault (a bad deploy), and pruning would wipe the user's
    // token list. Only prune when at least one token was accepted.
    const wholeChunkInvalid =
      result.failureCount === chunk.length &&
      result.responses.every((r) => r.error && r.error.code === 'messaging/invalid-argument');
    if (wholeChunkInvalid) {
      logger.error('FCM rejected every token with invalid-argument; treating as a bad payload', {
        uid,
        count: chunk.length,
      });
      continue;
    }

    result.responses.forEach((response, index) => {
      if (!response.success && response.error && DEAD_TOKEN_CODES.has(response.error.code)) {
        dead.push(chunk[index]);
      }
    });
  }

  await pruneTokens(uid, dead);
  return { sent, failed };
}

/**
 * Envelope for call signalling.
 *
 * Data-only on purpose. A `notification` block would be handed to the system
 * tray by the Android FCM SDK when the app is backgrounded or killed, and our
 * JS would never run — so CallKeep could not raise the native full-screen
 * incoming-call UI. Data-only + priority `high` is the only shape that wakes
 * the headless JS task through Doze.
 *
 * On iOS this reaches a suspended app as a background refresh. The genuinely
 * correct iOS transport is a PushKit VoIP push (the app already declares the
 * `voip` background mode), which requires a separate VoIP token and an
 * `apns-push-type: voip` header; wire that up before shipping to the App Store,
 * because iOS 13+ hard-requires reporting a CallKit call from a VoIP push.
 */
function callPushEnvelope(data) {
  return {
    data,
    android: {
      priority: 'high',
      ttl: CALL_PUSH_TTL_MS,
    },
    apns: {
      headers: {
        'apns-priority': '10',
        'apns-push-type': 'background',
        'apns-expiration': String(Math.floor(Date.now() / 1000) + CALL_PUSH_TTL_MS / 1000),
      },
      payload: {
        aps: { 'content-available': 1 },
      },
    },
  };
}

/* ------------------------------------------------------------------ *
 * 1. sendCallInvite
 * ------------------------------------------------------------------ */

exports.sendCallInvite = onCall(async (request) => {
  const uid = request.auth && request.auth.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'You must be signed in to place a call.');

  const payload = request.data || {};
  const { calleeId, callId } = payload;
  if (typeof calleeId !== 'string' || !calleeId || typeof callId !== 'string' || !callId) {
    throw new HttpsError('invalid-argument', 'calleeId and callId are required.');
  }

  const db = getDatabase();
  const call = (await db.ref(`calls/${callId}`).once('value')).val();
  if (!call) throw new HttpsError('not-found', 'That call no longer exists.');

  // The call node is the source of truth; the client cannot ring someone by
  // naming them in the request body.
  if (call.callerId !== uid) {
    throw new HttpsError('permission-denied', 'Only the caller may ring this call.');
  }
  if (call.calleeId !== calleeId) {
    throw new HttpsError('invalid-argument', 'calleeId does not match the call record.');
  }
  if (call.state === 'ended' || call.state === 'rejected') {
    throw new HttpsError('failed-precondition', 'That call has already finished.');
  }

  const [blockSnap, callerSnap, tokens] = await Promise.all([
    db.ref(`blocks/${calleeId}/${uid}`).once('value'),
    db.ref(`users/${uid}`).once('value'),
    readTokens(calleeId),
  ]);

  if (blockSnap.val() === true) {
    // Generic wording: the caller must not be able to probe for a block.
    throw new HttpsError('permission-denied', 'This call could not be placed.');
  }

  const caller = callerSnap.val() || {};
  const privacy = caller.privacy || {};
  const callType = call.type === 'video' ? 'video' : 'voice';

  // FCM data values must all be strings.
  const { sent, failed } = await sendToUser(
    calleeId,
    tokens,
    callPushEnvelope({
      kind: 'call',
      callId,
      callerId: uid,
      callerName: String(caller.name || 'Flyer user'),
      callerPhoto: privacy.showPhoto === false ? '' : String(caller.photoURL || ''),
      callType,
      createdAt: String(call.createdAt || Date.now()),
    })
  );

  logger.info('Call invite dispatched', { callId, calleeId, sent, failed });
  return { sent, failed };
});

/* ------------------------------------------------------------------ *
 * 2. cancelCallInvite
 * ------------------------------------------------------------------ */

exports.cancelCallInvite = onCall(async (request) => {
  const uid = request.auth && request.auth.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'You must be signed in.');

  const payload = request.data || {};
  const { callId } = payload;
  if (typeof callId !== 'string' || !callId) {
    throw new HttpsError('invalid-argument', 'callId is required.');
  }

  const db = getDatabase();
  const call = (await db.ref(`calls/${callId}`).once('value')).val();
  if (!call) throw new HttpsError('not-found', 'That call no longer exists.');
  if (call.callerId !== uid && call.calleeId !== uid) {
    throw new HttpsError('permission-denied', 'You are not part of this call.');
  }

  // Tell the *other* side to tear down; the device that called this function
  // already knows. Clearing the ring pointer stops a device that reconnects
  // after the cancel from resurrecting the call UI off RTDB state.
  const targetId = call.callerId === uid ? call.calleeId : call.callerId;
  await db.ref(`incoming/${call.calleeId}/${callId}`).remove();

  const tokens = await readTokens(targetId);
  const { sent, failed } = await sendToUser(
    targetId,
    tokens,
    callPushEnvelope({ kind: 'call_cancel', callId })
  );

  logger.info('Call cancel dispatched', { callId, targetId, sent, failed });
  return { sent, failed };
});

/* ------------------------------------------------------------------ *
 * 3. onMessageWritten
 * ------------------------------------------------------------------ */

/** Notification body per message type. Text is capped so the tray stays legible. */
function previewFor(message) {
  switch (message.type) {
    case 'image':
      return '📷 Photo';
    case 'video':
      return '🎥 Video';
    case 'audio':
      return '🎤 Voice note';
    default: {
      const text = typeof message.text === 'string' ? message.text : '';
      return text.length > PREVIEW_MAX ? `${text.slice(0, PREVIEW_MAX - 1)}…` : text;
    }
  }
}

exports.onMessageWritten = onValueCreated('/messages/{chatId}/{messageId}', async (event) => {
  const { chatId, messageId } = event.params;
  const message = event.data.val();

  if (!message || typeof message.senderId !== 'string') return;
  if (message.deleted === true) return;
  // Membership changes, renames, photo swaps and admin grants all land here as
  // ordinary message rows. Pushing them meant a 20-person group produced 19
  // notifications reading "Members added" every time anyone edited membership.
  // They still render in the thread; they just do not wake anybody's phone.
  if (message.type === 'system') return;

  const db = getDatabase();
  const [chatSnap, senderSnap] = await Promise.all([
    db.ref(`chats/${chatId}`).once('value'),
    db.ref(`users/${message.senderId}`).once('value'),
  ]);

  const chat = chatSnap.val();
  if (!chat || !chat.participants) {
    logger.warn('Message written into a chat with no participants', { chatId, messageId });
    return;
  }

  const senderName = (senderSnap.val() || {}).name || 'Flyer user';
  const preview = previewFor(message);
  const now = Date.now();
  const mutedBy = chat.mutedBy || {};

  // In a group the sender's name alone does not say which group it came from,
  // and someone in a dozen groups cannot tell them apart in the tray.
  const title = chat.isGroup && chat.name ? `${senderName} @ ${chat.name}` : senderName;

  const recipients = Object.keys(chat.participants).filter(
    (uid) => chat.participants[uid] && uid !== message.senderId
  );

  await Promise.all(
    recipients.map(async (uid) => {
      // A negative value is the "mute forever" sentinel the client writes (see
      // isChatMuted in ChatEngine.ts). This used to be a bare `> now`, and since
      // -1 is not greater than now the push went out anyway: muting a chat
      // forever silenced the badge and the in-app banner while still delivering
      // every single notification.
      const until = Number(mutedBy[uid] || 0);
      if (until < 0 || until > now) return;

      const [blockSnap, tokens] = await Promise.all([
        db.ref(`blocks/${uid}/${message.senderId}`).once('value'),
        readTokens(uid),
      ]);
      if (blockSnap.val() === true) return;
      if (!tokens.length) return;

      // notification + data: the system tray renders this while the app is
      // backgrounded or killed, and the data block still reaches JS so tapping
      // the notification can deep-link straight to the chat.
      const { sent, failed } = await sendToUser(uid, tokens, {
        notification: { title, body: preview },
        data: {
          kind: 'message',
          chatId,
          messageId,
          senderId: message.senderId,
        },
        android: {
          priority: 'high',
          notification: {
            channelId: 'messages',
            // One live notification per chat: a newer message replaces the older.
            tag: chatId,
          },
        },
        apns: {
          headers: {
            'apns-priority': '10',
            'apns-push-type': 'alert',
          },
          payload: {
            aps: {
              // Groups every notification from this chat into one iOS thread.
              'thread-id': chatId,
              sound: 'default',
            },
          },
        },
      });

      if (failed) logger.warn('Message push partially failed', { chatId, uid, sent, failed });
    })
  );
});

/* ------------------------------------------------------------------ *
 * 3b. onReactionCreated
 * ------------------------------------------------------------------ */

/**
 * Tells the author when somebody reacts to their message.
 *
 * Creates only. Switching an existing reaction to a different emoji is an update
 * and clearing one is a delete; neither deserves a second buzz for something the
 * author has already been told about once.
 *
 * Only the author is notified, never the whole chat. A reaction is addressed to
 * one person in a way a message is not, and fanning it out across a group would
 * rebuild exactly the notification storm BUG-21 removed.
 */
exports.onReactionCreated = onValueCreated(
  '/messages/{chatId}/{messageId}/reactions/{reactorId}',
  async (event) => {
    const { chatId, messageId, reactorId } = event.params;
    const emoji = event.data.val();
    if (typeof emoji !== 'string' || !emoji) return;

    const db = getDatabase();
    const message = (await db.ref(`messages/${chatId}/${messageId}`).once('value')).val();
    if (!message || typeof message.senderId !== 'string') return;

    const authorId = message.senderId;
    if (authorId === reactorId) return;
    // Nothing left to point at, so nothing worth interrupting anyone for.
    if (message.deleted === true) return;

    const [chatSnap, reactorSnap, blockSnap, tokens] = await Promise.all([
      db.ref(`chats/${chatId}`).once('value'),
      db.ref(`users/${reactorId}`).once('value'),
      db.ref(`blocks/${authorId}/${reactorId}`).once('value'),
      readTokens(authorId),
    ]);

    if (blockSnap.val() === true) return;
    if (!tokens.length) return;

    const chat = chatSnap.val();
    // Removed from the group since, so the message is no longer theirs to hear
    // about.
    if (!chat || !chat.participants || !chat.participants[authorId]) return;

    // Same sentinel as onMessageWritten: a muted chat is quiet for reactions
    // too. Only a mention is meant to break through a mute, and mentions do not
    // exist yet (F-07).
    const until = Number((chat.mutedBy || {})[authorId] || 0);
    if (until < 0 || until > Date.now()) return;

    const reactorName = (reactorSnap.val() || {}).name || 'Flyer user';
    const preview = previewFor(message);

    const { sent, failed } = await sendToUser(authorId, tokens, {
      notification: {
        title: chat.isGroup && chat.name ? `${reactorName} @ ${chat.name}` : reactorName,
        // Quoting the message because an emoji on its own does not say which of
        // your messages earned it. An empty preview means a media row whose
        // previewFor returned a label, or a text message with no text.
        body: preview ? `${emoji} to: ${preview}` : `Reacted ${emoji} to your message`,
      },
      data: {
        kind: 'reaction',
        chatId,
        messageId,
        senderId: reactorId,
      },
      android: {
        // Normal, not high: a reaction is never worth waking a dozing device for.
        priority: 'normal',
        notification: {
          channelId: 'messages',
          // Deliberately a different tag from the chat's message notification.
          // Sharing one would let a reaction silently replace an unread message
          // in the tray.
          tag: `${chatId}:reaction`,
        },
      },
      apns: {
        headers: { 'apns-priority': '5', 'apns-push-type': 'alert' },
        payload: { aps: { 'thread-id': chatId, sound: 'default' } },
      },
    });

    if (failed) {
      logger.warn('Reaction push partially failed', { chatId, authorId, sent, failed });
    }
  }
);

/* ------------------------------------------------------------------ *
 * 4. onCallStateChanged
 * ------------------------------------------------------------------ */

exports.onCallStateChanged = onValueUpdated('/calls/{callId}/state', async (event) => {
  const before = event.data.before.val();
  const after = event.data.after.val();
  if (before === after) return;
  if (after !== 'ended' && after !== 'rejected') return;

  const { callId } = event.params;
  const db = getDatabase();
  const call = (await db.ref(`calls/${callId}`).once('value')).val();
  if (!call || !call.callerId || !call.calleeId) {
    logger.warn('Call ended without a usable record', { callId });
    return;
  }

  const endedAt = Number(call.endedAt) || Date.now();
  const answeredAt = Number(call.answeredAt) || 0;
  const startedAt = Number(call.createdAt) || endedAt;

  // A call that was never answered has no duration, and shows as "missed" for
  // the callee / "no answer" for the caller.
  const durationMs = answeredAt ? Math.max(0, endedAt - answeredAt) : 0;
  const missed = answeredAt === 0;

  const base = {
    callId,
    type: call.type === 'video' ? 'video' : 'voice',
    state: after,
    startedAt,
    durationMs,
    missed,
  };

  // Single atomic fan-out: history for both sides plus dismissal of the ring
  // pointer, so a device that reconnects mid-teardown sees a consistent world.
  await db.ref().update({
    [`callHistory/${call.callerId}/${callId}`]: {
      ...base,
      peerId: call.calleeId,
      direction: 'outgoing',
    },
    [`callHistory/${call.calleeId}/${callId}`]: {
      ...base,
      peerId: call.callerId,
      direction: 'incoming',
    },
    [`incoming/${call.calleeId}/${callId}`]: null,
  });

  logger.info('Call history written', { callId, state: after, durationMs, missed });
});

/* ------------------------------------------------------------------ *
 * 5. reapStaleCalls
 * ------------------------------------------------------------------ */

async function applyInChunks(db, updates) {
  const keys = Object.keys(updates);
  for (let i = 0; i < keys.length; i += UPDATE_CHUNK) {
    const slice = {};
    for (const key of keys.slice(i, i + UPDATE_CHUNK)) slice[key] = updates[key];
    await db.ref().update(slice);
  }
  return keys.length;
}

/**
 * Calls whose caller died mid-ring. Queried by `state` rather than by
 * `createdAt` so the scan is bounded by the number of *live* calls instead of
 * every call ever placed (see the `.indexOn` on `calls` in database.rules.json).
 */
async function reapCalls(db, now) {
  const cutoff = now - STALE_CALL_MS;
  const updates = {};

  for (const state of ['calling', 'ringing']) {
    const snap = await db.ref('calls').orderByChild('state').equalTo(state).once('value');
    snap.forEach((child) => {
      const call = child.val();
      // NaN createdAt (a malformed node) fails this comparison and is reaped.
      if (call && Number(call.createdAt) > cutoff) return;
      updates[`calls/${child.key}/state`] = 'ended';
      updates[`calls/${child.key}/endedReason`] = 'missed';
      updates[`calls/${child.key}/endedAt`] = now;
    });
  }

  // Writing `state` here re-enters onCallStateChanged, which is what actually
  // writes the call history and clears `incoming/{calleeId}`.
  return applyInChunks(db, updates);
}

exports.reapStaleCalls = onSchedule('every 5 minutes', async () => {
  const db = getDatabase();
  const now = Date.now();

  const calls = await reapCalls(db, now);
  logger.info('Reaper finished', { staleCallUpdates: calls });
});

/* ------------------------------------------------------------------ *
 * Smart replies (Mistral)
 * ------------------------------------------------------------------ */

/**
 * Validates and normalises the transcript the client sent.
 *
 * Everything here is attacker-controlled: a modified client can call this
 * endpoint directly with whatever body it likes. Caps on turn count and per-turn
 * length keep a hostile caller from turning a signed-in account into a free,
 * unmetered Mistral proxy on the project's quota.
 */
function normaliseTranscript(raw) {
  if (!Array.isArray(raw)) {
    throw new HttpsError('invalid-argument', 'messages must be an array.');
  }

  const turns = [];
  for (const item of raw.slice(-SMART_REPLY_MAX_TURNS)) {
    if (!item || typeof item !== 'object') continue;
    const role = item.role === 'me' ? 'me' : 'them';
    const content = typeof item.content === 'string' ? item.content.trim() : '';
    if (!content) continue;
    turns.push({ role, content: content.slice(0, SMART_REPLY_MAX_CHARS) });
  }

  return turns;
}

const SMART_REPLY_SYSTEM = [
  'You suggest short replies for a person using a messaging app.',
  'The conversation is given as turns labelled "them" (the other person) and "me" (the user you are helping).',
  'Reply with exactly three suggestions the user could send next, as a JSON array of three strings and nothing else.',
  'Each suggestion must be under 12 words, sound like a real person texting, and be genuinely different from the other two — vary between agreeing, asking something back, and declining or deferring where that fits.',
  'Match the language, tone and formality of the conversation. If the conversation is not in English, reply in that language.',
  'Never invent facts, commitments, times or places that are not already in the conversation.',
  'Do not add quotes around the strings beyond JSON syntax, and do not number them.',
].join(' ');

/**
 * Pulls the suggestion array out of the model's response.
 *
 * Instruction-tuned models usually honour "JSON array only", but not always —
 * they wrap it in a ```json fence or add a sentence of preamble. Falling back to
 * line-splitting means an occasional chatty response still produces suggestions
 * rather than an empty bar.
 */
function parseSuggestions(text) {
  if (typeof text !== 'string' || !text.trim()) return [];

  const fenced = text.replace(/```(?:json)?/gi, '').trim();

  const start = fenced.indexOf('[');
  const end = fenced.lastIndexOf(']');
  if (start !== -1 && end > start) {
    try {
      const parsed = JSON.parse(fenced.slice(start, end + 1));
      if (Array.isArray(parsed)) {
        return parsed.filter((s) => typeof s === 'string');
      }
    } catch {
      // Fall through to the line-based path below.
    }
  }

  return fenced
    .split('\n')
    .map((line) => line.replace(/^\s*(?:[-*\d]+[.)]?)\s*/, '').replace(/^["'`]|["'`,]+$/g, '').trim())
    .filter(Boolean);
}

async function callMistral(apiKey, turns) {
  const messages = [
    { role: 'system', content: SMART_REPLY_SYSTEM },
    {
      role: 'user',
      content: turns.map((t) => `${t.role}: ${t.content}`).join('\n'),
    },
  ];

  // Node 20 has fetch and AbortSignal.timeout built in — no extra dependency,
  // which matters because functions cold-start on every scale-from-zero.
  const response = await fetch('https://api.mistral.ai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: MISTRAL_MODEL,
      messages,
      // Low but non-zero: identical suggestions on every message read as canned.
      temperature: 0.4,
      max_tokens: 160,
    }),
    signal: AbortSignal.timeout(MISTRAL_TIMEOUT_MS),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    const err = new Error(`Mistral responded ${response.status}`);
    err.status = response.status;
    err.detail = detail.slice(0, 400);
    throw err;
  }

  const body = await response.json();
  const content =
    body && body.choices && body.choices[0] && body.choices[0].message
      ? body.choices[0].message.content
      : '';

  return parseSuggestions(content);
}

/* ------------------------------------------------------------------ *
 * 7. searchUsers
 * ------------------------------------------------------------------ */

/**
 * The only fields a stranger learns about someone they searched for.
 *
 * Everything omitted here is omitted on purpose. `email` is what the caller
 * already had to know to match by email, so echoing it back to a handle search
 * would turn the directory into an address harvester. `lastSeen`/`online` are
 * privacy-gated presence, `about` is profile text, and neither is needed to
 * decide whether to send a contact request.
 */
function searchProjection(uid, profile) {
  const privacy = profile.privacy || {};
  return {
    uid,
    name: String(profile.name || 'Flyer user'),
    username: profile.username ? String(profile.username) : null,
    photoURL: privacy.showPhoto === false ? null : String(profile.photoURL || '') || null,
  };
}

/**
 * Directory search by handle prefix or exact email.
 *
 * This exists because the `users` and `usernames` rules no longer grant read on
 * the parent node, which is what made client-side search possible and also made
 * whole-table download possible — the same permission does both. Moving it here
 * keeps discovery working while the enumeration it used to allow stays shut.
 *
 * Email is matched exactly, never by prefix: a prefix match over addresses lets
 * a caller confirm addresses they merely guessed, whereas an exact match only
 * confirms one they already had. That asymmetry is the whole reason the two
 * inputs are treated differently.
 */
exports.searchUsers = onCall(async (request) => {
  const uid = request.auth && request.auth.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'You must be signed in to search.');

  const raw = (request.data || {}).query;
  if (typeof raw !== 'string') {
    throw new HttpsError('invalid-argument', 'query is required.');
  }

  const q = raw.trim().toLowerCase().replace(/^@/, '');
  if (q.length < SEARCH_MIN_PREFIX) return { results: [] };

  const db = getDatabase();

  // An address is unambiguous, so an email query is a lookup rather than a
  // search: at most one row, and no handle results mixed in to pad it out.
  if (q.includes('@')) {
    const snap = await db
      .ref('users')
      .orderByChild('email')
      .equalTo(q)
      .limitToFirst(1)
      .once('value');

    const results = [];
    snap.forEach((child) => {
      if (child.key !== uid) results.push(searchProjection(child.key, child.val() || {}));
    });
    return { results: await withoutBlockers(db, uid, results) };
  }

  if (!/^[a-z0-9_.]+$/.test(q)) return { results: [] };

  // \uf8ff sorts after any character a handle may contain, making this a prefix
  // range rather than a scan of the whole index.
  const claims = await db
    .ref('usernames')
    .orderByKey()
    .startAt(q)
    .endAt(`${q}\uf8ff`)
    .limitToFirst(SEARCH_MAX_RESULTS)
    .once('value');

  const uids = [];
  claims.forEach((child) => {
    const owner = child.val();
    if (typeof owner === 'string' && owner !== uid) uids.push(owner);
  });
  if (uids.length === 0) return { results: [] };

  const rows = await Promise.all(uids.map((u) => db.ref(`users/${u}`).once('value')));
  const results = rows
    .map((snap, i) => (snap.exists() ? searchProjection(uids[i], snap.val() || {}) : null))
    .filter(Boolean);

  return { results: await withoutBlockers(db, uid, results) };
});

/**
 * Drop anyone who has blocked the caller.
 *
 * A block is meant to be silent, so the blocked party must not be able to tell a
 * block from a deleted account — returning the row and letting the send fail
 * later would announce it. Reading `blocks/{peer}/{caller}` is only possible
 * here: that subtree is owner-only to the client, and the Admin SDK bypasses
 * rules. The caller's own blocks are left in; hiding people you blocked yourself
 * would make them unsearchable and un-unblockable.
 */
async function withoutBlockers(db, uid, results) {
  const flags = await Promise.all(
    results.map((r) => db.ref(`blocks/${r.uid}/${uid}`).once('value'))
  );
  return results.filter((_, i) => flags[i].val() !== true);
}

/**
 * Generates up to three reply suggestions for a chat.
 *
 * The client holds an off-by-default toggle, but the checks that matter are
 * here: signed in, and actually a participant of the chat being summarised.
 * Without the participant check any authenticated user could pass an arbitrary
 * chatId — and while the transcript itself comes from the caller, honouring the
 * request would still let them burn the project's Mistral quota against chats
 * they have nothing to do with.
 */
exports.smartReply = onCall({ secrets: [MISTRAL_API_KEY] }, async (request) => {
  const uid = request.auth && request.auth.uid;
  if (!uid) {
    throw new HttpsError('unauthenticated', 'You must be signed in.');
  }

  const payload = request.data || {};
  const { chatId } = payload;
  if (typeof chatId !== 'string' || !chatId) {
    throw new HttpsError('invalid-argument', 'chatId is required.');
  }

  const turns = normaliseTranscript(payload.messages);
  if (turns.length === 0) {
    return { suggestions: [] };
  }

  const db = getDatabase();
  const member = await db.ref(`chats/${chatId}/participants/${uid}`).once('value');
  if (member.val() !== true) {
    throw new HttpsError('permission-denied', 'You are not part of this conversation.');
  }

  const apiKey = MISTRAL_API_KEY.value();
  if (!apiKey) {
    // Deploying without the secret set is a configuration mistake, not a user
    // error. Log it loudly; the client degrades to no suggestions.
    logger.error('MISTRAL_API_KEY is not set — smart replies are disabled.');
    return { suggestions: [] };
  }

  try {
    const suggestions = await callMistral(apiKey, turns);
    logger.debug('Smart replies generated', { chatId, count: suggestions.length });
    return { suggestions: suggestions.slice(0, 3) };
  } catch (e) {
    // Suggestions are optional by design. Rate limits, upstream outages and
    // timeouts all degrade to an empty bar rather than an error in the chat.
    logger.warn('Smart reply upstream failed', {
      chatId,
      status: e && e.status,
      message: e && e.message,
      detail: e && e.detail,
    });
    return { suggestions: [] };
  }
});
