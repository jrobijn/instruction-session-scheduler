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

// Email translations
interface EmailStrings {
  greeting: (name: string) => string;
  invitationBody: (clubName: string, date: string) => string;
  invitationCta: string;
  respondButton: string;
  copyLink: string;
  bestRegards: string;
  confirmationBody: (clubName: string) => string;
  dateLabel: string;
  timeLabel: string;
  disciplineLabel: string;
  cancelExplanation: string;
  cancelButton: string;
  seeYou: string;
  confirmationSubject: (clubName: string) => string;
  cancellationBody: (clubName: string) => string;
  cancellationSubject: (clubName: string) => string;
}

const emailStrings: Record<string, EmailStrings> = {
  en: {
    greeting: (name) => `Hi ${name},`,
    invitationBody: (clubName, date) => `You have been invited to a coaching session at <strong>${clubName}</strong> on <strong>${date}</strong>.`,
    invitationCta: 'Please click the link below to confirm or decline your attendance:',
    respondButton: 'Respond to Invitation',
    copyLink: 'Or copy this link:',
    bestRegards: 'Best regards,',
    confirmationBody: (clubName) => `Your attendance has been confirmed for the coaching session at <strong>${clubName}</strong>.`,
    dateLabel: 'Date:',
    timeLabel: 'Time:',
    disciplineLabel: 'Discipline:',
    cancelExplanation: 'If you can no longer attend, please cancel your participation using the link below so another student can take your place:',
    cancelButton: 'Cancel Participation',
    seeYou: 'See you at the training!',
    confirmationSubject: (clubName) => `Confirmation — ${clubName}`,
    cancellationBody: (clubName) => `Your participation in the coaching session at <strong>${clubName}</strong> has been cancelled.`,
    cancellationSubject: (clubName) => `Cancellation — ${clubName}`,
  },
  nl: {
    greeting: (name) => `Hoi ${name},`,
    invitationBody: (clubName, date) => `Je bent uitgenodigd voor een coachingsessie bij <strong>${clubName}</strong> op <strong>${date}</strong>.`,
    invitationCta: 'Klik op de link hieronder om je aanwezigheid te bevestigen of af te wijzen:',
    respondButton: 'Reageer op uitnodiging',
    copyLink: 'Of kopieer deze link:',
    bestRegards: 'Met vriendelijke groet,',
    confirmationBody: (clubName) => `Je aanwezigheid is bevestigd voor de coachingsessie bij <strong>${clubName}</strong>.`,
    dateLabel: 'Datum:',
    timeLabel: 'Tijd:',
    disciplineLabel: 'Discipline:',
    cancelExplanation: 'Als je toch niet kunt komen, annuleer dan je deelname via de link hieronder zodat een andere leerling jouw plek kan innemen:',
    cancelButton: 'Deelname annuleren',
    seeYou: 'Tot bij de training!',
    confirmationSubject: (clubName) => `Bevestiging — ${clubName}`,
    cancellationBody: (clubName) => `Je deelname aan de coachingsessie bij <strong>${clubName}</strong> is geannuleerd.`,
    cancellationSubject: (clubName) => `Annulering — ${clubName}`,
  },
};

export function getEmailStrings(locale: string): EmailStrings {
  return emailStrings[locale] || emailStrings['en'];
}

interface InvitationEmailParams {
  to: string;
  studentName: string;
  date: string;
  token: string;
  clubName: string;
  subject: string;
  locale?: string;
}

export async function sendInvitationEmail({ to, studentName, date, token, clubName, subject, locale }: InvitationEmailParams): Promise<void> {
  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
  const invitationUrl = `${frontendUrl}/invitation/${token}`;
  const s = getEmailStrings(locale || 'en');

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <h2>${escapeHtml(s.greeting(studentName))}</h2>
      <p>${s.invitationBody(escapeHtml(clubName), escapeHtml(date))}</p>
      <p>${escapeHtml(s.invitationCta)}</p>
      <p style="margin: 24px 0;">
        <a href="${escapeHtml(invitationUrl)}"
           style="background-color: #2563eb; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold;">
          ${escapeHtml(s.respondButton)}
        </a>
      </p>
      <p style="color: #666; font-size: 14px;">
        ${escapeHtml(s.copyLink)} ${escapeHtml(invitationUrl)}
      </p>
      <p>${escapeHtml(s.bestRegards)}<br/>${escapeHtml(clubName)}</p>
    </div>
  `;

  const text = `${s.greeting(studentName)}\n\n${stripHtml(s.invitationBody(clubName, date))}\n\n${s.invitationCta}\n${invitationUrl}\n\n${s.bestRegards}\n${clubName}`;

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

function stripHtml(str: string): string {
  return String(str).replace(/<[^>]*>/g, '');
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
  locale?: string;
}

export async function sendConfirmationEmail({ to, studentName, date, startTime, disciplineName, token, clubName, subject, locale }: ConfirmationEmailParams): Promise<void> {
  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
  const cancelUrl = `${frontendUrl}/invitation/${token}`;
  const s = getEmailStrings(locale || 'en');

  const disciplineLine = disciplineName
    ? `<p style="margin: 4px 0;"><strong>${escapeHtml(s.disciplineLabel)}</strong> ${escapeHtml(disciplineName)}</p>`
    : '';
  const disciplineText = disciplineName ? `${s.disciplineLabel} ${disciplineName}\n` : '';

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <h2>${escapeHtml(s.greeting(studentName))}</h2>
      <p>${s.confirmationBody(escapeHtml(clubName))}</p>
      <div style="background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 8px; padding: 16px; margin: 16px 0;">
        <p style="margin: 4px 0;"><strong>${escapeHtml(s.dateLabel)}</strong> ${escapeHtml(date)}</p>
        <p style="margin: 4px 0;"><strong>${escapeHtml(s.timeLabel)}</strong> ${escapeHtml(startTime)}</p>
        ${disciplineLine}
      </div>
      <p>${escapeHtml(s.cancelExplanation)}</p>
      <p style="margin: 24px 0;">
        <a href="${escapeHtml(cancelUrl)}"
           style="background-color: #dc2626; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold;">
          ${escapeHtml(s.cancelButton)}
        </a>
      </p>
      <p style="color: #666; font-size: 14px;">
        ${escapeHtml(s.copyLink)} ${escapeHtml(cancelUrl)}
      </p>
      <p>${escapeHtml(s.seeYou)}<br/>${escapeHtml(clubName)}</p>
    </div>
  `;

  const text = `${s.greeting(studentName)}\n\n${stripHtml(s.confirmationBody(clubName))}\n\n${s.dateLabel} ${date}\n${s.timeLabel} ${startTime}\n${disciplineText}\n${s.cancelExplanation}\n${cancelUrl}\n\n${s.seeYou}\n${clubName}`;

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

interface CancellationEmailParams {
  to: string;
  studentName: string;
  date: string;
  startTime: string;
  disciplineName: string | null;
  clubName: string;
  subject: string;
  locale?: string;
}

export async function sendCancellationEmail({ to, studentName, date, startTime, disciplineName, clubName, subject, locale }: CancellationEmailParams): Promise<void> {
  const s = getEmailStrings(locale || 'en');

  const disciplineLine = disciplineName
    ? `<p style="margin: 4px 0;"><strong>${escapeHtml(s.disciplineLabel)}</strong> ${escapeHtml(disciplineName)}</p>`
    : '';
  const disciplineText = disciplineName ? `${s.disciplineLabel} ${disciplineName}\n` : '';

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <h2>${escapeHtml(s.greeting(studentName))}</h2>
      <p>${s.cancellationBody(escapeHtml(clubName))}</p>
      <div style="background: #fef2f2; border: 1px solid #fecaca; border-radius: 8px; padding: 16px; margin: 16px 0;">
        <p style="margin: 4px 0;"><strong>${escapeHtml(s.dateLabel)}</strong> ${escapeHtml(date)}</p>
        <p style="margin: 4px 0;"><strong>${escapeHtml(s.timeLabel)}</strong> ${escapeHtml(startTime)}</p>
        ${disciplineLine}
      </div>
      <p>${escapeHtml(s.bestRegards)}<br/>${escapeHtml(clubName)}</p>
    </div>
  `;

  const text = `${s.greeting(studentName)}\n\n${stripHtml(s.cancellationBody(clubName))}\n\n${s.dateLabel} ${date}\n${s.timeLabel} ${startTime}\n${disciplineText}\n${s.bestRegards}\n${clubName}`;

  if (!transporter) {
    console.log(`📧 [Cancellation Email Preview] To: ${to} | Subject: ${subject}`);
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
