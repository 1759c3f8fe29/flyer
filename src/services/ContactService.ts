import {
  Paths,
  fanOut,
  isPermissionDenied,
  onValue,
  readOnce,
  ref,
  remove,
  serverTimestamp,
  type Unsubscribe,
} from './FirebaseService';
import { appState } from './StateManager';
import type { Contact, ContactRequest } from '../config/types';

/**
 * ContactService — the contact list and the request handshake that gates it.
 *
 * Shape, and why it is duplicated three ways:
 *
 *   contacts/{uid}/{contactUid}        mutual, written only on accept
 *   contactRequests/{toUid}/{fromUid}  the recipient's inbox
 *   sentRequests/{fromUid}/{toUid}     the sender's outbox
 *
 * RTDB has no server-side joins and no query across a sibling's subtree, so a
 * pending request has to be readable by both parties without either being able
 * to read the other's whole inbox. Two mirrored nodes is the standard answer.
 * Every transition below writes all affected paths in ONE `fanOut`, so a
 * request can never be simultaneously pending and accepted.
 */

// --- reads ----------------------------------------------------------------

// Looking someone up by email or handle lives in DirectoryService now: the
// `users` rules no longer grant read on the parent node, so the query it needed
// cannot run from a client. See the comment there.

export function listenToContacts(uid: string): Unsubscribe {
  return onValue(ref(Paths.contacts(uid)), (snap) => {
    const raw = (snap.val() as Record<string, Contact> | null) ?? {};
    const list = Object.entries(raw)
      .map(([contactUid, value]) => ({
        uid: contactUid,
        addedAt: Number(value?.addedAt ?? 0),
      }))
      .sort((a, b) => b.addedAt - a.addedAt);

    appState.get().setContacts(list);
  });
}

/**
 * Both directions in one subscription. The inbox drives the badge; the outbox
 * is what turns an "Add" button into "Requested" without a round trip.
 */
export function listenToRequests(uid: string): Unsubscribe {
  const incoming = new Map<string, ContactRequest>();
  const outgoing = new Map<string, ContactRequest>();

  const emit = () => {
    const all = [...incoming.values(), ...outgoing.values()].sort(
      (a, b) => b.createdAt - a.createdAt
    );
    appState.get().setRequests(all);
  };

  const readInto = (
    map: Map<string, ContactRequest>,
    direction: ContactRequest['direction']
  ) => (snap: { val: () => unknown }) => {
    const raw = (snap.val() as Record<string, { createdAt?: number }> | null) ?? {};
    map.clear();
    for (const [otherUid, value] of Object.entries(raw)) {
      map.set(otherUid, {
        uid: otherUid,
        createdAt: Number(value?.createdAt ?? 0),
        direction,
      });
    }
    emit();
  };

  const offIn = onValue(ref(Paths.requests(uid)), readInto(incoming, 'incoming'));
  const offOut = onValue(ref(Paths.sentRequests(uid)), readInto(outgoing, 'outgoing'));

  return () => {
    offIn();
    offOut();
  };
}

export async function isContact(myUid: string, otherUid: string): Promise<boolean> {
  return (await readOnce(Paths.contact(myUid, otherUid))) !== null;
}

// --- transitions ----------------------------------------------------------

export class ContactError extends Error {}

/**
 * Send a request, or auto-accept if they already requested you.
 *
 * The auto-accept branch matters: without it, two people who add each other at
 * the same time end up with two pending requests and neither is a contact.
 */
export async function sendRequest(myUid: string, toUid: string): Promise<'sent' | 'accepted'> {
  if (myUid === toUid) throw new ContactError('You cannot add yourself.');

  /**
   * Only paths this client is allowed to read are pre-checked.
   *
   * `blocks/{them}/{me}` used to be read here too, and it made every single
   * request fail. The rules scope `blocks/$uid` to `.read: auth.uid === $uid`,
   * so reading the *other* person's block list is denied — `readOnce` rejects,
   * `Promise.all` rejects with it, and the caller reports "Could not send
   * request" no matter who was being added or whether anyone had blocked anyone.
   *
   * The check was redundant as well as impossible: the write rule on
   * contactRequests/$uid/$fromUid already refuses the create when either
   * direction of `blocks` exists. So the server enforces it, and the failed
   * write below is mapped to the same deliberately vague message — telling the
   * sender they have been blocked is exactly what blocking withholds.
   */
  const [alreadyContact, theirPending, blockedByMe] = await Promise.all([
    isContact(myUid, toUid),
    readOnce(Paths.request(myUid, toUid)),
    readOnce(Paths.block(myUid, toUid)),
  ]);

  if (alreadyContact) throw new ContactError('They are already in your contacts.');
  if (blockedByMe) throw new ContactError('Unblock them before sending a request.');

  if (theirPending) {
    await acceptRequest(myUid, toUid);
    return 'accepted';
  }

  try {
    await fanOut({
      [Paths.request(toUid, myUid)]: { uid: myUid, createdAt: serverTimestamp() },
      [Paths.sentRequest(myUid, toUid)]: { uid: toUid, createdAt: serverTimestamp() },
    });
  } catch (e) {
    // A rules rejection here means they blocked you, or a request already
    // exists. Neither is worth distinguishing to the sender.
    if (isPermissionDenied(e)) throw new ContactError('Could not send the request.');
    throw e;
  }
  return 'sent';
}

/**
 * Accept: clear both halves of the request and write both halves of the
 * contact. The rules allow the accepter to write the requester's contacts entry
 * only while the request still exists — and since RTDB evaluates rules against
 * the pre-write state, deleting it in the same fan-out is safe.
 */
export async function acceptRequest(myUid: string, fromUid: string): Promise<void> {
  await fanOut({
    [Paths.request(myUid, fromUid)]: null,
    [Paths.sentRequest(fromUid, myUid)]: null,
    [Paths.contact(myUid, fromUid)]: { uid: fromUid, addedAt: serverTimestamp() },
    [Paths.contact(fromUid, myUid)]: { uid: myUid, addedAt: serverTimestamp() },
  });
}

export async function declineRequest(myUid: string, fromUid: string): Promise<void> {
  await fanOut({
    [Paths.request(myUid, fromUid)]: null,
    [Paths.sentRequest(fromUid, myUid)]: null,
  });
}

export async function cancelRequest(myUid: string, toUid: string): Promise<void> {
  await fanOut({
    [Paths.request(toUid, myUid)]: null,
    [Paths.sentRequest(myUid, toUid)]: null,
  });
}

/**
 * Remove is one-sided by design: the rules let you delete your own entry but
 * not theirs. Removing someone therefore stops them appearing in your list
 * while you stay in theirs — the same as WhatsApp deleting a phone contact.
 * The chat and its history are untouched.
 */
export async function removeContact(myUid: string, contactUid: string): Promise<void> {
  await remove(Paths.contact(myUid, contactUid));
}

/** Blocking implies withdrawing consent, so any pending request goes with it. */
export async function clearRequestsWith(myUid: string, otherUid: string): Promise<void> {
  await fanOut({
    [Paths.request(myUid, otherUid)]: null,
    [Paths.request(otherUid, myUid)]: null,
    [Paths.sentRequest(myUid, otherUid)]: null,
    [Paths.sentRequest(otherUid, myUid)]: null,
  });
}

/** Used by the "add by email" flow to show the right button state. */
export type RelationshipState =
  | 'self'
  | 'contact'
  | 'incoming'
  | 'outgoing'
  | 'blocked'
  | 'none';

export function relationshipWith(myUid: string, otherUid: string): RelationshipState {
  const s = appState.get();
  if (myUid === otherUid) return 'self';
  if (s.blocked[otherUid]) return 'blocked';
  if (s.contacts.some((c) => c.uid === otherUid)) return 'contact';
  const req = s.requests.find((r) => r.uid === otherUid);
  if (req) return req.direction;
  return 'none';
}
