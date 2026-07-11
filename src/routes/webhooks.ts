import { Router } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
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

// RevenueCat aliases anonymous identities with this prefix. When a TRANSFER
// lands, the real (logged-in) identity is the app_user_id we set = user.id.
const ANONYMOUS_ID_PREFIX = '$RCAnonymousID:';

interface RevenueCatEvent {
  type?: string;
  app_user_id?: string;
  product_id?: string;
  expiration_at_ms?: number;
  // TRANSFER events carry alias groups instead of a single app_user_id.
  transferred_from?: string[];
  transferred_to?: string[];
}

interface RevenueCatBody {
  event?: RevenueCatEvent;
}

// Chooses which of the destination identities owns the subscription after a
// transfer: prefer one that matches a real user row, then any non-anonymous id.
function pickDestinationRcUserId(
  destinationIds: string[],
  knownUserIds: Set<string>,
): string | null {
  const matchedUser = destinationIds.find((identity) => knownUserIds.has(identity));
  if (matchedUser) return matchedUser;
  const nonAnonymous = destinationIds.find((identity) => !identity.startsWith(ANONYMOUS_ID_PREFIX));
  return nonAnonymous ?? destinationIds[0] ?? null;
}

// Moves a tracked subscription from its old identity to the new one. The
// TRANSFER payload has no product/expiry, so those are carried from the row we
// already store under a source identity. If we track nothing for the source,
// there is no subscription to move and this is a no-op.
async function applyTransfer(event: RevenueCatEvent): Promise<void> {
  const sourceIds = event.transferred_from ?? [];
  const destinationIds = event.transferred_to ?? [];
  if (destinationIds.length === 0 || sourceIds.length === 0) return;

  const sourceRows = await db
    .select()
    .from(subscriptions)
    .where(inArray(subscriptions.rcUserId, sourceIds));
  const carried = sourceRows.find((row) => row.status === 'active') ?? sourceRows[0];
  if (!carried) return;

  const matchedUsers = await db
    .select({ id: user.id })
    .from(user)
    .where(inArray(user.id, destinationIds));
  const knownUserIds = new Set(matchedUsers.map((row) => row.id));

  const destinationRcUserId = pickDestinationRcUserId(destinationIds, knownUserIds);
  if (!destinationRcUserId) return;
  const destinationUserId = knownUserIds.has(destinationRcUserId) ? destinationRcUserId : null;

  await db.transaction(async (transaction) => {
    await transaction
      .update(subscriptions)
      .set({ status: 'expired', updatedAt: new Date() })
      .where(inArray(subscriptions.rcUserId, sourceIds));

    await transaction
      .insert(subscriptions)
      .values({
        rcUserId: destinationRcUserId,
        userId: destinationUserId,
        status: carried.status,
        productId: carried.productId,
        expiresAt: carried.expiresAt,
      })
      .onConflictDoUpdate({
        target: subscriptions.rcUserId,
        set: {
          status: carried.status,
          productId: carried.productId,
          expiresAt: carried.expiresAt,
          ...(destinationUserId ? { userId: destinationUserId } : {}),
          updatedAt: new Date(),
        },
      });
  });
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

    if (event.type === 'TRANSFER') {
      await applyTransfer(event);
      res.status(200).json({ ok: true });
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
