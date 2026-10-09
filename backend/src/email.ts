import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';

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
  invitationSubject: (clubName: string) => string;
  adminCancellationBody: (clubName: string) => string;
  adminCancellationSubject: (clubName: string) => string;
}

const emailStrings: Record<string, EmailStrings> = {
  en: {
    greeting: (name) => `Hi ${name},`,
    invitationBody: (clubName, date) => `You have been invited to an instruction session at <strong>${clubName}</strong> on <strong>${date}</strong>.`,
    invitationCta: 'Please click the link below to confirm or decline your attendance:',
    respondButton: 'Respond to Invitation',
    copyLink: 'Or copy this link:',
    bestRegards: 'Best regards,',
    confirmationBody: (clubName) => `Your attendance has been confirmed for the instruction session at <strong>${clubName}</strong>.`,
    dateLabel: 'Date:',
    timeLabel: 'Time:',
    disciplineLabel: 'Discipline:',
    cancelExplanation: 'If you can no longer attend, please cancel your participation using the link below so another student can take your place:',
    cancelButton: 'Cancel Participation',
    seeYou: 'See you at the training!',
    confirmationSubject: (clubName) => `Instruction Session Confirmed — ${clubName}`,
    cancellationBody: (clubName) => `Your participation in the instruction session at <strong>${clubName}</strong> has been cancelled.`,
    cancellationSubject: (clubName) => `Instruction Session Cancelled — ${clubName}`,
    invitationSubject: (clubName) => `Instruction Session Invitation — ${clubName}`,
    adminCancellationBody: (clubName) => `Your invitation for the instruction session at <strong>${clubName}</strong> has been withdrawn by the organiser.`,
    adminCancellationSubject: (clubName) => `Instruction Session Invitation Withdrawn — ${clubName}`,
  },
  nl: {
    greeting: (name) => `Hoi ${name},`,
    invitationBody: (clubName, date) => `Je bent uitgenodigd voor een instructiesessie bij <strong>${clubName}</strong> op <strong>${date}</strong>.`,
    invitationCta: 'Klik op de link hieronder om je aanwezigheid te bevestigen of af te wijzen:',
    respondButton: 'Reageer op uitnodiging',
    copyLink: 'Of kopieer deze link:',
    bestRegards: 'Met vriendelijke groet,',
    confirmationBody: (clubName) => `Je aanwezigheid is bevestigd voor de instructiesessie bij <strong>${clubName}</strong>.`,
    dateLabel: 'Datum:',
    timeLabel: 'Tijd:',
    disciplineLabel: 'Discipline:',
    cancelExplanation: 'Als je toch niet kunt komen, annuleer dan je deelname via de link hieronder zodat een andere leerling jouw plek kan innemen:',
    cancelButton: 'Deelname annuleren',
    seeYou: 'Tot bij de training!',
    confirmationSubject: (clubName) => `Instructiesessie bevestigd — ${clubName}`,
    cancellationBody: (clubName) => `Je deelname aan de instructiesessie bij <strong>${clubName}</strong> is geannuleerd.`,
    cancellationSubject: (clubName) => `Instructiesessie geannuleerd — ${clubName}`,
    invitationSubject: (clubName) => `Uitnodiging instructiesessie — ${clubName}`,
    adminCancellationBody: (clubName) => `Je uitnodiging voor de instructiesessie bij <strong>${clubName}</strong> is ingetrokken door de organisatie.`,
    adminCancellationSubject: (clubName) => `Instructiesessie uitnodiging ingetrokken — ${clubName}`,
  },
};

export function getEmailStrings(locale: string): EmailStrings {
  return emailStrings[locale] || emailStrings['en'];
}

// Mirrors the light theme in frontend/src/styles/tokens.css (email clients don't support CSS variables).
const theme = {
  page: '#e9ebec',
  surface: '#ffffff',
  sunken: '#f6f7f7',
  border: '#c9cdd0',
  borderStrong: '#a9afb4',
  text: '#1d2124',
  muted: '#5d656b',
  gunmetal: '#262a2e',
  onGunmetal: '#e6e8ea',
  accent: '#165b92',
  accentText: '#165b92',
  accentContrast: '#ffffff',
  success: '#3f6a2e',
  danger: '#a3141c',
  fontBody: "'Barlow', 'Helvetica Neue', Arial, sans-serif",
  fontDisplay: "'Barlow Semi Condensed', 'Barlow', 'Helvetica Neue', Arial, sans-serif",
  fontMono: "'IBM Plex Mono', Menlo, Consolas, monospace",
};

interface DetailRow {
  label: string;
  value: string;
  mono?: boolean;
}

function renderLayout(locale: string, title: string, clubName: string, content: string): string {
  return `<!DOCTYPE html>
<html lang="${escapeHtml(locale)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${escapeHtml(title)}</title>
</head>
<body style="margin: 0; padding: 0; background: ${theme.page};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background: ${theme.page};">
  <tr>
    <td align="center" style="padding: 24px 12px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width: 600px; background: ${theme.surface}; border: 1px solid ${theme.border}; border-radius: 3px;">
        <tr>
          <td style="background: ${theme.gunmetal}; border-bottom: 3px solid ${theme.accent}; border-radius: 3px 3px 0 0; padding: 16px 24px; font-family: ${theme.fontDisplay}; font-size: 18px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: ${theme.onGunmetal};">
            ${escapeHtml(clubName)}
          </td>
        </tr>
        <tr>
          <td style="padding: 28px 24px; font-family: ${theme.fontBody}; font-size: 15px; line-height: 1.5; color: ${theme.text};">
            ${content}
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;
}

function renderHeading(text: string): string {
  return `<h1 style="margin: 0 0 16px; font-family: ${theme.fontDisplay}; font-size: 22px; font-weight: 700; line-height: 1.3; letter-spacing: 0.01em; color: ${theme.text};">${escapeHtml(text)}</h1>`;
}

/** `html` must already be escaped. */
function renderParagraph(html: string): string {
  return `<p style="margin: 0 0 16px;">${html}</p>`;
}

function renderDetails(rows: DetailRow[], tone: 'success' | 'danger'): string {
  const rowsHtml = rows.map(row => `
      <tr>
        <td style="padding: 4px 16px 4px 0; white-space: nowrap; vertical-align: baseline; font-family: ${theme.fontDisplay}; font-size: 11px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; color: ${theme.muted};">${escapeHtml(row.label.replace(/:$/, ''))}</td>
        <td style="padding: 4px 0; vertical-align: baseline; font-family: ${row.mono ? theme.fontMono : theme.fontBody}; font-size: ${row.mono ? '14px' : '15px'}; color: ${theme.text};">${escapeHtml(row.value)}</td>
      </tr>`).join('');
  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin: 0 0 20px; background: ${theme.sunken}; border: 1px solid ${theme.border}; border-left: 3px solid ${theme[tone]}; border-radius: 2px;">
      <tr>
        <td style="padding: 12px 16px;">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0">${rowsHtml}
          </table>
        </td>
      </tr>
    </table>`;
}

function renderButton(url: string, label: string, variant: 'primary' | 'secondary'): string {
  const background = variant === 'primary' ? theme.accent : theme.sunken;
  const border = variant === 'primary' ? theme.accentText : theme.borderStrong;
  const color = variant === 'primary' ? theme.accentContrast : theme.text;
  return `
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin: 24px 0;">
      <tr>
        <td style="background: ${background}; border: 1px solid ${border}; border-radius: 2px;">
          <a href="${escapeHtml(url)}" style="display: inline-block; padding: 12px 24px; font-family: ${theme.fontBody}; font-size: 15px; font-weight: 600; color: ${color}; text-decoration: none;">${escapeHtml(label)}</a>
        </td>
      </tr>
    </table>`;
}

function renderCopyLink(label: string, url: string): string {
  return `<p style="margin: 0 0 20px; font-size: 13px; color: ${theme.muted}; word-break: break-all;">${escapeHtml(label)} <a href="${escapeHtml(url)}" style="color: ${theme.accentText};">${escapeHtml(url)}</a></p>`;
}

function renderSignoff(closing: string, clubName: string): string {
  return `<p style="margin: 0; padding-top: 16px; border-top: 1px solid ${theme.border};">${escapeHtml(closing)}<br/><strong>${escapeHtml(clubName)}</strong></p>`;
}

function sessionRows(s: EmailStrings, formattedDate: string, startTime: string, disciplineName: string | null): DetailRow[] {
  return [
    { label: s.dateLabel, value: formattedDate },
    { label: s.timeLabel, value: startTime, mono: true },
    ...(disciplineName ? [{ label: s.disciplineLabel, value: disciplineName }] : []),
  ];
}

async function deliver(to: string, subject: string, text: string, html: string, previewLines: string[]): Promise<void> {
  if (!transporter) {
    previewLines.forEach(line => console.log(line));
    const previewDir = process.env.EMAIL_PREVIEW_DIR;
    if (previewDir) {
      mkdirSync(previewDir, { recursive: true });
      const file = join(previewDir, `${Date.now()}-${subject.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.html`);
      writeFileSync(file, html);
      console.log(`   Saved preview: ${file}`);
    }
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

interface InvitationEmailParams {
  to: string;
  studentName: string;
  date: string;
  token: string;
  clubName: string;
  locale?: string;
}

export async function sendInvitationEmail({ to, studentName, date, token, clubName, locale }: InvitationEmailParams): Promise<void> {
  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
  const invitationUrl = `${frontendUrl}/invitation/${token}`;
  const s = getEmailStrings(locale || 'en');
  const subject = s.invitationSubject(clubName);
  const formattedDate = formatDateForEmail(date, locale || 'en');

  const html = renderLayout(locale || 'en', subject, clubName, [
    renderHeading(s.greeting(studentName)),
    renderParagraph(s.invitationBody(escapeHtml(clubName), escapeHtml(formattedDate))),
    renderParagraph(escapeHtml(s.invitationCta)),
    renderButton(invitationUrl, s.respondButton, 'primary'),
    renderCopyLink(s.copyLink, invitationUrl),
    renderSignoff(s.bestRegards, clubName),
  ].join(''));

  const text = `${s.greeting(studentName)}\n\n${stripHtml(s.invitationBody(clubName, formattedDate))}\n\n${s.invitationCta}\n${invitationUrl}\n\n${s.bestRegards}\n${clubName}`;

  await deliver(to, subject, text, html, [
    `📧 [Email Preview] To: ${to} | Subject: ${subject}`,
    `   Link: ${invitationUrl}`,
  ]);
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

function formatDateForEmail(dateStr: string, locale: string): string {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString(locale === 'nl' ? 'nl-NL' : 'en-GB', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  });
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
  const formattedDate = formatDateForEmail(date, locale || 'en');
  const disciplineText = disciplineName ? `${s.disciplineLabel} ${disciplineName}\n` : '';

  const html = renderLayout(locale || 'en', subject, clubName, [
    renderHeading(s.greeting(studentName)),
    renderParagraph(s.confirmationBody(escapeHtml(clubName))),
    renderDetails(sessionRows(s, formattedDate, startTime, disciplineName), 'success'),
    renderParagraph(escapeHtml(s.cancelExplanation)),
    renderButton(cancelUrl, s.cancelButton, 'secondary'),
    renderCopyLink(s.copyLink, cancelUrl),
    renderSignoff(s.seeYou, clubName),
  ].join(''));

  const text = `${s.greeting(studentName)}\n\n${stripHtml(s.confirmationBody(clubName))}\n\n${s.dateLabel} ${formattedDate}\n${s.timeLabel} ${startTime}\n${disciplineText}\n${s.cancelExplanation}\n${cancelUrl}\n\n${s.seeYou}\n${clubName}`;

  await deliver(to, subject, text, html, [
    `📧 [Confirmation Email Preview] To: ${to} | Subject: ${subject}`,
    `   Cancel link: ${cancelUrl}`,
  ]);
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
  const formattedDate = formatDateForEmail(date, locale || 'en');
  const disciplineText = disciplineName ? `${s.disciplineLabel} ${disciplineName}\n` : '';

  const html = renderLayout(locale || 'en', subject, clubName, [
    renderHeading(s.greeting(studentName)),
    renderParagraph(s.cancellationBody(escapeHtml(clubName))),
    renderDetails(sessionRows(s, formattedDate, startTime, disciplineName), 'danger'),
    renderSignoff(s.bestRegards, clubName),
  ].join(''));

  const text = `${s.greeting(studentName)}\n\n${stripHtml(s.cancellationBody(clubName))}\n\n${s.dateLabel} ${formattedDate}\n${s.timeLabel} ${startTime}\n${disciplineText}\n${s.bestRegards}\n${clubName}`;

  await deliver(to, subject, text, html, [`📧 [Cancellation Email Preview] To: ${to} | Subject: ${subject}`]);
}

interface AdminCancellationEmailParams {
  to: string;
  studentName: string;
  date: string;
  startTime: string;
  disciplineName: string | null;
  clubName: string;
  locale?: string;
}

export async function sendAdminCancellationEmail({ to, studentName, date, startTime, disciplineName, clubName, locale }: AdminCancellationEmailParams): Promise<void> {
  const s = getEmailStrings(locale || 'en');
  const subject = s.adminCancellationSubject(clubName);
  const formattedDate = formatDateForEmail(date, locale || 'en');
  const disciplineText = disciplineName ? `${s.disciplineLabel} ${disciplineName}\n` : '';

  const html = renderLayout(locale || 'en', subject, clubName, [
    renderHeading(s.greeting(studentName)),
    renderParagraph(s.adminCancellationBody(escapeHtml(clubName))),
    renderDetails(sessionRows(s, formattedDate, startTime, disciplineName), 'danger'),
    renderSignoff(s.bestRegards, clubName),
  ].join(''));

  const text = `${s.greeting(studentName)}\n\n${stripHtml(s.adminCancellationBody(clubName))}\n\n${s.dateLabel} ${formattedDate}\n${s.timeLabel} ${startTime}\n${disciplineText}\n${s.bestRegards}\n${clubName}`;

  await deliver(to, subject, text, html, [`📧 [Admin Cancellation Email Preview] To: ${to} | Subject: ${subject}`]);
}
