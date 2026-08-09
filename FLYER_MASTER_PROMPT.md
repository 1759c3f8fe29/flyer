# Flyer — Master Implementation Prompt

Paste this into a fresh agent session at the repo root. It is written to be
executed, not just read. **Every bug below was confirmed by reading the actual
source or the rules file — none are speculative.** File:line references are given
so you can verify each one yourself before you touch it.

Contents:

- Part 0 — Rules of engagement
- Part 1 — Ground truth: what already exists (do not rebuild)
- Part 2 — Confirmed bugs (29), in fix order
- Part 3 — WhatsApp feature parity (30 features), in ship order
- Part 4 — What to remove or replace
- Part 5 — Production hardening (verified absent)
- Part 6 — Performance and scale
- Part 7 — Beyond parity: reasons to switch to Flyer
- Part 8 — Execution order and reporting contract

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

Added under the Part 8 standing instruction. Each was discovered while fixing
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

## Part 8 — Execution order

Do not attempt this in one pass. Stop after each numbered step.

1. **Verify BUG-01 and BUG-02**, then stand up the emulator and write rules tests
   pinning them. This is H-03's first deliverable and makes everything after it
   safer.
2. **Remaining P0s** — BUG-03 … BUG-07. All security or correctness. Ship.
3. **Notification PR** — BUG-20 … BUG-24 together. Best effort-to-payoff ratio in
   this document.
4. **Data-integrity rules PR** — BUG-25 … BUG-29, with a rules test per fix.
5. **H-01, H-02, H-04** (App Check, Crashlytics, CI). Before growing the user
   base — App Check retrofits badly.
6. **Refactor `app/chat/[chatId].tsx`** into components. Before Tier-1 features.
7. **P1 correctness** — BUG-08 … BUG-19.
8. **Tier 1 features** — F-01 … F-10, in order.
9. **Decide S-01 explicitly** (RTDB vs Firestore). Write down the decision and the
   reasoning even if the answer is "stay".
10. **Decide F-21 explicitly** (E2E). It gets more expensive with every feature
    added first, because search, notifications, and smart replies all change
    around it.
11. Tier 2 → Part 6 performance work → Tier 3 → Part 7.

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
