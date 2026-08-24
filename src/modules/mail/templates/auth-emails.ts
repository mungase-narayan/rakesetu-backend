/**
 * The two transactional emails this project sends.
 *
 * Plain text is composed first and the HTML wraps it, rather than the reverse:
 * every client renders the text part, and the link has to be usable when the
 * HTML is stripped. Both templates put the **URL in the body as text** as well
 * as behind the button, because a security-sensitive link a person cannot read
 * before clicking is a link they are right to distrust.
 *
 * No external assets — no tracking pixel, no remote logo. A password-reset mail
 * that phones home is a password-reset mail that leaks when it was opened.
 */
import type { MailMessage } from "../services/mail.service";

const BRAND = "RakeSetu";

/** Inline styles only: every mail client strips <style> blocks. */
const layout = (heading: string, body: string, url: string, cta: string) => `
<div style="margin:0;padding:24px;background:#f5f6f8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <div style="max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #e4e6eb;border-radius:12px;overflow:hidden;">
    <div style="padding:20px 24px;border-bottom:1px solid #eef0f3;">
      <span style="font-size:16px;font-weight:700;color:#0b3d68;">${BRAND}</span>
      <span style="font-size:13px;color:#6b7280;"> · Freight Operations</span>
    </div>
    <div style="padding:24px;">
      <h1 style="margin:0 0 12px;font-size:19px;line-height:1.35;color:#111827;">${heading}</h1>
      <div style="font-size:14px;line-height:1.6;color:#374151;">${body}</div>
      <a href="${url}" style="display:inline-block;margin:20px 0 12px;padding:11px 20px;background:#0b5cad;color:#ffffff;text-decoration:none;border-radius:8px;font-size:14px;font-weight:600;">${cta}</a>
      <p style="margin:8px 0 0;font-size:12px;line-height:1.6;color:#6b7280;">
        If the button does not work, paste this into your browser:<br>
        <span style="word-break:break-all;color:#0b5cad;">${url}</span>
      </p>
    </div>
    <div style="padding:14px 24px;background:#fafbfc;border-top:1px solid #eef0f3;font-size:12px;color:#9ca3af;">
      This is an automated message — replies are not monitored.
    </div>
  </div>
</div>`;

const hours = (n: number) =>
  n % 24 === 0
    ? `${n / 24} day${n / 24 === 1 ? "" : "s"}`
    : `${n} hour${n === 1 ? "" : "s"}`;

export const invitationEmail = (input: {
  to: string;
  firstName: string;
  organizationName: string;
  invitedBy?: string | null;
  url: string;
  ttlHours: number;
}): MailMessage => {
  const by = input.invitedBy ? ` by ${input.invitedBy}` : "";
  const validFor = hours(input.ttlHours);

  return {
    to: input.to,
    subject: `You have been invited to ${BRAND}`,
    text:
      `Hello ${input.firstName},\n\n` +
      `You have been invited${by} to join ${input.organizationName} on ${BRAND}.\n\n` +
      `Set your password to activate your account:\n${input.url}\n\n` +
      `This link is valid for ${validFor} and can be used once.\n` +
      `If you were not expecting this invitation you can ignore it — the account stays inactive until the link is used.\n`,
    html: layout(
      `Hello ${input.firstName}, you have been invited to ${BRAND}`,
      `You have been invited${by} to join <strong>${input.organizationName}</strong>.
       Set a password to activate your account.
       <br><br>This link is valid for <strong>${validFor}</strong> and can be used once.
       If you were not expecting it you can ignore this message — the account stays
       inactive until the link is used.`,
      input.url,
      "Set my password",
    ),
  };
};

export const passwordResetEmail = (input: {
  to: string;
  firstName: string;
  url: string;
  ttlHours: number;
}): MailMessage => {
  const validFor = hours(input.ttlHours);

  return {
    to: input.to,
    subject: `Reset your ${BRAND} password`,
    text:
      `Hello ${input.firstName},\n\n` +
      `Somebody asked to reset the password for this ${BRAND} account.\n\n` +
      `Choose a new password:\n${input.url}\n\n` +
      `This link is valid for ${validFor} and can be used once.\n` +
      `If this was not you, ignore this email — your password has not changed, ` +
      `and the link expires on its own.\n`,
    html: layout(
      "Reset your password",
      `Hello ${input.firstName}, somebody asked to reset the password for this account.
       <br><br>This link is valid for <strong>${validFor}</strong> and can be used once.
       If this was not you, ignore this email — your password has not changed and the
       link expires on its own.`,
      input.url,
      "Choose a new password",
    ),
  };
};
