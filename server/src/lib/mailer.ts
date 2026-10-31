import nodemailer, { type Transporter } from 'nodemailer';
import { env } from '../config/env.js';

let transporter: Transporter | null = null;

function getTransporter(): Transporter | null {
  if (!env.SMTP_URL) return null;
  if (!transporter) transporter = nodemailer.createTransport(env.SMTP_URL);
  return transporter;
}

export interface MailInput {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

/**
 * Sends transactional mail. With no SMTP_URL configured (development), the message is
 * written to the log instead of being dropped silently, so reset links stay reachable.
 */
export async function sendMail(input: MailInput): Promise<{ delivered: boolean }> {
  const transport = getTransporter();

  if (!transport) {
    console.info(
      [
        '',
        '──────────── outbound mail (no SMTP_URL configured) ────────────',
        `To:      ${input.to}`,
        `Subject: ${input.subject}`,
        '',
        input.text,
        '────────────────────────────────────────────────────────────────',
        '',
      ].join('\n'),
    );
    return { delivered: false };
  }

  try {
    await transport.sendMail({
      from: env.MAIL_FROM,
      to: input.to,
      subject: input.subject,
      text: input.text,
      html: input.html,
    });
    return { delivered: true };
  } catch (error) {
    // Never fail a user-facing flow because mail delivery hiccuped.
    console.error('[mail] delivery failed', (error as Error).message);
    return { delivered: false };
  }
}

const shell = (title: string, body: string, footer: string) => `
<div style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;background:#0d1117;padding:32px">
  <div style="max-width:520px;margin:0 auto;background:#161b22;border:1px solid #262d38;border-radius:16px;padding:32px;color:#e6edf3">
    <div style="font-size:20px;font-weight:700;letter-spacing:-0.02em;color:#7fd6c2">${env.BRAND_NAME}</div>
    <h1 style="font-size:20px;margin:20px 0 12px">${title}</h1>
    ${body}
    <p style="color:#8b949e;font-size:13px;margin-top:28px;border-top:1px solid #262d38;padding-top:16px">${footer}</p>
  </div>
</div>`;

const button = (href: string, label: string) =>
  `<p style="margin:24px 0"><a href="${href}" style="background:#2ea88a;color:#04120e;padding:12px 20px;border-radius:10px;text-decoration:none;font-weight:600;display:inline-block">${label}</a></p>
   <p style="color:#8b949e;font-size:13px;word-break:break-all">Or paste this link into your browser:<br>${href}</p>`;

export const templates = {
  passwordReset(link: string, expiresMinutes: number): MailInput {
    return {
      to: '',
      subject: `Reset your ${env.BRAND_NAME} password`,
      text: `Reset your ${env.BRAND_NAME} password using this link (valid for ${expiresMinutes} minutes):\n\n${link}\n\nIf you did not request this, you can ignore this email — your password will not change.`,
      html: shell(
        'Reset your password',
        `<p style="color:#c9d1d9;line-height:1.6">Use the button below to choose a new password. The link is valid for ${expiresMinutes} minutes and can be used once.</p>${button(link, 'Choose a new password')}`,
        'If you did not request this, you can ignore this email — your password will not change.',
      ),
    };
  },
  verifyEmail(link: string): MailInput {
    return {
      to: '',
      subject: `Confirm your ${env.BRAND_NAME} recovery address`,
      text: `Confirm this address as your ${env.BRAND_NAME} recovery email:\n\n${link}\n\nThis address is never shown to other people. It is only used to help you back into your account.`,
      html: shell(
        'Confirm your recovery address',
        `<p style="color:#c9d1d9;line-height:1.6">Confirming this address lets you recover your account if you forget your password. It is never shown to other people on ${env.BRAND_NAME}.</p>${button(link, 'Confirm address')}`,
        'If you did not add this address, you can ignore this email.',
      ),
    };
  },
  securityAlert(headline: string, detail: string): MailInput {
    return {
      to: '',
      subject: `${env.BRAND_NAME} security alert: ${headline}`,
      text: `${headline}\n\n${detail}\n\nIf this was not you, change your password and sign out of all devices from Settings → Security.`,
      html: shell(
        headline,
        `<p style="color:#c9d1d9;line-height:1.6">${detail}</p>`,
        'If this was not you, change your password and sign out of all devices from Settings → Security.',
      ),
    };
  },
};
