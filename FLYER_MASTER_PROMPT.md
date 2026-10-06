# Flyer — Master Implementation Prompt

Paste this into a fresh agent session at the repo root. It is written to be
executed, not just read. **Every bug below was confirmed by reading the actual
source or the rules file — none are speculative.** File:line references are given
so you can verify each one yourself before you touch it.

Contents:

- Part 0 — Rules of engagement
- Part 0.5 — Session 3 re-audit (2026-08-11): what changed since this was written
- Part 0.6 — Session 4 audit (2026-08-21): the locked/killed-device path
- Part 1 — Ground truth: what already exists (do not rebuild)
- Part 2 — Confirmed bugs (41), in fix order
- Part 3 — WhatsApp feature parity (30 features), in ship order
- Part 4 — What to remove or replace
- Part 5 — Production hardening (verified absent)
- Part 6 — Performance and scale
- Part 7 — Beyond parity: reasons to switch to Flyer
- Part 8 — Notification and call reliability ("WhatsApp level")
- Part 9 — Execution order and reporting contract

---

## Part 0.5 — Session 3 re-audit (2026-08-11)

This document was first written on 2026-08-07. The codebase has moved since then.
Re-reading every service, the rules file, `functions/index.js`, and all the
screens shows that **many Part 2 bugs are already fixed**. This section records
the current truth so nobody wastes a session re-fixing them. Verify by reading,
but these were all confirmed against the current source.

### Already fixed — do NOT redo

- **BUG-03 (blocking)** — `blockPairs/{chatId}/{uid}` now exists
  (`database.rules.json:336`), the message create rule enforces it
  (`database.rules.json:210`), and `blockUser`/`unblockUser`
  (`ChatEngine.ts:962`) write both halves in one fan-out. `isBlockedByPeer` is
  gone, replaced by `listenToBlockPair`.
- **BUG-04 (user-table dump)** — parent `.read` removed from `users` and
  `usernames`; per-row read only. `fetchAllUsers` deleted; discovery now goes
  through the `searchUsers` callable (`functions/index.js:773`) with a
  3-char minimum and 20-result cap. `DirectoryService.ts` is the only client
  entry point.
- **BUG-07 (outbox leaks across accounts)** — storage key is per-uid
  (`OfflineQueue.ts:29`), `startOutbox(uid)` swaps the in-memory queue, and
  `stopOutbox()` clears it. A legacy-shared-key migration adopts only items the
  current session actually sent.
- **BUG-09 (outbox head-of-line blocking)** — `flush()` now stalls only the
  failing chat (`stalled` set, `OfflineQueue.ts:160`) instead of `break`-ing the
  whole queue.
- **BUG-20 (mute forever)**, **BUG-21 (system-message pushes)**, **BUG-22
  (group push title)**, **BUG-23 (reaction pushes)** — all four fixed in
  `functions/index.js`: the mute sentinel is `until < 0 || until > now`
  (`:378`), system rows early-return (`:344`), group titles are
  `senderName @ chat.name` (`:365`), and `onReactionCreated` (`:442`) notifies
  the author only.
- **BUG-24 (typing lingers)** — `TYPING_STALE_MS = Limits.typingIdleMs + 1000`
  (`StateManager.ts:314`), derived from the same constant.
- **BUG-25 / BUG-26 (message payload validation, `type` pinning)** — the rules
  now validate `text` length, `type` against the enum, `timestamp === now`, and
  every mutable leaf is sender-guarded (`database.rules.json:203-291`).
- **F-30 (draft persistence)** — `DraftService.ts` exists and is wired into
  `Composer.tsx` (load/save/clear + foreground flush). It was never missing; the
  original audit did not find the file.
- **S-04 (thumbnail variants)** — `transformed()`, `thumbUrl()`, and
  `videoPoster()` exist in `MediaManager.ts`; profile photo and media viewers
  already use transformation URLs.

### Still open — confirmed against current source

- **BUG-05** — Cloudinary uploads are still unsigned (`MediaManager.ts:12`).
- **BUG-06** — ICE is still STUN-only (`env.ts:62`); no TURN.
- **BUG-10** — no time window on edit/delete. The rules (`:223-234`) and the
  chat screen both still allow editing/deleting a message from last year.
- **BUG-11** — `listenToMessages` still `onValue`s a `limitToLast(40)` query
  (`ChatEngine.ts:207`); every new message re-downloads the whole window.
- **BUG-12** — `clearedAt`/`hiddenFor` are still client-side filters only.
- **BUG-15** — `deleteAccount` still leaves ghost rows in others' contacts and
  group participant lists.
- **BUG-16** — no rate limiting anywhere.
- **BUG-18** — privacy settings are still booleans (everyone/nobody), not
  WhatsApp's granular controls.
- **BUG-27** — reaction count still unbounded.
- **BUG-28** — `chats/$chatId/lastMessage` is still writable by any participant
  (`database.rules.json:141`).
- **H-01…H-06, S-01…S-03, S-05…S-08** — unchanged; all still open.

### New, confirmed in this session (session 3)

**BUG-30 · P1 · deleting a chat resurrects it when offline messages flush.**
`deleteChatForMe` (`ChatEngine.ts:1018`) clears `clearedAt`, unread, and the
`userChats` index, but never calls `clearQueueForChat` — which exists
(`OfflineQueue.ts:207`) and is called **nowhere**. If the chat has queued
offline sends, `flush()` replays them after reconnect, `commitMessage` re-writes
`userChats/{myUid}/{chatId}/lastTimestamp`, and the chat the user deleted
reappears in their list with the very messages they deleted. **Fix:** call
`clearQueueForChat(chatId)` inside `deleteChatForMe`, and do the same in
`leaveGroup` so leaving a group does not leave stale queued attempts.

**BUG-31 · P2 · failed calls record as "missed" in history.**
`onCallStateChanged` computes `missed = answeredAt === 0` from the call record.
A call whose *setup* failed (`startCall` catch → `hangUp('failed')`) or whose
ICE never connected still has `answeredAt` null, so the caller's history shows a
missed call for something that was never answered. The richer `endedReason` is
written on the call node but not carried into history. **Fix:** copy
`endedReason` into the history entry and derive the UI label from it.

### WhatsApp parity — what actually works, verified by reading

Legend: ✅ works, ⚠️ works but limited, ❌ missing.

| WhatsApp feature | Flyer | Where / gap |
|---|---|---|
| 1:1 chat | ✅ | Full: text, media, voice, receipts, typing |
| Group chat | ✅ | 256 max, admins, add/remove/leave, rename, photo, description, "You, A, B" subtitle |
| Group admin grant/revoke | ✅ | `group/[chatId].tsx` |
| Text / image / video / audio | ✅ | — |
| Reply | ✅ | Plus swipe-to-reply ❌ (long-press only) |
| Forward | ✅ | Multi-select forward too |
| Edit | ⚠️ | Text-only, no 15-min window (BUG-10), no caption edit |
| Delete for me / everyone | ✅ | Time-window limit missing (BUG-10) |
| Reactions | ✅ | Author gets a push |
| Multi-select actions | ✅ | Star, copy, forward, delete |
| Star messages | ✅ | Tap jumps to message ✅ |
| Pin / archive / mute chat | ✅ | Mute options 8h/1w/always ✅ |
| Mark as unread | ❌ | Not present anywhere |
| In-chat search | ❌ | Global chat-list search only |
| Drafts | ✅ | `DraftService`, per-chat, survives restart |
| Documents / files | ❌ | Explicitly excluded in `AttachSheet.tsx` |
| Location | ❌ | — |
| Contact cards | ❌ | — |
| Polls | ❌ | — |
| Stickers / GIFs | ❌ | — |
| View-once media | ❌ | — |
| Disappearing messages | ❌ | — |
| Scheduled messages | ❌ | — |
| Group invite links | ❌ | — |
| Broadcast lists | ❌ | — |
| Communities | ❌ | — |
| Pinned messages in a chat | ❌ | Chat-pin exists; message-pin doesn't |
| 1:1 voice/video calls | ⚠️ | WebRTC + CallKeep + PiP. Android rings from a cold start; **iOS cannot ring a terminated app** — no PushKit VoIP (BUG-39). Blocking is not enforced on calls (BUG-37) |
| Call history | ⚠️ | Incoming/outgoing/missed, delete, clear — but written only by Cloud Functions, so empty without Blaze (BUG-41) |
| Group calls | ❌ | 1:1 only |
| Status / stories | ❌ | — |
| Online / last-seen / typing | ✅ | Privacy toggles for last-seen ✅ |
| Read receipts | ✅ | Blue ticks + mutual toggle |
| Blocking | ⚠️ | Enforced for messages (BUG-03 fixed); **not for calls** (BUG-37) |
| Report user | ✅ | 4 reasons |
| Contact request handshake | ✅ | Username/email based (no phone sync) |
| Profile (name/photo/about/username) | ✅ | Username unique + availability check |
| Light/dark/system theme | ✅ | — |
| Chat wallpaper | ⚠️ | Single theme colour; no per-chat choice |
| Push notifications | ⚠️ | Per-chat mute ✅; mentions ❌; reaction ✅. Requires Blaze (BUG-41); Android channel missing (BUG-40) |
| Offline send queue | ✅ | Per-uid, per-chat ordering, retry UI |
| Smart replies | ✅ | Mistral, off by default |
| Privacy: last-seen/photo/about | ⚠️ | Booleans, not everyone/contacts/nobody |
| E2E encryption | ❌ | Plaintext in RTDB |
| Multi-device / web | ❌ | — |
| Backup / restore | ❌ | — |
| Chat export | ❌ | — |
| Search people | ✅ | `searchUsers` callable, handle/email |

**Bottom line:** the messaging core is complete and most of it works. The gaps
are the extras people expect on top — documents, location, stories, group
calls, disappearing messages — plus the two big architectural items (E2E
encryption, multi-device). Everything marked ✅ above was verified working by
reading the code path end to end; nothing in that column is assumed.

**One caveat on the ✅ column, added in session 4:** "works" above means the code
path is correct and complete, *given a deployed backend*. The rows that depend on
Cloud Functions — push notifications, reaction pushes, call history, search
people, smart replies, and the push half of 1:1 calls — cannot be deployed on the
Spark plan at all. See BUG-41 before treating this table as a statement about a
running app.

---

## Part 0.6 — Session 4 audit (2026-08-21): the locked/killed-device path

This session asked one question — *what still works when the phone is locked,
swiped away, or off?* — and answered it by reading the delivery path end to end.
Five new bugs came out of it (BUG-37 … BUG-41, in Part 2), one of which is a
project-level dependency the document had never stated. The table below is the
answer; read it with those five entries.

### What actually survives a locked or killed device

The honest answer differs per platform and per state.

| State | Message notification | Incoming call rings |
|---|---|---|
| App foreground | In-app banner, no tray push (by design, `NotificationManager.ts:116`) | RTDB `incoming/{uid}` pointer — faster than the push |
| App backgrounded, screen locked | ✅ tray push, both platforms | ✅ Android (data-only wakes the headless task); ⚠️ iOS needs the app still resident |
| App killed / swiped away | ✅ Android and iOS — the `notification` block means the OS draws it without our JS | ✅ Android from cold (`BackgroundTaskManager.ts:74`); ❌ **iOS — no PushKit VoIP** (BUG-39) |
| Device powered off | ❌ nothing, by definition. FCM queues within TTL and delivers on next boot; the 45s call TTL (`functions/index.js:39`) will have expired | ❌ |

Two things worth internalising from that table. First, the Android cold-start
call path is genuinely good and the ordering that makes it work is load-bearing —
`setBackgroundMessageHandler` must be registered on the first JS tick, which is
why `BackgroundTaskManager` is imported for side effects from `index.js` and why
nothing in it may touch React, navigation or the store. Do not "tidy" that
import. Second, none of the notification column works without Blaze (BUG-41), and
the call column is additionally gated on BUG-37 (blocking bypass) and BUG-38
(rejected iOS header). Someone testing on Spark will conclude notifications are
broken when they are merely absent — which is exactly the kind of wrong diagnosis
this document exists to prevent.

---

## Part 0 — Rules of engagement

**Flyer** is a React Native (Expo SDK 53) + Firebase Realtime Database chat app.
Stack: Expo Router, a Zustand store exposed as `appState` / `useAppStore`,
Firebase RTDB (**not** Firestore), Cloud Functions v2 in `functions/index.js`,
Cloudinary for media, `react-native-webrtc` + CallKeep for 1:1 calls, Mistral for
smart replies.

Non-negotiables:

1. **`database.rules.json` is the contract. Read it before touching any service.**
   The single most common bug class in this codebase is a client read or write on
   a path the rules reject at runtime. Cross-check every `readOnce`, `onValue`,
   `write`, `update`, `fanOut`, and `remove` against it.
2. **In RTDB an existence check is a read, and reads are governed.** Probing a
   path you are not yet authorised to read returns `PERMISSION_DENIED`, not
   `null`. Two shipped P0 bugs were exactly this (BUG-01, BUG-02). Use the
   `isPermissionDenied` helper in `src/services/FirebaseService.ts`.
3. **Never read another user's private subtree from the client.** Rules scope
   `blocks`, `contacts`, `contactRequests`, `sentRequests`, `starred`,
   `userChats`, `fcmTokens`, and `callHistory` to `auth.uid === $uid`. If a
   feature needs peer-side data, it belongs in a Cloud Function or a deliberately
   mirrored public node.
4. **Never widen a security rule to make a client call work.** Fix the client. If
   you believe a rule genuinely must change, stop and explain first.
5. **Run `npx tsc --noEmit` after every change set.** It must exit 0. It does
   today.
6. **One concern per commit.** Do not mix a bug fix with a feature.
7. **No new dependency** without stating why an existing one will not do.
8. **Match the existing comment style.** This codebase explains *why*, not *what*.
   Comments that restate the code will be rejected.

---

## Part 1 — Ground truth: what already exists

**Do not rebuild any of this.** 18 screens under `app/`, 56 files under `src/`.

Working: 1:1 and group chat; text, image, video and audio messages; reply;
forward; star; reactions; edit; delete for me and for everyone; multi-select via
long-press; jump-to-quoted-message; infinite scroll upward; typing indicators;
presence and last-seen; unread badges; read receipts with a privacy toggle;
pin, archive and mute chats; contact requests with an accept/decline handshake;
blocking (UI only — see BUG-03); groups with admin roles; 1:1 audio and video
calls over WebRTC with CallKeep integration; an offline outbox with retry; push
notifications; light and dark themes; smart replies via Mistral.

Cloud Functions already deployed (`functions/index.js`, 675 lines):
`sendCallInvite`, `cancelCallInvite`, `onMessageWritten` (push fan-out),
`onCallStateChanged`, `reapStaleCalls` (every 5 minutes), `smartReply`.

Notable file sizes: `app/chat/[chatId].tsx` is **1902 lines** — the highest-churn
and hardest-to-change file in the repo (see Part 4).

---

## Part 2 — Confirmed bugs, in fix order

### Already fixed in this session — verify, do not redo

**BUG-01 · P0 · every contact request failed.**
`ContactService.sendRequest` read `blocks/{toUid}/{myUid}` to check "did they
block me". `blocks/$uid` is owner-only, so the read was denied, the enclosing
`Promise.all` rejected, and the UI showed *"Could not send request"* 100% of the
time regardless of who was being added. Fixed by removing the peer-side block
read and letting the server-side rule enforce it.

**BUG-02 · P0 · the first chat with any person failed.**
`ChatEngine.ensureChat` called `readOnce(chats/{chatId})` to test existence.
`chats/$chatId/.read` requires being a participant, and a chat that does not exist
yet has none — so the probe was denied and creation threw. Fixed by treating
permission-denied as "not there" and treating a lost create race as success.

> Both bugs are the same root cause. Internalise it before continuing.

### P0 — ship-blocking, still open

**BUG-03 · Blocking does not block anything.** Both halves are broken. *Client:*
`isBlockedByPeer` (`ChatEngine.ts:929`) reads the peer's block list, is denied,
catches, and returns `false` — so it always reports "not blocked", which is worse
than no check because callers trust it. *Server:* I grepped `database.rules.json`
for `blocks` — it appears **twice**, in the node definition and in the
contact-request rule. It appears nowhere in the message write rule. A blocked user
can still send you messages and they still arrive. **Fix:** maintain a symmetric
`blockPairs/{chatId}/{uid}: true` node readable by both parties, guard the message
write rule with it, and delete the client-side probe.

**BUG-04 · Any authenticated user can dump your entire user table.**
`users/.read` is `auth != null`, `users` is `.indexOn: ["email"]`, and
`fetchAllUsers` (`ChatEngine.ts:960`) reads the whole node. Any account — one
created ten seconds ago — can enumerate every user, email, about text, and
last-seen. `usernames/.read` has the same shape for handles. **Fix:** scope
`users/$uid/.read` to self ∪ contacts, expose a minimal `publicProfiles/{uid}`
mirror for discovery, and replace `fetchAllUsers` with a capped server-side search
function. This is a data-protection exposure, not only a scaling one.

> **Fixed 2026-08-08, with two deliberate deviations from the fix as written.**
>
> *No `publicProfiles` mirror.* Enumeration in RTDB is a read of the **parent**:
> both `orderByChild(...).equalTo(...)` and a plain child listing need `.read` at
> the queried node, not on the rows. So dropping `.read` from `users` and
> `usernames` and granting it per row closes the hole outright, and every
> existing known-uid read keeps working untouched. A mirror would have added a
> dual-write to keep in sync and a drift-bug class the app does not need. This
> *narrows* the rules, so Part 0 rule 4 is satisfied.
>
> *`users/$uid/.read` stays `auth != null` rather than self ∪ contacts.* A
> contacts-scoped read rule cannot be evaluated: the rule would have to consult
> `contacts/{peer}/{me}`, which is owner-only, and widening `contacts` to make it
> readable would trade a smaller hole for a larger one. Since a uid is a 28-char
> random string, "knows the uid" is already close to "was given it". The residual
> exposure — that a uid-holder can read the `email` on the row — is recorded
> separately as **BUG-30**, because fixing it is a schema migration.
>
> `.indexOn: ["email"]` was **kept**: an index is not a permission. It makes the
> callable's email lookup a seek instead of a full scan and grants nothing to a
> client that can no longer read the node.

**BUG-05 · Cloudinary uploads are unsigned.** The upload preset ships inlined in
the bundle (`src/config/env.ts` documents this as intentional). Anyone who unpacks
the APK can upload arbitrary files to your account. **Fix:** signed uploads, with
a Cloud Function issuing short-lived signatures.

**BUG-06 · No TURN server.** `Ice.iceServers` (`src/config/env.ts:63`) is
STUN-only, and the code comments acknowledge it. Calls fail for any pair behind
symmetric or carrier-grade NAT — roughly 10–15% of mobile users — and fail
*silently*, as a call that rings forever. **Fix:** add TURN, serve credentials
from a function, and surface a real error on ICE failure.

**BUG-07 · Sign-out leaks state into the next account.** `stopOutbox()`
(`OfflineQueue.ts:66`) only detaches the NetInfo listener; it never clears
`queue`, and the AsyncStorage key `@flyer/outbox/v1` is not namespaced by uid.
`typingTimers` (`ChatEngine.ts:754`) is a module-level `Map` never torn down. Sign
out of A, sign in as B, and A's queued messages replay under B's session, fail the
`senderId === auth.uid` rule, retry six times, and surface in B's UI as failed
sends containing A's text. **Fix:** clear the queue and timer maps in the
auth-change teardown; namespace the storage key by uid.

### P1 — notifications (all confirmed in `functions/index.js`)

Group these four into one PR — one file, one review, the best effort-to-payoff
ratio in this document.

**BUG-20 · "Mute forever" does not mute notifications.** *(Fixed 2026-08-08.)*
The client writes `-1` as the forever sentinel (`app/chat/[chatId].tsx:1076`) and
`isChatMuted` (`ChatEngine.ts:925`) read it correctly, but `onMessageWritten`
tested `Number(mutedBy[uid] || 0) > now`, and `-1 > now` is **false** — so the
push went out anyway. Muting a chat forever silenced the badge and the in-app
banner while still delivering every push. Now `until < 0 || until > now`, which
treats *any* negative as forever rather than pinning the check to the one
sentinel value the client happens to send today.

**BUG-21 · Group system messages send pushes.** *(Fixed 2026-08-08.)*
`onMessageWritten` never checked `message.type === 'system'`, so every rename,
photo change, member add, removal and admin grant pushed to all members with a
body of "Members added" — a notification storm on every membership edit of a
20-person group. Now an early return, before any token or chat read.

**BUG-22 · Group notifications do not say which group.** *(Fixed 2026-08-08.)*
The push title was `senderName` alone, so in a group the user saw "Ravi" with no
indication which of their groups it came from. Now
`chat.isGroup && chat.name ? senderName + ' @ ' + chat.name : senderName` — the
`chat.name` guard matters because a group with a null name would otherwise
render "Ravi @ null".

**BUG-23 · No notification for reactions or mentions.** *(Fixed 2026-08-08 —
reactions half only.)* `onReactionCreated` in `functions/index.js` now tells the
message's author when someone reacts — author only, never the whole group;
respects mute and block; tagged separately from the chat's message
notifications so one cannot replace the other in the tray. Mentions (F-07) do
not exist yet; the mention-breaks-mute rule is still open, to land with F-07.

**BUG-24 · Typing indicator lingers three seconds too long.** *(Fixed
2026-08-08.)* `selectPeerTyping` now derives its stale cutoff from
`Limits.typingIdleMs + 1000` instead of a flat 6000, and `setTyping` registers
`onDisconnect().remove()` alongside the write so a killed process clears the
flag at the server. See also BUG-32, which this fix made marginally easier to
hit.

### P1 — data integrity (confirmed against `database.rules.json`)

**BUG-25 · Message payloads are partly unvalidated.** *(Entry corrected 2026-08-08
— the original text overstated this. `text`, `type` and `timestamp` do each carry
a `.validate` at `database.rules.json:188-197`: `text` is capped, `type` is
matched against the known union, and `timestamp` is pinned to `now` on create.
The 10 MB text, the `"lolwat"` type and the year-2286 timestamp are all already
rejected.)* What is genuinely missing: `mediaUrl` and `thumbUrl` are length-capped
but not host-matched, so a participant can point a bubble at any URL on the
internet; `width`, `height` and `durationMs` have no `.validate` at all; and the
edit window is unenforced server-side — `edited` may be set at any later time.
**Fix:** host-match the two URL leaves against the Cloudinary delivery host,
bound the three numeric leaves, and enforce the edit window in the rule rather
than only in the client.

**BUG-26 · `type` is not pinned to the sender.** *(Entry corrected 2026-08-08 —
the described attack does not currently work, though the asymmetry is real.)*
`text`, `mediaUrl`, `thumbUrl`, `edited` and `deleted` each carry a per-leaf
`.write` restricting them to `senderId`; `type` carries none. But the absence of
a per-leaf `.write` is what *blocks* the attack rather than enabling it: with no
rule at the leaf, a write to `type` is governed by the parent create rule, which
only fires when `!data.exists()` — so flipping an existing message's `type` is
already denied. The fix is still worth making, because the protection is
incidental. Adding a leaf `.write` for any other reason would silently open the
hole. **Fix:** apply the same explicit `senderId` guard to `type`, so the denial
is stated rather than inherited.

**BUG-27 · Reaction count is unbounded.** Each reaction is capped at 16 chars, but
nothing caps how many reactions a message holds or how fast one user can toggle.
Minor alone; combines badly with BUG-16.

**BUG-28 · `lastMessage` is writable by any participant.** Any member can rewrite
the chat's last-message preview to arbitrary text, attributed to whoever
`senderId` claims. **Fix:** make it server-written in `onMessageWritten` and deny
client writes.

**BUG-29 · Optimistic timestamps use a possibly-skewed device clock.** Writes use
`serverTimestamp()`, but the optimistic local row carries `Date.now()`. On a
device with a skewed clock — common, often minutes off — messages visibly jump
position after the server ack. **Fix:** compute an offset once from
`.info/serverTimeOffset` and use it for all optimistic timestamps.

### P1 — correctness and cost

**BUG-08 · Group sends are O(members) round-trips.** `commitMessage` fires **one
transaction per recipient** to increment unread — 255 transactions for one message
in a full group. **Fix:** move unread accounting into `onMessageWritten` and use a
single multi-path update.

**BUG-09 · Outbox head-of-line blocking.** `flush()` (`OfflineQueue.ts:135`)
`break`s on the first failure. One permanently-failing item — a message to a group
you were removed from — freezes the outbox for *every* chat indefinitely. **Fix:**
continue past failures; park exhausted items in a failed bucket with manual retry.

**BUG-10 · Edit and delete have no time window.** Rules allow editing `text`
forever and deleting for everyone forever. WhatsApp caps edits at 15 minutes and
delete-for-everyone at about two days. **Fix:** enforce in rules against the
message's own `timestamp`; hide the actions in the UI once expired.

**BUG-11 · Every new message re-downloads the whole window.**
`listenToMessages` uses `onValue` on a `limitToLast(40)` query, so each arriving
message re-transmits all 40 rows. This is also a direct bandwidth bill. **Fix:**
`onChildAdded` / `onChildChanged` / `onChildRemoved` with incremental reconcile.

**BUG-12 · "Clear chat" and "delete for me" do not delete.** `clearedAt` and
`hiddenFor` are applied in client-side `.filter()` calls. The data stays on the
server and is still downloaded on every snapshot. It is a privacy claim the
implementation does not honour. **Fix:** server-side deletion via function, or
per-user tombstones the query respects.

**BUG-13 · `createGroup` is not atomic.** Three sequential writes with no
rollback. A failure on step two leaves an orphaned group containing only the
creator, invisible to its intended members. **Fix:** a single multi-path update,
or a function that owns the operation.

**BUG-14 · `leaveGroup` promotes the wrong person.** The comment says the
longest-standing member is promoted to admin; the code takes `Object.keys(...)[0]`
(`GroupService.ts:295`), which is lexicographic uid order, not join order.
**Fix:** store `joinedAt` and promote by it — or change the comment to match.

**BUG-15 · `deleteAccount` leaves dangling references.** It removes the user's own
subtrees, which is all the rules permit. The deleted user therefore remains in
every *other* user's `contacts` and in group participant lists forever, rendering
as a ghost row. **Fix:** an admin-privileged function that reverse-indexes and
cleans up, plus a tombstone so the UI can render "Deleted account".

**BUG-16 · No rate limiting anywhere.** Messages, contact requests, and especially
`reports` (`.write` open to any authed user) can be spammed without limit.
**Fix:** per-uid sliding-window counters enforced in rules, plus App Check
(H-01) on all callables.

### P2 — polish

**BUG-17 ·** `loadOlderMessages` uses an inclusive `endAt(before)` boundary and so
returns rows the caller already has. This is deliberate — an exclusive boundary
drops entire millisecond-tie groups and silently loses messages — but the dedupe
lives in the caller. Move it into the service so no future caller forgets.

**BUG-18 ·** Privacy settings are booleans. WhatsApp uses
everyone / my-contacts / nobody for last-seen, photo, about, and read receipts,
plus "who can add me to groups". Migrate to enums now, while the user count is
small.

**BUG-19 ·** `listenToChats` per-chat listeners die silently when a chat read is
denied (e.g. after removal from a group), leaving a stale row in the list. Attach
an error handler that evicts the chat.

### Found during execution — not in the original list

Added under the Part 9 standing instruction. Each was discovered while fixing
something else, and each is recorded here before being fixed.

**BUG-30 · P1 · Any uid-holder can read a user's email address.**
`database.rules.json:19` — `users/$uid/.read` is `auth != null`, and the row
includes `email`. Symptom: a stranger who shares one group with you, or who ever
received a contact request from you, can read the address you signed up with.
Root cause: `email` lives in the same node as the display fields every peer
legitimately needs (name, photo, presence), so one read rule governs both. This
is *not* new — it predates the BUG-04 work — but closing the enumeration hole
made it the widest remaining read. **Fix:** move `email` to a sibling node
readable only by its owner (`private/{uid}/email`), leave the searchable copy to
the `searchUsers` callable, which matches on it without returning it. Touches
`AuthManager.upsertProfile` and the six read sites (`CallManager.ts:186`,
`add-contact.tsx`, `requests.tsx:134`, `(tabs)/contacts.tsx:50`,
`new-group.tsx:61`, `profile.tsx:488`). Deferred deliberately from the BUG-04
change set: it is a schema migration with its own backfill, and mixing it in
would have violated Part 0 rule 6.

**BUG-31 · P2 · `searchUsers` slows enumeration but does not stop it.**
`functions/index.js` — the callable enforces a 3-character floor and a 20-result
cap, which turns "download the user table in one request" into roughly 55k
requests across the 3-character handle space. Symptom: none user-visible; this is
a scraping ceiling, not a bug a user hits. Root cause: no per-caller rate limit —
the same gap BUG-16 describes for messages and reports. **Fix:** fold into
BUG-16's per-uid sliding window, and require App Check (H-01) on this callable
specifically, since it is the one endpoint whose whole purpose is returning
strangers' details.

**BUG-32 · P2 · The typing indicator compares two devices' wall clocks.**
`ChatEngine.setTyping` writes `Date.now()` — the *writer's* clock — into
`typing/{chatId}/{uid}`, and `selectPeerTyping` (`StateManager.ts:303`) tests it
against the *reader's* `Date.now()`. Symptom: on a device whose clock runs fast
relative to its peer's, "typing…" never appears at all; on one running slow, it
appears and then sticks until the node is removed. Both are silent — the feature
just seems unreliable, which is why it has never been reported as a clock bug.
Root cause: the same one as **BUG-29**, but at a different site and with a
different fix surface — BUG-29 is about optimistic message timestamps within one
device, this is a value written by one device and judged by another. Skew of
more than the stale window breaks it in one direction or the other. **Fix:** the
`.info/serverTimeOffset` correction BUG-29 introduces, applied to the typing
write as well as the read, so both sides are talking about server time.
**Noted while fixing BUG-24** — and BUG-24's tighter cutoff *narrows* the
tolerated skew from 6s to 4s, so this got marginally easier to hit. That is the
correct trade (the 6s window was masking a stale-node bug rather than absorbing
skew on purpose), but it should not sit here indefinitely.

**BUG-33 · P0 · `database.rules.json` does not parse, so none of it is
deployed.** *(Fixed 2026-08-09.)* The email `.validate` at line 38 used
`/^[^@\s]+@[^@\s]+\.[^@\s]+$/`, and the RTDB rules regex engine has no `\s`. It
rejects the file whole, at parse time: `Illegal regular expression,
'whitespacechar' not found`. This is worse than one bad field. The rules file is
all-or-nothing, so **every fix in it — BUG-01, BUG-02, BUG-03, BUG-04 — is
sitting in a file the server will not accept**, and the live rules are whatever
was last successfully deployed. The line is committed at `HEAD`, so this is not
a regression from the current session's work; it means the P0 rules fixes were
never actually in force. Nothing caught it because `npm run check:rules`
validates *structure* (a child must map to an object) and never the expression
language, and no deploy has been attempted since.

Found by standing up the emulator — it is the first thing that loads the file
the way Firebase does, and it failed before a single test ran. That is the
strongest argument for step 1 that the exercise could have produced.

**Fix:** the denylist is not merely awkward to express, it is impossible. The
engine reads `\t` inside a class as a literal `t`, `[:space:]` as the literal
letters `a,c,e,p,s` (so it silently rejects ordinary addresses while appearing
to work), and a real newline terminates the regex literal — there is no way to
spell "not whitespace". Replaced with an RFC 5322 atext allowlist, kept
deliberately wide because the field is populated from Firebase Auth and a rule
stricter than Auth turns a legal address into a signup that cannot complete. The
empty string is explicitly allowed: `AuthManager.upsertProfile` writes
`user.email ?? ''`, so forbidding it would deny profile creation to any account
whose provider returns no address. All of it was determined against the real
engine rather than from documentation, which describes `matches()` only as
supporting "a subset of" a dialect it does not name.

**Two follow-ups this exposes, neither done here:**
- `check:rules` should compile expressions, not just walk structure. The
  emulator will do it — `firebase emulators:exec --only database` fails on a bad
  file — so the check can shell out to what `npm run test:rules` already
  installs. Worth doing *before* the next deploy, since this class of error is
  invisible until then.
- The `.indexOn: ["email"]` one line above is now the only remaining reader of
  this field's shape, and **BUG-30** proposes moving email out of the public
  profile entirely. When that lands, revisit whether this rule needs to exist.

**BUG-34 · P1 · A stale native end-call event hangs up the call you are on.**
`src/services/CallManager.ts:69` — the CallKeep `end` subscription reads
`void this.hangUp(this.callId === event.callId ? 'hangup' : 'rejected')`. The
ternary correctly notices that the event belongs to *a different call than the
active one*, and then hangs up anyway: `hangUp()` takes no call id and always
tears down `this.callId`. The id comparison only picks the label written to
`endedReason`. Symptom: a connected call drops on its own, blamed on the network.
Reachable two ways — the OS emitting `endCall` for a ghost UUID left over from a
previous process (the cold-start path in `BackgroundTaskManager` displays a
CallKeep UI that outlives the JS that created it), and the busy path at
`CallManager.ts:218-226`, which rejects a second invite at the RTDB layer while
its native call UI is still live and will emit `endCall` when dismissed. Root
cause: an id mismatch is treated as a naming question rather than a routing one.
**Fix:** in the mismatch branch, do not touch the active call — `CallKeep.endCall`
the stale id so the OS drops that specific UI, warn, and return. Only an event
matching `this.callId` may reach `hangUp()`.
*Found while auditing the killed-app call path (Part 4 / task #14).*

**BUG-35 · P1 · The splash hides one round-trip before the UI is ready, so every
cold start flashes a spinner.** `app/_layout.tsx:173` — `await SplashScreen.hideAsync()`
runs at the end of the auth callback, but the thing that makes the app renderable
is `setAuthReady(true)`, which fires from the `onValue(Paths.user(uid))` callback
attached 45 lines earlier and **has not fired yet**. Between the two, `RootNavigator`
renders its `!authReady` boot spinner (`:203-209`). Symptom: splash → bare spinner
on the theme background → app, the middle frame lasting one RTDB round-trip, longer
on mobile data, and the POST_NOTIFICATIONS dialog can pop over it. Note the comment
at `:45` — "Keep the native splash up until auth has resolved, so the app never
flashes the login screen at someone who is already signed in" — the intent is right
and the code misses it by one async hop; it flashes a spinner instead of the login
screen. Root cause: splash dismissal is sequenced against *the auth callback
finishing* rather than against *readiness*. **Fix:** hide the splash from an effect
keyed on `authReady` and delete both `hideAsync()` calls from the callback. This
covers the signed-out path for free — `reset()` sets `authReady: true`
(`StateManager.ts:225`), so the same effect fires when there is no user.
*Related:* **S-07** (cold start does too much before first paint) is the same area;
this is the visible half of it.

**BUG-36 · P1 · Cold start for a signed-out user flashes the empty chat list
before the login screen.** `app/_layout.tsx:55-67` — the auth gate redirects from a
`useEffect`, which by definition runs *after* the frame is painted. On a cold start
the URL is `/`, so expo-router mounts and paints `(tabs)` first; only then does the
effect call `router.replace('/login')`. Symptom: a flash of the empty chat list and
tab bar on the way to the login screen, and the mirror-image flash of the login
screen when a sign-in resolves while it is still the visible route. Root cause: the
gate treats "wrong screen is showing" as something to correct next tick rather than
something to cover this tick. **Fix:** derive a `redirecting` flag alongside the
existing conditions and paint a plain background over the `Stack` while it is true.
It must be an *overlay*, not an early return — unmounting the `Stack` unmounts the
navigator, `useRootNavigationState().key` goes undefined, the gate's own
`if (!navState?.key) return` then never clears, and the app deadlocks on the
placeholder. Background only, no spinner: the window is one or two frames and a
spinner that brief is itself a flicker.

**BUG-37 · P0 · Blocking does not block calls. A blocked user can still ring
your phone, on the lock screen, from a cold start.**
BUG-03 closed this for messages and left calls wide open. There are two paths to
a ring and only one of them is guarded:

- *The push* is guarded. `sendCallInvite` reads `blocks/{calleeId}/{callerId}`
  (`functions/index.js:248`) and refuses with a deliberately generic message.
- *The ring pointer* is not. `CallManager.startCall` writes
  `incoming/{callee}/{callId}` **directly from the client**
  (`CallManager.ts:175`), before and independently of the callable. The rule at
  `database.rules.json:448` permits any authenticated user to create that node
  for anyone as long as `callerId === auth.uid` — it never consults `blocks` or
  `blockPairs`. `calls/$callId/.write` (`:378`) has the same gap.
- *The callee's client* does not backstop it either. `handleIncoming`
  (`CallManager.ts:216`) checks busy state and a stale record, then rings. It
  never reads `appState.blocked`, even though that map is populated
  (`StateManager.ts:131`) and the message path *does* check it —
  `handleForeground` bails on `appState.get().blocked[senderId]`
  (`NotificationManager.ts:127`). Messages consult the local block list; calls
  do not.

So the push is silently dropped and the RTDB write rings the phone anyway —
CallKeep raises the full-screen system call UI over the lock screen, and on a
killed Android app the data push isn't even needed because the pointer fires as
soon as the process comes back. The server-side check creates a false sense that
this is covered.

**Fix, in this order:** (1) guard the `incoming/$uid/$callId` write rule with
`blockPairs`. The rule cannot call `chatIdFor`, but it does not need to — the
pair id is a sorted join (`env.ts:76`) so exactly one of two keys can exist, and
both are cheap to test:
`!root.child('blockPairs').child(auth.uid + '_' + $uid).hasChildren() && !root.child('blockPairs').child($uid + '_' + auth.uid).hasChildren()`.
(2) Add the same clause to `calls/$callId/.write`. (3) Add an
`appState.blocked[invite.callerId]` guard at the top of `handleIncoming` and
remove the pointer, so a client that somehow receives one still does not ring.
Rules are the enforcement; the client check is there so the UI never renders a
call it is about to reject.
*Found while auditing what survives with the screen locked.*

**BUG-38 · P1 · The iOS call push sends a header combination APNs rejects, and
the failure can permanently unregister the device.**
`callPushEnvelope` (`functions/index.js:199-208`) sets
`'apns-push-type': 'background'` together with `'apns-priority': '10'`. Apple's
header table allows priority 10 only for alert pushes; a background push must be
5 (or 1). The documented response is `400 BadPriority`, which means **no iOS
device is woken for an incoming call** — the invite reaches the callee only if
their app happens to be alive and the RTDB pointer fires.

The cascade is the worse half. `sendToUser` prunes any token whose error code is
in `DEAD_TOKEN_CODES` (`:100-104`), and that set includes
`messaging/invalid-argument` — the code FCM uses for a malformed message. The
`wholeChunkInvalid` guard (`:155`) suppresses pruning only when *every* token in
the chunk failed that way, which saves an iOS-only user. It does not save a user
with an Android phone and an iPad: the Android token succeeds, the chunk is
mixed, the guard is false, and **the iOS token is deleted from
`fcmTokens/{uid}`** (`:173`). That device then stops receiving *message* pushes
too, permanently, until a token refresh happens to re-add it. The multi-device
token set exists precisely to keep several devices ringing
(`NotificationManager.ts:43-46`), and this quietly dismantles it one device at a
time.

**Fix:** send `'apns-priority': '5'` for the background envelope; leave the
message envelope at 10, where it is correct because that one is
`apns-push-type: 'alert'` (`:409-410`). Separately, drop
`messaging/invalid-argument` from `DEAD_TOKEN_CODES` — a payload error is not a
token verdict, and the existing comment at `:96-99` already admits the code is
ambiguous. The `wholeChunkInvalid` guard was the right instinct applied at the
wrong altitude: it tries to infer a bad payload from the response pattern
instead of not treating a payload error as a dead token in the first place.
**Verify before shipping:** confirm the exact FCM error code returned for a
BadPriority rejection against a real iOS token — the priority fix is correct
regardless, but the pruning cascade depends on that mapping.

**BUG-39 · P1 · On iOS, a killed app cannot ring at all, and the parity table
says otherwise.**
Not a regression — a structural gap that is documented in the code and missing
from this file. `CallKeepService.ts:12-21` states it plainly: CallKit's
full-screen incoming UI on a terminated app requires a PushKit VoIP push, FCM
cannot send one, so the callee gets a normal notification they must tap.
Confirmed from the outside too: `UIBackgroundModes` declares `voip`
(`app.config.ts:66`), but nothing registers a PushKit token —
`NotificationManager.start` only calls `registerDeviceForRemoteMessages`
(`:61`) — and there is no VoIP push dependency in `package.json`. A
`content-available: 1` background push does not launch a terminated iOS app in
any case, so BUG-38's header fix is necessary but not sufficient.

The Part 0.5 parity table currently reads "1:1 voice/video calls ✅ WebRTC +
CallKeep + PiP" with no platform caveat, which overstates it. **Correct the
table to ⚠️ (Android rings from cold; iOS needs the app alive)** and treat the
VoIP transport as its own work item: an Apple VoIP key, pushes sent straight to
APNs rather than through FCM, plus `react-native-voip-push-notification`. Note
that iOS 13+ *requires* reporting a CallKit call on every VoIP push received —
so the handler cannot decide not to ring, and a push for an already-cancelled
call must still present and then immediately end, or iOS stops delivering VoIP
pushes to the app.

**BUG-40 · P2 · Every message notification names an Android channel that does
not exist.**
`onMessageWritten` sets `android.notification.channelId: 'messages'`
(`functions/index.js:402`) and `onReactionCreated` the same (`:500`). Nothing
creates that channel. Grepping the client for channel creation finds exactly one
id, `com.flyer.chat.calls`, created by CallKeep's foreground-service config
(`CallKeepService.ts:88`). So every message and reaction push lands on FCM's
auto-created fallback channel at default importance: no heads-up banner while
the phone is unlocked, no per-channel sound, and nothing for the user to tune in
Android settings. The per-chat `tag` still works, so replacement behaviour is
unaffected.

This is *half* recorded already — Part 4's `ensureChannels()` entry explains why
the empty stub was deleted and argues real channels deserve a designed feature.
What it does not record is that the functions still name `'messages'`, so the
two halves of the decision disagree: the server behaves as though channels exist
and the client guarantees they do not. **Fix:** either drop the `channelId` keys
so the fallback is explicit rather than accidental, or create the channel set —
but do not leave the payload asserting something untrue. If channels do get
built, `messages` and the existing calls channel should be designed together
with the mute UI, per that Part 4 entry.

**BUG-41 · P0 · Everything in Part 2's notification and call work is undeployable
on the Spark plan, and one security fix put user discovery behind that paywall.**
Not a code defect — a dependency the document never states, which makes several
"fixed" entries conditional. Every function in `functions/index.js` is Cloud
Functions **v2** (`onCall`, `onValueCreated`, `onValueUpdated`, `onSchedule` via
`firebase-functions/v2`, `:21-25`), which builds on Cloud Run, Artifact Registry
and Cloud Build; `reapStaleCalls` (`:614`) additionally needs Cloud Scheduler,
and `smartReply` (`:858`) needs Secret Manager for `MISTRAL_API_KEY` (`:74`).
None of those APIs can be enabled on a project without a billing account, so on
Spark the deploy fails before any code runs.

What that actually costs, by reading the call sites:

- No message or reaction pushes at all — `onMessageWritten` is the only sender.
- No call invite or cancel push, so BUG-38 and BUG-39 are moot until billing
  exists; incoming calls work only while the callee's app is alive and the RTDB
  pointer fires.
- No call history for either side. `callHistory` is admin-written by design
  (`database.rules.json:461-466` — the client `.write` is delete-only), so the
  history screen stays permanently empty rather than degrading.
- No stale-call reaping, so a caller who dies mid-ring leaves `calls/{id}/state`
  at `ringing` forever.
- **No user discovery whatsoever.** This is the sharp one. BUG-04's fix deleted
  `fetchAllUsers` and removed parent `.read` from `users` and `usernames`, so
  the client *cannot* search even in principle; `DirectoryService` is "the only
  way in" by its own comment (`DirectoryService.ts:11-12`) and it does nothing
  but invoke the `searchUsers` callable (`:86`). Add-contact, add-by-email and
  new-group member search all dead-end. A security fix moved a core user-facing
  feature behind a paid dependency with no client-side fallback, and nothing
  recorded the coupling.

**Fix / decision to make explicitly, like S-01:** Blaze with a budget alert and
`maxInstances` already set (`:35`) is the intended path, and the functions free
tier means a small project typically bills nothing — the requirement is a card
on file, not a cost. Write the decision down either way. If Spark has to hold
for now, the honest mitigation is to degrade loudly rather than silently: have
`DirectoryService` surface "search is unavailable" on `functions/not-found`
instead of rendering an empty result that looks like "no such user", and hide the
call-history tab rather than showing a permanently empty list. **Verify at
deploy:** confirm the current Blaze requirement against
`firebase.google.com/pricing` before acting on this entry — plan gating has
changed over time, and this session could not check it live.

---

## Part 3 — WhatsApp feature parity

Ordered by user-visible value ÷ implementation cost. Ship top-down.

### Tier 1 — noticed immediately

**F-01 · Search inside a chat.** Global chat search exists; in-thread search does
not. Add a header search mode with match highlighting and prev/next navigation.
RTDB cannot do substring queries, so paginate backwards and filter client-side.

**F-02 · Document and file attachments.** `AttachSheet.tsx:20` documents that
documents were deliberately excluded. Revisit — sending a PDF is table stakes. Add
`expo-document-picker`, a `document` message type with `fileName`, `mimeType`,
`sizeBytes`, a file-row bubble, and a size cap.

**F-03 · Location sharing.** Static "send my location" plus live location with a
duration. Needs `expo-location`, a `location` message type, and a static map
preview.

**F-04 · Contact cards (vCard).** Share a contact into a chat as a tappable card
offering "message" and "add".

**F-05 · Voice-note improvements.** Recording works. Missing: waveform scrubbing
during playback, variable speed (1× / 1.5× / 2×), and continuous playback through
consecutive notes.

**F-06 · Swipe-to-reply.** Long-press → reply exists. Add the swipe-right gesture,
which is how most people actually reply.

**F-07 · @mentions in groups.** None at all. Autocomplete on `@`, store
`mentions: string[]`, render highlighted, notify mentioned users **even in a muted
group**, and badge the chat row. Pair with BUG-23.

**F-08 · Chat wallpaper.** `chatWallpaper` is currently a single theme colour
(`theme.ts:81`). Allow per-chat or global: solid, gradient, or uploaded image.

**F-09 · Starred-message jump.** The starred list exists but tapping an entry does
not jump to it in context. Wire it to the existing `jumpToMessage`.

**F-10 · Message-info screen.** For your own messages in a group, a per-member
delivered/read breakdown with timestamps.

### Tier 2 — expected by mature users

**F-11 · Disappearing messages.** Per-chat TTL of 24h / 7d / 90d, enforced by a
scheduled function (extend the `reapStaleCalls` pattern), with a system message on
change.

**F-12 · View-once media.** `viewOnce: true`; after the recipient opens it, the
function nulls `mediaUrl`, marks it consumed, and destroys the Cloudinary asset.

**F-13 · Status / Stories.** 24-hour ephemeral posts with a viewer list, privacy
controls, and reply-to-status routing into a normal chat. Large: a new
`status/{uid}/{statusId}` node, a tray on the chat list, a full-screen viewer, and
a reaper function.

**F-14 · Polls.** A `poll` message type with options, single or multi vote, live
tallies, and a voter list. Votes under `messages/.../poll/votes/{uid}` so the
existing per-uid write rule pattern applies unchanged.

**F-15 · Broadcast lists.** One message to many recipients as separate 1:1 chats.

**F-16 · Communities.** Multiple groups under an umbrella with an announcement
channel.

**F-17 · Group invite links.** `chatId` plus a rotating token, deep-linked via
`expo-linking`, revocable by admins, with an optional approval queue.

**F-18 · Pinned messages within a chat.** Up to three, shown in a header strip.
Distinct from pinning a chat, which already exists.

**F-19 · Multi-device.** The `fcmTokens` set already supports multiple devices per
account. Audit the rest of the app for single-device assumptions.

**F-20 · Group calls.** Currently 1:1 only. Needs an SFU (LiveKit, mediasoup, or
Daily) — mesh WebRTC collapses past four participants. Scope as its own project.

### Tier 3 — differentiators

**F-21 · End-to-end encryption.** Messages are plaintext in RTDB today, readable
by anyone with console access. Implement Signal via `libsignal-client`: identity
keys in the keystore, prekey bundles in RTDB, per-chat sessions, encrypt before
write. This changes search, notifications (payloads become a bare "New message"),
and smart replies (must move on-device). Invasive — and the single biggest trust
differentiator. Do it **before** the user base grows.

**F-22 · Chat export.** A thread as `.txt` or `.zip` with media, via
`expo-sharing`.

**F-23 · Message translation.** Reuse the existing Mistral callable.

**F-24 · Scheduled messages.** Compose now, deliver later, via a scheduled
function.

**F-25 · Chat folders.** Unread / groups / favourites filters on the chat list.

**F-26 · Stickers and GIFs.** Sticker packs plus a Tenor or Giphy picker.

**F-27 · Backup and restore.** Encrypted export to the user's own cloud storage,
restorable on a new device.

**F-28 · Accessibility pass.** Screen-reader labels exist in places but are
inconsistent. Audit every interactive element, verify contrast, support dynamic
type, respect reduce-motion.

**F-29 · Localisation.** All strings are hardcoded English. Extract to i18n with
`expo-localization`, and add RTL — Arabic and Urdu matter for this app's likely
audience.

**F-30 · Draft persistence.** Persist unsent composer text per chat across
restarts.

---

## Part 4 — What to remove or replace

- **`fetchAllUsers`** — delete. Replace with a capped server-side search (BUG-04).
  It is both a privacy leak and an O(all users) download feeding a 20-row screen.
- **`isBlockedByPeer`** — delete entirely (BUG-03). A check that always returns
  `false` is worse than no check, because callers trust it.
- **`expo-av`** — deprecated and removed in SDK 54; already listed in
  `package.json`'s doctor exclusions. Migrate to `expo-audio` and `expo-video`
  before the next SDK bump.
- **`ensureChannels()`** — an empty function whose comment explains it does
  nothing (`NotificationManager.ts:156`). Implement per-channel config or delete
  it and its call site. **(Resolved 2026-08-09 — deleted.)** Deleting was the
  honest of the two options for now, after reading the RNFirebase native
  sources: the comment's claim that "RNFirebase creates the `messages` channel
  natively from the `channelId` we send" is false — `ReactNativeFirebaseMessagingReceiver.java`
  never touches channels, so a notification whose `channelId` does not exist on
  the device falls into FCM's auto-created "Miscellaneous" channel (default
  importance) rather than being dropped. Real Android notification channels are
  a feature worth doing deliberately — the IMPORTANCE_HIGH so "mute for 8
  hours" centres the tray differently from the default, per-channel sounds,
  lock-screen visibility — none of which has a UI yet; an empty stub that
  advertises channel support while actually having none is worse than no stub.
  Creating channels needs notifee, expo-notifications, or a small native
  module, and none of those are dependencies today. When Android channel-level
  notification tuning ships, that itinerary should design the channels of
  channels pub, the in-app per-channel settings UI, and the migration story
  (users with a notification open on the old "Miscellaneous" channel) together,
  not sneak a channel in through a one-line hook.
- **The unsigned Cloudinary preset** — replace with signed uploads (BUG-05).
- **Client-side unread increments** — move server-side (BUG-08).
- **`app/chat/[chatId].tsx` at 1902 lines** — extract the header, message list,
  selection mode, and reply/edit bar into components. Do this **before** Tier-1
  features; every one of them touches this file and makes it worse.

---

## Part 5 — Production hardening (verified absent)

I grepped `package.json`, `app/`, `src/`, `functions/index.js`, `app.config.ts`,
and `.github/`. All of the following are **completely absent**. None are
user-visible; together they are what separates a demo from a shippable app.

**H-01 · Firebase App Check.** Anyone who pulls `google-services.json` out of the
APK can talk to your database directly with a signed-up account, bypassing the app
entirely. Every rule fix above assumes the caller is your app; App Check is what
makes that true. Add `@react-native-firebase/app-check` with Play Integrity and
DeviceCheck, and enforce on RTDB and every callable. Do this **before** public
launch — enabling it later locks out already-installed clients.

**H-02 · Crash and error reporting.** No Sentry, no Crashlytics. You currently
learn about crashes from complaints. Add Crashlytics (already in the Firebase
stack, so no new vendor) plus a React error boundary at the root of `_layout.tsx`.
Scrub message text and identifiers before anything leaves the device.

**H-03 · Zero automated tests.** No jest config, no test files. The rules bugs in
Part 2 are exactly the class a test suite catches for free — and the emulator is
*already configured* in `firebase.json` (database on port 9000). Start with the
cases mapping to BUG-01 … BUG-10 using `@firebase/rules-unit-testing`; each is
about six lines and each would have caught a shipped bug. Then unit-test the pure
reducers in `StateManager.ts`, the easiest high-value target in the repo.

**H-04 · No CI.** `.github/workflows/` does not exist. Every push should run
`tsc --noEmit`, eslint, jest, and the rules tests. Without this the next rules
regression ships exactly the way these did.

**H-05 · No analytics.** You cannot answer "how many messages fail to send" or
"what is p95 media upload time". Add a small, deliberate event set
(`message_sent`, `media_upload_failed`, `call_connected`, `login_completed`)
rather than instrumenting everything. Never log message content.

**H-06 · The rules file is unreviewable.** 460+ lines with the subexpression
`root.child('chats').child($chatId).child('participants').child(auth.uid).exists()`
duplicated across a dozen nodes. One typo is invisible in a diff. Add a header
comment mapping each top-level node to the screens that read it.

---

## Part 6 — Performance and scale

Fine with 20 test users; breaks at 20,000.

**S-01 · RTDB is the wrong database for message history.** No compound queries, no
server-side text search, and billing on bytes *downloaded* — which BUG-11 turns
into a real bill. The migration nobody wants to do later: keep RTDB for presence,
typing, and call signalling (what it is genuinely best at) and move messages and
chats to Firestore for cursor pagination and cheaper reads. **Decide this
consciously now.** Migrating 100 users' history is an afternoon; migrating 10,000
users' history is a project.

**S-02 · No message archival.** `messages/{chatId}` grows without bound. Add a
scheduled function moving messages older than N months to cold storage, loaded on
demand.

**S-03 · Media has no lifecycle.** Cloudinary assets are never deleted — not on
message delete, chat clear, or account deletion. Cost grows monotonically and
deleted media stays retrievable by URL forever, which is a privacy problem as much
as a cost one. **Fix:** store the `public_id` on the message and destroy the asset
on delete.

**S-04 · Images download at full resolution.** `Limits.imageMaxDimension` is 1600
at quality 0.7, but there is no thumbnail variant — the chat list and the bubble
both fetch the full image. Use Cloudinary transformation URLs (`w_200,c_fill`) at
each render site. One line per site, roughly 90% less image bandwidth.

**S-05 · The chat `FlatList` re-renders everything.** 1902 lines of screen with
inline `renderItem` closures means every message re-renders on every state change.
Memoise `MessageBubble` with a real comparator, hoist `renderItem`, add
`getItemLayout`. Measure before and after.

**S-06 · Store subscription audit.** Several screens take four or five separate
`useAppStore` selectors. The two derived-array selectors that mattered are already
fixed with `useShallow` — see the comment at `StateManager.ts:236`, which explains
the zustand 5 footgun. Audit the rest against that comment.

**S-07 · Cold start does too much before first paint.** `_layout.tsx` sequences
auth → profile upsert → six listeners → presence → outbox → CallManager →
permissions → push registration with the splash held throughout. Defer everything
not needed for first paint (starred, contacts, requests, smart-reply hydration).

**S-08 · No offline read path on cold start.** `setPersistenceEnabled(true)` is on
— the important half. But `keepSynced` is never called, so a cold start while
offline shows an empty chat list rather than the cached one. Add
`ref(Paths.userChats(uid)).keepSynced(true)`.

---

## Part 7 — Beyond parity: reasons to switch to Flyer

Parity alone is not a reason to leave WhatsApp. These are where a small app can
actually win. **Pick two.** All five done badly is worse than two done well.

**X-01 · Be honest about privacy.** WhatsApp is E2E encrypted but Meta-owned and
metadata-hungry. F-21 plus a readable, specific privacy page — what is stored, for
how long, what the server can see — is a real differentiator for the audience most
likely to try a new messenger. Only credible if done before you hold data you
would rather not disclose.

**X-02 · On-device AI that does not phone home.** You already send message text to
Mistral for smart replies. Invert it: run a small on-device model for smart
replies, thread summarisation ("catch me up on 200 unread"), and translation.
"Your messages never leave your phone, including for AI" is a claim WhatsApp
cannot make, and it composes with X-01.

**X-03 · Large-group tooling that is actually good.** Group chat at 200 people is
miserable everywhere. Threaded replies, per-topic sub-channels, a digest mode, and
mention-only notifications. The Discord wedge applied to a personal messenger.

**X-04 · Sync that works on a bad connection.** Your outbox is already better than
most apps'. Lean in: visible per-message send state, an inspectable and reorderable
retry queue, resumable uploads, and a low-bandwidth mode. For users on patchy
mobile data this is the switching feature — and it is mostly polish on code you
already have.

**X-05 · Data portability as a feature.** One-tap export in an open format, and an
importer for WhatsApp's own export files. The biggest reason people do not switch
messengers is losing their history. Removing that objection is worth more than any
single feature in Part 3.

---

## Part 8 — Notification and call reliability ("WhatsApp level")

Part 3 is about *features* Flyer lacks. This part is about the delivery layer:
why a message that WhatsApp would have shown instantly, on the lock screen, with
the sender's photo and a reply box, currently shows up as a plain replaced banner
— or not at all. None of it is user-visible as a feature; all of it is what makes
people trust a messenger enough to switch.

Ordered by "how many missed notifications does this cause", worst first. Verified
against source the same way Part 2 is. Where a claim is about OS behaviour rather
than this codebase it is marked **[device-verify]** — those need a real handset or
a deploy to confirm, and must not be treated as established.

### The one that matters more than the rest combined

**N-01 · P0 · Nothing handles OEM battery killers, which is the dominant cause of
missed notifications on the phones this app is most likely to run on.**
Grepping the whole repo for battery-optimisation handling finds nothing:
no `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`, no autostart education, no
`isIgnoringBatteryOptimizations` check. `withFlyerCallKeep.js:27-49` declares 15
permissions and none is this one.

Why it dominates: Xiaomi (MIUI), Oppo/Realme (ColorOS), Vivo (Funtouch) and
Transsion (Tecno/Infinix) all kill background processes and revoke FCM wake-ups
far more aggressively than stock Android, and several require *manual* per-app
"Autostart" and "No battery restriction" toggles that no API can set. Widely used
apps tend to fare better on these ROMs — whether through vendor allowlists or
simply because users grant them the toggles — while a newly installed unknown app
gets the full restriction. The observable symptom is exactly the complaint that
makes people abandon a messenger — "messages only arrive when I open the app" —
and it will read as an FCM bug or a code bug when it is neither. On the likely
user base for this app (the same audience F-29's RTL work targets) this is not an
edge case, it is the common case. **[device-verify]** for the per-OEM specifics,
which change between ROM versions and are the part most likely to be stale.

**Fix, in the order that pays off:** (1) On first launch after notification
permission is granted, check `isIgnoringBatteryOptimizations`; if false, show a
one-screen explainer and fire the
`ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` intent. (2) Detect the
manufacturer and deep-link into the OEM's own autostart screen — the intents are
well-documented per ROM and a generic "open settings" is useless here because
the toggle is four levels deep. (3) Add a diagnostic screen the user can be
pointed at from support: notification permission, battery-optimisation state,
whether an FCM token exists, and last push received. (4) Re-check on app
foreground after an OS update, which silently re-restricts on some ROMs. Do not
implement (1) as a blocking gate — a permission wall on first run costs more
installs than it saves notifications.

**On the dependency question (Part 0 rule 7):** none of these APIs is reachable
from the current dependency set — `PermissionManager` covers only runtime
permissions and there is no intent-launcher package in `package.json`. So this
needs either a new dependency or a small native module. `package.json` already
declares `expo.autolinking.nativeModulesDir: './modules'` (`:73-77`), so a local
module is the cheaper option and keeps a single narrow surface (three methods:
is-exempt, request-exemption, open-OEM-settings) rather than pulling a library for
it. State whichever choice you make and why, per rule 7.

### Delivery correctness

**N-02 · P1 · There is no "delivered" state at all, so a message stays on one
tick until the recipient opens the app.**
`Message` carries `seenBy` and nothing else (`types.ts:92`), and `Ticks.tsx:52`
renders exactly two states: `check` when unseen, `doubleCheck` tinted when seen.
The comment at `Ticks.tsx:58-59` says "when a message flips from delivered to
seen", but no delivered state exists — the codebase's own comment describes a
model it does not implement. Meanwhile `BackgroundTaskManager`'s message branch
is an explicit no-op (`:91-94`, "the system tray draws them without our
involvement. Nothing to do here").

That no-op is the gap. WhatsApp's second tick means *the device received it*, and
it appears while the app is closed, because the push itself is the delivery
signal. Flyer cannot distinguish "their phone is off" from "they have not looked
yet", which is the single most-read piece of information in a chat UI.

**Fix:** in the background handler's `message` case, write
`messages/{chatId}/{messageId}/deliveredTo/{myUid}: true` before returning — the
handler is already async and Android keeps the headless task alive until the
promise settles. The rule is a direct copy of `seenBy`'s
(`database.rules.json:272-277`), which already restricts each uid to writing only
its own key and requires chat membership — so this is a new node in a proven
shape, not a new rule pattern. Then make `Ticks` three-state.

Two caveats. On iOS the background handler runs only for pushes that reach a
live-enough app, so iOS delivery marks will be less reliable than Android until
N-05 lands — acceptable, since a missing second tick reads as "not yet
delivered", which is the safe direction to be wrong in. And this adds one write
per recipient per message, so it belongs *after* BUG-08 moves unread accounting
server-side, not before.

Also note the constraint `markChatRead` documents (`ChatEngine.ts:937-940`): it
clears unread without touching `seenBy`, because a receipt should only turn blue
when the message was actually on screen. `deliveredTo` is the opposite — it is
exactly the signal that is legitimate to set without the user having looked. That
distinction is the whole reason the third state is worth having.

**N-03 · P1 · Multiple messages from one chat collapse into one notification that
shows only the newest, with no count.**
`android.notification.tag: chatId` (`functions/index.js:404`) makes each new push
replace the previous one for that chat — the comment says so deliberately: "One
live notification per chat: a newer message replaces the older." Ten messages
while the phone is on a table produce one banner showing the tenth, and no
indication the other nine exist. iOS is better by accident: `thread-id`
(`:414`) groups rather than replaces.

WhatsApp uses Android's `MessagingStyle` — one notification per chat that
*accumulates* lines, shows the count, and renders each sender's avatar — plus a
group summary across chats. The replacement behaviour was the right call given
the tools available (FCM's `notification` block cannot express MessagingStyle),
but it is the wrong end state.

**Fix:** this is the item that forces the architectural decision in N-06. A
server-composed `notification` block can never do MessagingStyle; it requires
building the notification on-device from a data-only push. Until then there is a
genuinely free mitigation: the count is *already in hand*. `unread` lives at
`chats/{chatId}/unread/{uid}` (`FirebaseService.ts:106`) and `onMessageWritten`
has already read the whole chat node into `chat` (`functions/index.js:352`), so
`(chat.unread || {})[uid]` costs nothing extra — put it in the body so the single
banner at least says "3 new messages". Do this even if N-06 lands on
server-composed and MessagingStyle never happens.

**N-04 · P1 · A missed call produces no notification.**
`onCallStateChanged` (`functions/index.js:523`) writes `callHistory` for both
sides and clears the ring pointer, and sends no push. `reapStaleCalls` (`:614`)
re-enters the same function, so a caller who vanished mid-ring produces no
notification either. On Android CallKeep reports the call to the system call log,
and on iOS CallKit puts it in Recents **[device-verify]** — but there is nothing
in the notification tray, so a user who missed a call while the phone was locked
has no indication on their lock screen that anyone rang. WhatsApp shows a
persistent "Missed voice call" notification that deep-links to the caller.

**Fix:** in `onCallStateChanged`, when `missed` is true and `after === 'ended'`,
push an alert to the callee tagged `call:{peerId}` with a `kind: 'missed_call'`
data payload, and route it in `handleTap` (`NotificationManager.ts:141`) to the
caller's chat rather than `/call` — which is the wrong destination for a call
that is over. Respect the same mute and block checks the message path uses.
Suppress it when `endedReason` is `rejected` or `busy`: the user chose those, and
WhatsApp does not notify you about a call you declined.

**N-05 · P1 · iOS message pushes are not marked time-sensitive and carry no
badge, so they lose to Focus mode and the app icon never shows a count.**
The APNs payload for messages (`functions/index.js:407-419`) sets `thread-id` and
`sound` and nothing else. Two consequences. First, no `interruption-level:
'time-sensitive'`, so with Focus or a Sleep schedule on, message notifications
are held silently — WhatsApp marks conversation notifications time-sensitive
specifically so they break through, which is why WhatsApp wakes you and Flyer
would not. Second, no `aps.badge`, so the iOS app-icon badge never appears. The
in-app badge is fully implemented (`(tabs)/_layout.tsx:54` drives it from
`totalUnread`), so the app knows the number and simply never tells the OS.
`PermissionManager` even requests the badge permission (`:64`) and then nothing
uses it. **[device-verify]** for Focus-mode behaviour.

**Fix:** add `'interruption-level': 'time-sensitive'` to the message and reaction
payloads (calls do not need it — CallKit outranks Focus). For the badge, the
function already computes per-recipient state, so read the recipient's total
unread and set `aps.badge` to it; note this must be the *total across all chats*,
not the per-chat count, or the icon will read wrong. Clear it on read by sending
`badge: 0` — or better, set the badge from the client on foreground, since the
client already has `totalUnread` and does not need a round trip.

### The architectural decision this all depends on

**N-06 · P1 · Decide explicitly: server-composed `notification` pushes, or
data-only pushes with the notification built on-device.**
Right now message pushes carry a `notification` block (`functions/index.js:392`)
and call pushes are data-only (`:193-197`), and each choice is right for its
case and documented as such. The problem is that N-03 (MessagingStyle), the
direct-reply and mark-as-read actions in N-07, per-message avatars, and any
lock-screen privacy control **all require building the notification in JS**,
which means data-only for messages too. That is a real trade, not a free upgrade:

- *Server-composed (today).* The OS draws it even if JS never runs. Survives
  battery killers better, because nothing needs to wake. Cannot do MessagingStyle,
  actions, or avatars.
- *Data-only + on-device compose.* Full control. But it puts a JS wake-up on the
  critical path for **every message**, so N-01's battery killers now cause
  *silently missing* notifications rather than merely un-tuned ones, and on iOS a
  data-only message push is throttled and will not reliably run at all — iOS needs
  a Notification Service Extension to mutate a real alert push instead.

**Recommendation, stated so it can be argued with:** keep server-composed pushes
as the floor that always works, and treat on-device composition as an Android-only
enhancement layered on top — Android gets data-only with a `notification` fallback
in the same message, so if JS is killed the OS still draws something. iOS gets
alert pushes plus a Notification Service Extension when N-08 is done. Do **not**
go data-only-everywhere on the strength of N-03 alone; that trades a cosmetic
problem for a delivery problem, on the exact devices least able to absorb it.
This decision gates N-03, N-07 and N-08 — settle it before writing any of them.

### Interaction quality

**N-07 · P2 · No notification actions: no direct reply, no mark-as-read.**
Nothing in the repo creates notification actions, and it cannot — FCM's
`notification` block has no action support, and there is no `notifee` or
`expo-notifications` dependency (`package.json:20-64`). Replying to a message
therefore always costs a full app open. WhatsApp's inline reply is one of the
most-used affordances in the product, and mark-as-read from the tray is how
people clear a chat they do not need to answer.

**Fix:** blocked on N-06. Once on-device composition exists on Android, add a
`RemoteInput` reply action wired to the existing send path and a mark-as-read
action calling the existing `markChatRead` (`ChatEngine.ts:942`, which already
clears unread without opening the chat — exactly the primitive needed, and its
deliberate choice not to touch `seenBy` is the right semantics here too: clearing
from the tray should not claim you read the messages). Reply from a notification
must go through `OfflineQueue`, not a direct write: the device is very likely on a
bad connection if the user is answering from the tray.

**N-08 · P2 · iOS notifications show no sender photo (no communication
notifications), and Android shows no avatar either.**
On iOS 15+, showing the sender's photo and name in the notification requires
donating an `INSendMessageIntent` and the Communication Notifications
entitlement; neither appears in `app.config.ts` (entitlements are just
`aps-environment`, `:76-78`). On Android an avatar requires a `Person` in
MessagingStyle, which is blocked on N-06. So every notification is anonymous
chrome with a name in text — the most visible cosmetic difference from WhatsApp
on a lock screen. Also worth noting: `photoURL` is already in the push path for
calls (`functions/index.js:266`) and respects `privacy.showPhoto`, so the privacy
model for this is already settled — it just is not sent for messages.

**Fix:** iOS needs the entitlement, an intent donation on send, and a Notification
Service Extension to attach the image (the extension is also what N-05's richer
payloads and any future E2E-decrypt-in-notification work would use, so it is
worth building once). Android is downstream of N-06. Respect
`privacy.showPhoto === false` on both, matching the call path.

**N-09 · P2 · The incoming-call vibration is applied twice on Android.**
`handleIncoming` runs `Vibration.vibrate([0, 500, 1000], true)`
(`CallManager.ts:282-284`) while CallKeep's ConnectionService is already ringing
the call with the system ringtone and its own vibration — `selfManaged: false`
(`CallKeepService.ts:95`) hands ring behaviour to the OS precisely so it matches
a real phone call. The two are independent, so the phone buzzes on two schedules.
Note it only happens on the *pointer* path: a call that arrives via the FCM
background handler goes through `BackgroundTaskManager.handleCallPush` (`:46`),
which does not vibrate — so the same incoming call feels different depending on
whether the app was alive, which is the tell that one of the two is wrong.
**[device-verify]** — whether the OEM ring vibration is actually present varies,
and on a ROM that suppresses it the manual call may be masking the gap.

**Fix:** delete the manual `Vibration.vibrate` and the `Vibration.cancel()` calls
that pair with it (`:310`, `:353`, `:571`), and let the ConnectionService own
ringing. If a ROM turns out not to vibrate, add it back *in one place* behind an
explicit flag, on both paths rather than one.

**N-10 · P3 · No lock-screen privacy control for message previews.**
The push always contains the sender's name and a 120-character preview
(`functions/index.js:329`), and nothing sets Android `visibility` or offers a
"hide preview" setting. Anyone glancing at a locked phone reads the message.
WhatsApp exposes this as a per-account setting. Low severity because the default
matches WhatsApp's default; it is the *absence of the choice* that is the gap.
**Fix:** downstream of N-06 on Android (`VISIBILITY_PRIVATE` plus a redacted
public version). Server-side it is simpler: a `privacy.hidePreview` flag the
function honours by sending a bare "New message" body — worth doing on its own,
since it works with today's architecture and needs no client notification work.

### Ship order

N-01 first and alone — it is worth more than everything below it combined, it
needs no architectural decision, and it is the difference between "notifications
work" and "notifications sometimes work". Then N-02 and N-04 (both small,
server-side, immediately visible). Then settle **N-06**, because N-03, N-07, N-08
and N-10 are all blocked on it and building any of them first commits the
decision by accident. N-05 can land any time; it is two payload keys and the
badge. N-09 whenever the call path is next open.

Prerequisites from elsewhere in this document: all of it needs BUG-41 (Blaze)
resolved, since every push originates in a Cloud Function. N-02 should follow
BUG-08. Fix BUG-38 before measuring anything on iOS, or the results will be
noise. And N-03's server-side mitigation reads `unread`, which BUG-08 is about to
move — sequence them together.

---

## Part 9 — Execution order

Do not attempt this in one pass. Stop after each numbered step.

1. **Verify BUG-01 and BUG-02**, then stand up the emulator and write rules tests
   pinning them. This is H-03's first deliverable and makes everything after it
   safer.
1.5. **Settle BUG-41 (Blaze) before anything below it.** It is not code, it is a
   precondition: steps 2, 3 and 4 all touch `functions/index.js` or depend on a
   deployed function, and none of it can be tested end to end on Spark. Decide,
   write the decision down, then continue.
2. **Remaining P0s** — BUG-03 … BUG-07, plus **BUG-37** (blocking bypasses calls,
   which belongs with BUG-03 — same feature, same rules file, and the fix is one
   clause in two rules). All security or correctness. Ship.
3. **Notification PR** — BUG-20 … BUG-24 together, now with **BUG-38** and
   **BUG-40** (both are `functions/index.js` payload shape — same file, same
   review). Add **N-05** here too: it is two payload keys plus the badge, in the
   same function. Best effort-to-payoff ratio in this document.
3.5. **N-01 (OEM battery killers).** Out of numeric order on purpose. It is worth
   more than everything else in Part 8 combined, it is client-only so it does not
   wait on Blaze, and until it is done any measurement of notification
   reliability on a Xiaomi/Oppo/Vivo handset is measuring the ROM, not the app.
4. **Data-integrity rules PR** — BUG-25 … BUG-29, with a rules test per fix.
5. **H-01, H-02, H-04** (App Check, Crashlytics, CI). Before growing the user
   base — App Check retrofits badly.
6. **Refactor `app/chat/[chatId].tsx`** into components. Before Tier-1 features.
7. **P1 correctness** — BUG-08 … BUG-19, then **N-02** (delivered ticks) and
   **N-04** (missed-call notification) — N-02 must follow BUG-08, which moves the
   unread accounting it would otherwise contend with.
7.5. **Settle N-06** (server-composed vs on-device notifications). N-03, N-07,
   N-08 and N-10 are all blocked on it, and implementing any of them first
   commits the decision by accident. Write the decision down like S-01.
8. **Tier 1 features** — F-01 … F-10, in order.
9. **Decide S-01 explicitly** (RTDB vs Firestore). Write down the decision and the
   reasoning even if the answer is "stay".
10. **Decide F-21 explicitly** (E2E). It gets more expensive with every feature
    added first, because search, notifications, and smart replies all change
    around it. Note it also interacts with Part 8: an E2E payload cannot carry a
    preview, so N-03's body text and N-08's avatars both have to move on-device.
10.5. **BUG-39 (iOS VoIP push)** — its own project, not a patch. Needed before any
    iOS release where calling is advertised; skippable indefinitely on an
    Android-first build, which is what `app.config.ts` currently describes. Pair
    with **N-08**'s Notification Service Extension: both are iOS-native work and
    the extension is reusable.
11. Tier 2 → Part 6 performance work → rest of Part 8 → Tier 3 → Part 7.

### Reporting contract

After each step, report: what changed; the `tsc --noEmit` result; what you tested
and how; what you deliberately did **not** do and why; and any assumption a
reviewer should check. If a fix seemed to require widening a security rule, stop
and explain before proceeding — that is almost always the wrong fix.

### Standing instruction

When you find a bug not listed here, **add it to this file first**, in the same
format (id, severity, `file:line`, user-visible symptom, root cause, fix), then
fix it. This document is meant to accumulate. The reason the P0s in Part 2
survived as long as they did is that nothing was writing them down.
