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

interface ConfirmationEmailParams {
  to: string;
  studentName: string;
  date: string;
  startTime: string;
  disciplineName: string | null;
  token: string;
  clubName: string;
  subject: string;
}

export async function sendConfirmationEmail({ to, studentName, date, startTime, disciplineName, token, clubName, subject }: ConfirmationEmailParams): Promise<void> {
  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
  const cancelUrl = `${frontendUrl}/invitation/${token}`;

  const disciplineLine = disciplineName
    ? `<p><strong>Discipline:</strong> ${escapeHtml(disciplineName)}</p>`
    : '';
  const disciplineText = disciplineName ? `Discipline: ${disciplineName}\n` : '';

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <h2>Hi ${escapeHtml(studentName)},</h2>
      <p>Your attendance has been confirmed for the coaching session at <strong>${escapeHtml(clubName)}</strong>.</p>
      <div style="background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 8px; padding: 16px; margin: 16px 0;">
        <p style="margin: 4px 0;"><strong>Date:</strong> ${escapeHtml(date)}</p>
        <p style="margin: 4px 0;"><strong>Time:</strong> ${escapeHtml(startTime)}</p>
        ${disciplineLine}
      </div>
      <p>If you can no longer attend, please cancel your participation using the link below so another student can take your place:</p>
      <p style="margin: 24px 0;">
        <a href="${escapeHtml(cancelUrl)}"
           style="background-color: #dc2626; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold;">
          Cancel Participation
        </a>
      </p>
      <p style="color: #666; font-size: 14px;">
        Or copy this link: ${escapeHtml(cancelUrl)}
      </p>
      <p>See you at the training!<br/>${escapeHtml(clubName)}</p>
    </div>
  `;

  const text = `Hi ${studentName},\n\nYour attendance has been confirmed for the coaching session at ${clubName}.\n\nDate: ${date}\nTime: ${startTime}\n${disciplineText}\nIf you can no longer attend, please cancel using this link:\n${cancelUrl}\n\nSee you at the training!\n${clubName}`;

  if (!transporter) {
    console.log(`📧 [Confirmation Email Preview] To: ${to} | Subject: ${subject}`);
    console.log(`   Cancel link: ${cancelUrl}`);
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
