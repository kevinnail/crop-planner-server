/**
 * Manual end-to-end check for the password-reset flow.
 *
 * Hits a running API server (default http://localhost:7890) and walks through:
 *   sign-up (or accept existing user) -> request reset -> [you paste the token
 *   from the real email Resend delivers] -> reset -> sign-in with new password.
 *
 * Run the API server with real RESEND_API_KEY + EMAIL_FROM in .env, then:
 *   npm run manual:password-reset -- you@example.com
 */

import 'dotenv/config';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout, argv, exit } from 'node:process';

const SERVER_FLAG = '--server';

interface ParsedArgs {
  positional: string[];
  server: string;
}

function parseArgs(args: readonly string[]): ParsedArgs {
  let server = `http://localhost:${process.env.PORT ?? '7890'}`;
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const next = args[i];
    if (next === undefined) continue;
    if (next === SERVER_FLAG) {
      const value = args[i + 1];
      if (value === undefined) throw new Error(`${SERVER_FLAG} requires a URL argument`);
      server = value;
      i++;
    } else {
      positional.push(next);
    }
  }
  return { positional, server };
}

interface JsonResponse {
  status: number;
  body: Record<string, unknown> | null;
}

async function postJson(
  server: string,
  path: string,
  payload: Record<string, unknown>,
): Promise<JsonResponse> {
  const res = await fetch(`${server}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: server,
    },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  let body: Record<string, unknown> | null = null;
  if (text.length > 0) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed !== null && typeof parsed === 'object') {
        body = parsed as Record<string, unknown>;
      }
    } catch {
      // non-JSON response: leave body null and let the caller log status only
    }
  }
  return { status: res.status, body };
}

function bodyCode(body: Record<string, unknown> | null): string {
  return typeof body?.code === 'string' ? body.code : '';
}

async function promptForToken(): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const pasted = (await rl.question('\nPaste the reset URL (or token) from the email: ')).trim();
    const match = /\/reset-password\/([^?\s]+)/.exec(pasted);
    return match?.[1] ?? pasted;
  } finally {
    rl.close();
  }
}

async function run(): Promise<void> {
  const { positional, server } = parseArgs(argv.slice(2));
  const email = positional[0];
  if (email === undefined) {
    console.error(
      'usage: tsx scripts/manual-password-reset.ts <email> [newPassword] [--server <url>]',
    );
    exit(1);
  }
  const newPassword = positional[1] ?? `reset-${Date.now().toString()}`;
  const initialPassword = `initial-${Date.now().toString()}`;

  console.log(`Server: ${server}`);
  console.log(`Email:  ${email}`);

  console.log('\n[1/4] Ensuring user exists (existing user is fine)...');
  const signup = await postJson(server, '/api/auth/sign-up/email', {
    name: 'Manual Test',
    email,
    password: initialPassword,
  });
  if (signup.status === 200) {
    console.log(`  -> created new user (initial password: "${initialPassword}").`);
  } else if (bodyCode(signup.body) === 'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL') {
    console.log('  -> user already exists, continuing.');
  } else {
    console.error('  -> unexpected sign-up response:', signup);
    exit(1);
  }

  console.log('\n[2/4] Requesting password-reset email...');
  const requested = await postJson(server, '/api/auth/request-password-reset', { email });
  if (requested.status !== 200) {
    console.error('  -> request-password-reset failed:', requested);
    exit(1);
  }
  console.log('requested ', requested);

  console.log(`  -> 200. Check ${email} for the reset email.`);

  const token = await promptForToken();
  if (token.length === 0) {
    console.error('No token provided.');
    exit(1);
  }
  console.log(`  -> using token: ${token.slice(0, 8)}…`);

  console.log(`\n[3/4] Resetting password to "${newPassword}"...`);
  const reset = await postJson(server, '/api/auth/reset-password', { token, newPassword });
  if (reset.status !== 200) {
    console.error('  -> reset-password failed:', reset);
    exit(1);
  }
  console.log('  -> 200.');

  console.log('\n[4/4] Verifying sign-in with the new password...');
  const signin = await postJson(server, '/api/auth/sign-in/email', {
    email,
    password: newPassword,
  });
  if (signin.status !== 200) {
    console.error('  -> sign-in failed:', signin);
    exit(1);
  }
  console.log('  -> 200.');

  console.log('\nDONE — request → email → reset → sign-in round trip confirmed.');
}

run().catch((err: unknown) => {
  console.error(err);
  exit(1);
});
