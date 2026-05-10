import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { sendMock } = vi.hoisted(() => ({ sendMock: vi.fn() }));

vi.mock('resend', () => ({
  Resend: vi.fn(() => ({
    emails: { send: sendMock },
  })),
}));

import { sendEmail } from '../../src/lib/email';

const ORIGINAL_FROM = process.env.EMAIL_FROM;

beforeEach(() => {
  sendMock.mockReset();
  process.env.EMAIL_FROM = 'noreply@example.com';
});

afterEach(() => {
  if (ORIGINAL_FROM === undefined) delete process.env.EMAIL_FROM;
  else process.env.EMAIL_FROM = ORIGINAL_FROM;
});

describe('sendEmail', () => {
  it('forwards from/to/subject/text to the Resend client exactly once', async () => {
    sendMock.mockResolvedValue({ data: { id: 'msg_123' }, error: null });

    await sendEmail({
      to: 'user@example.com',
      subject: 'Reset your password',
      text: 'Reset link: https://example.com/reset?token=abc',
    });

    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock).toHaveBeenCalledWith({
      from: 'noreply@example.com',
      to: 'user@example.com',
      subject: 'Reset your password',
      text: 'Reset link: https://example.com/reset?token=abc',
    });
  });

  it('throws when EMAIL_FROM is not set and does not call Resend', async () => {
    delete process.env.EMAIL_FROM;

    await expect(
      sendEmail({ to: 'user@example.com', subject: 's', text: 't' }),
    ).rejects.toThrow('EMAIL_FROM is not set');

    expect(sendMock).not.toHaveBeenCalled();
  });

  it('propagates the Resend error rather than swallowing it', async () => {
    sendMock.mockResolvedValue({
      data: null,
      error: { name: 'validation_error', message: 'Invalid `to` field' },
    });

    await expect(
      sendEmail({ to: 'bogus', subject: 's', text: 't' }),
    ).rejects.toThrow('Resend error: validation_error: Invalid `to` field');
  });
});
