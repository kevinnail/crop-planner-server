import { Router } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { inArray } from 'drizzle-orm';
import { db } from '../db/connection';
import { subscriptions, user } from '../db/schema';
import { asyncHandler } from '../lib/asyncHandler';

const expectedAuth = process.env.REVENUECAT_WEBHOOK_AUTH_HEADER;
if (!expectedAuth) throw new Error('REVENUECAT_WEBHOOK_AUTH_HEADER is not set');
const expectedAuthBytes = Buffer.from(expectedAuth);

// Constant-time comparison of the shared webhook secret so the header can't be
// recovered by timing a plain `!==`. The length check leaks only the secret's
// length (standard and acceptable); timingSafeEqual requires equal-length bufs.
function isValidWebhookAuth(header: string | undefined): boolean {
  if (typeof header !== 'string') return false;
  const headerBytes = Buffer.from(header);
  if (headerBytes.length !== expectedAuthBytes.length) return false;
  return timingSafeEqual(headerBytes, expectedAuthBytes);
}

const ACTIVATING = new Set(['INITIAL_PURCHASE', 'RENEWAL', 'UNCANCELLATION', 'PRODUCT_CHANGE']);
const DEACTIVATING = new Set(['EXPIRATION', 'CANCELLATION']);

interface RevenueCatEvent {
  type?: string;
  app_user_id?: string;
  aliases?: string[];
  product_id?: string;
  expiration_at_ms?: number;
}

interface RevenueCatBody {
  event?: RevenueCatEvent;
}

const router = Router();

router.post(
  '/revenuecat',
  asyncHandler(async (req, res) => {
    if (!isValidWebhookAuth(req.headers.authorization)) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }

    const event = (req.body as RevenueCatBody | undefined)?.event;
    if (!event?.type) {
      res.status(400).json({ error: 'malformed event' });
      return;
    }

    // TRANSFER events are ignored by design. Our RevenueCat project uses the
    // "Keep with original App User ID" transfer behavior, so a subscription is
    // permanently bound to the first account that bought it and never moves
    // between accounts (one Apple ID = one better-auth account). RevenueCat may
    // still emit a TRANSFER when the app-launch anonymous id is merged into the
    // real user.id at login; that merge carries no subscription and needs no
    // action — we just acknowledge it so it doesn't fall through to the 400.
    if (event.type === 'TRANSFER') {
      res.status(200).json({ ignored: event.type });
      return;
    }

    if (!event.app_user_id) {
      res.status(400).json({ error: 'malformed event' });
      return;
    }

    let status: 'active' | 'expired' | null = null;
    if (ACTIVATING.has(event.type)) status = 'active';
    else if (DEACTIVATING.has(event.type)) status = 'expired';

    if (status === null) {
      res.status(200).json({ ignored: event.type });
      return;
    }

    // RevenueCat sets `app_user_id` to the customer's *last-seen* alias, which
    // can be an app-launch anonymous id ($RCAnonymousID:...) even when the
    // purchase belongs to a signed-in account — renewals fired while the app
    // was signed out arrive that way. The event's `aliases` array carries every
    // id the customer has been known by, including the better-auth user.id set
    // at login, so resolve against all of them (app_user_id first for
    // determinism). Events that resolve to no account are acknowledged and
    // skipped: a row without a user id can never satisfy checkSubscription and
    // would only shadow the real row while it goes stale.
    const candidateIds = [event.app_user_id, ...(event.aliases ?? [])].filter(
      (candidate): candidate is string => typeof candidate === 'string' && candidate.length > 0,
    );
    const matchedUsers = await db
      .select({ id: user.id })
      .from(user)
      .where(inArray(user.id, candidateIds));
    const matchedIds = new Set(matchedUsers.map((matched) => matched.id));
    const userId = candidateIds.find((candidate) => matchedIds.has(candidate));

    if (!userId) {
      res.status(200).json({ ignored: 'no matching user' });
      return;
    }

    const productId = event.product_id ?? null;
    const expiresAt =
      typeof event.expiration_at_ms === 'number' ? new Date(event.expiration_at_ms) : null;

    // Key the row on the resolved user id, not the raw event alias, so every
    // event for this customer lands on the same canonical row.
    await db
      .insert(subscriptions)
      .values({
        rcUserId: userId,
        userId,
        status,
        productId,
        expiresAt,
      })
      .onConflictDoUpdate({
        target: subscriptions.rcUserId,
        set: {
          status,
          productId,
          expiresAt,
          userId,
          updatedAt: new Date(),
        },
      });

    res.status(200).json({ ok: true });
  }),
);

export default router;
