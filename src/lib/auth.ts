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
  trustedOrigins: ['cropplanner://', ...(process.env.NODE_ENV !== 'production' ? ['exp://*'] : [])],

  // Railway's edge (Envoy) sets x-envoy-external-address to the real external
  // client IP as a single, connection-derived value. Unlike the x-forwarded-for
  // chain — whose left-most entry a client can inject — this can't be spoofed via
  // a request header, so per-IP rate limits below actually track the caller.
  advanced: {
    ipAddress: {
      ipAddressHeaders: ['x-envoy-external-address'],
    },
  },

  // Rate limiting is on in production only (better-auth's default), so the test
  // suite's rapid sign-up/sign-in loops aren't throttled. The blanket default is
  // window: 10s / max: 100; these rules tighten the abuse-prone auth endpoints:
  // credential brute-force on sign-in, mass account creation, and password-reset
  // email bombing (each reset request sends a real Resend email).
  rateLimit: {
    enabled: process.env.NODE_ENV === 'production',
    storage: 'memory',
    customRules: {
      '/sign-in/email': { window: 60, max: 5 },
      '/sign-up/email': { window: 3600, max: 10 },
      '/request-password-reset': { window: 3600, max: 5 },
      '/reset-password': { window: 3600, max: 10 },
    },
  },

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
