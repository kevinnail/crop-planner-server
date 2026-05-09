import 'dotenv/config';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate as applySchema } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is not set');

  const client = postgres(databaseUrl, { max: 1 });
  const db = drizzle(client);
  await applySchema(db, { migrationsFolder: './drizzle' });
  await client.end();
  console.log('Schema applied to database successfully');
}

main().catch(console.error);
