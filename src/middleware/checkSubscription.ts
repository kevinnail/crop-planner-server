import type { RequestHandler } from 'express';
import { and, eq, gt } from 'drizzle-orm';
import { db } from '../db/connection';
import { subscriptions } from '../db/schema';
import { asyncHandler } from '../lib/asyncHandler';

export const checkSubscription: RequestHandler = asyncHandler(async (req, res, next) => {
  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const rows = await db
    .select({ id: subscriptions.id })
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.userId, userId),
        eq(subscriptions.status, 'active'),
        gt(subscriptions.expiresAt, new Date()),
      ),
    )
    .limit(1);

  if (rows.length === 0) {
    res.status(403).json({ error: 'Subscription required' });
    return;
  }

  next();
});
