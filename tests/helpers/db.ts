import { db } from '../../src/db/connection';
import { user, session, account, verification, subscriptions } from '../../src/db/schema';

/**
 * Truncates every app table between tests. Order matters: child tables
 * (FK references) before parent tables. Kept here so any integration test
 * gets a clean DB without each file repeating the list.
 */
export async function resetDb(): Promise<void> {
  await db.delete(session);
  await db.delete(account);
  await db.delete(verification);
  await db.delete(subscriptions);
  await db.delete(user);
}
