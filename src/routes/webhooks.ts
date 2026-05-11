import { Router } from 'express';
import { eq } from 'drizzle-orm';
import { db } from '../db/connection';
import { subscriptions, user } from '../db/schema';
import { asyncHandler } from '../lib/asyncHandler';

const expectedAuth = process.env.REVENUECAT_WEBHOOK_AUTH_HEADER;
if (!expectedAuth) throw new Error('REVENUECAT_WEBHOOK_AUTH_HEADER is not set');

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
    if (req.headers.authorization !== expectedAuth) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }

    const event = (req.body as RevenueCatBody | undefined)?.event;
    if (!event?.type || !event.app_user_id) {
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
