import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { db } from '../db/connection';
import * as schema from '../db/schema';
import { sendEmail } from './email';

const baseURL = process.env.BETTER_AUTH_URL;
if (!baseURL) throw new Error('BETTER_AUTH_URL is not set');

const secret = process.env.BETTER_AUTH_SECRET;
if (!secret) throw new Error('BETTER_AUTH_SECRET is not set');

export const auth = betterAuth({
  baseURL,
  secret,
  database: drizzleAdapter(db, {
    provider: 'pg',
    schema,
  }),
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: false,
    sendResetPassword: async ({ user, url }) => {
      await sendEmail({
        to: user.email,
        subject: 'Reset your Crop Planner password',
        text: `Reset link: ${url}`,
      });
    },
  },
});
