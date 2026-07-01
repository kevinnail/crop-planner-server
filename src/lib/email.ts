import { Resend } from 'resend';

const apiKey = process.env.RESEND_API_KEY ?? '';
export const resend = new Resend(apiKey);

interface SendEmailParams {
  to: string;
  subject: string;
  text: string;
}

export async function sendEmail({ to, subject, text }: SendEmailParams): Promise<void> {
  const from = process.env.EMAIL_FROM;
  if (!from) throw new Error('EMAIL_FROM is not set');

  const { error } = await resend.emails.send({ from: `Crop Planner <${from}>`, to, subject, text });
  if (error) throw new Error(`Resend error: ${error.name}: ${error.message}`);
}
