import { Router } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { eq } from 'drizzle-orm';
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

    const matchedUser = await db
      .select({ id: user.id })
      .from(user)
      .where(eq(user.id, event.app_user_id));
    const userId = matchedUser[0]?.id ?? null;

    const productId = event.product_id ?? null;
    const expiresAt =
      typeof event.expiration_at_ms === 'number' ? new Date(event.expiration_at_ms) : null;

    await db
      .insert(subscriptions)
      .values({
        rcUserId: event.app_user_id,
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
          // Only overwrite userId if we successfully resolved one this time —
          // preserves any link established by a prior webhook.
          ...(userId ? { userId } : {}),
          updatedAt: new Date(),
        },
      });

    res.status(200).json({ ok: true });
  }),
);

export default router;
