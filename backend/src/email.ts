import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';

let transporter: Transporter | null = null;

export function initializeMailer(): void {
  const host = process.env.SMTP_HOST;
  const port = parseInt(process.env.SMTP_PORT || '587');
  const secure = process.env.SMTP_SECURE === 'true';
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const ciphers = process.env.SMTP_TLS_CIPHERS || 'DEFAULT@SECLEVEL=2';

  if (!host || !user) {
    console.warn('⚠ SMTP not configured — emails will be logged to console instead of sent.');
    return;
  }

  transporter = nodemailer.createTransport({
    host,
    port,
    secure,
    auth: { user, pass },
    pool: true,
    maxConnections: 1,
    tls: {
        ciphers
    }
  });
}

interface InvitationEmailParams {
  to: string;
  studentName: string;
  date: string;
  token: string;
  clubName: string;
  subject: string;
}

export async function sendInvitationEmail({ to, studentName, date, token, clubName, subject }: InvitationEmailParams): Promise<void> {
  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
  const invitationUrl = `${frontendUrl}/invitation/${token}`;

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <h2>Hi ${escapeHtml(studentName)},</h2>
      <p>You have been invited to a coaching session at <strong>${escapeHtml(clubName)}</strong> on <strong>${escapeHtml(date)}</strong>.</p>
      <p>Please click the link below to confirm or decline your attendance:</p>
      <p style="margin: 24px 0;">
        <a href="${escapeHtml(invitationUrl)}"
           style="background-color: #2563eb; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold;">
          Respond to Invitation
        </a>
      </p>
      <p style="color: #666; font-size: 14px;">
        Or copy this link: ${escapeHtml(invitationUrl)}
      </p>
      <p>Best regards,<br/>${escapeHtml(clubName)}</p>
    </div>
  `;

  const text = `Hi ${studentName},\n\nYou have been invited to a coaching session at ${clubName} on ${date}.\n\nPlease visit the following link to respond:\n${invitationUrl}\n\nBest regards,\n${clubName}`;

  if (!transporter) {
    console.log(`📧 [Email Preview] To: ${to} | Subject: ${subject}`);
    console.log(`   Link: ${invitationUrl}`);
    return;
  }

  await transporter.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to,
    subject,
    text,
    html,
  }, (error, info) => {
      if (error) {
          return console.log(error);
      }
      console.log('Message %s sent: %s', info.messageId, info.response);
  });
}

function escapeHtml(str: string): string {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
