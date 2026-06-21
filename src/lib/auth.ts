import { betterAuth } from 'better-auth';
import { expo } from '@better-auth/expo';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { db } from '../db/connection';
import * as schema from '../db/schema';
import { sendEmail } from './email';

const baseURL = process.env.BETTER_AUTH_URL;
if (!baseURL) throw new Error('BETTER_AUTH_URL is not set');

const secret = process.env.BETTER_AUTH_SECRET;
if (!secret) throw new Error('BETTER_AUTH_SECRET is not set');

const passwordResetRedirectURL =
  process.env.PASSWORD_RESET_REDIRECT_URL ?? 'cropplanner://reset-password';

export const auth = betterAuth({
  baseURL,
  secret,
  trustedOrigins: ['cropplanner://'],
  database: drizzleAdapter(db, {
    provider: 'pg',
    schema,
  }),
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: false,
    sendResetPassword: async ({ user, url }) => {
      const resetUrl = new URL(url);
      resetUrl.searchParams.set('callbackURL', passwordResetRedirectURL);
      await sendEmail({
        to: user.email,
        subject: 'Reset your Crop Planner password',
        text: `Reset link: ${resetUrl.toString()}`,
      });
    },
  },
  plugins: [expo()],
});
