const nodemailer = require('nodemailer');
const MailComposer = require('nodemailer/lib/mail-composer');

// Provider-independent SMTP mailer. Configuration comes ONLY from the server
// environment (Render dashboard, or a local .env that is never committed) —
// never from the database or the admin panel, and no credential is hardcoded.
//
//   SMTP_HOST    e.g. smtp-relay.brevo.com / mail.smtp2go.com / smtp.sendgrid.net
//   SMTP_PORT    2525 or 587 (STARTTLS) or 465 (implicit TLS). Render's free plan
//                blocks outbound 25/465/587, so use 2525 there.
//   SMTP_SECURE  "true" only for implicit TLS (465); "false" for STARTTLS.
//                Defaults to true on 465, false otherwise.
//   SMTP_USER    SMTP login (for some providers this is not an email address,
//                e.g. SendGrid's literal "apikey")
//   SMTP_PASS    SMTP password / API key
//   SMTP_FROM    Sender shown to users. Defaults to
//                "NEOTRADE <netradeofficiall@gmail.com>". Must be a sender
//                verified with the provider. It is kept separate from SMTP_USER
//                on purpose.
//
// Gmail SMTP: SMTP_USER=netradeofficiall@gmail.com and SMTP_PASS=<16-char Google
// App Password>; SMTP_HOST then defaults to smtp.gmail.com (port 465).
//
// HTTPS alternative (recommended on Render): if BREVO_API_KEY is set, emails
// go through Brevo's HTTP API on port 443, which Render never blocks, and the
// SMTP_* variables above are ignored except SMTP_FROM (the verified sender).
//   BREVO_API_KEY  Brevo -> SMTP & API -> API Keys (starts with "xkeysib-")
//
// Google Apps Script relay (no Google Cloud project or card needed): a small
// script deployed as a web app inside the Gmail account sends the mail with
// GmailApp. Set MAIL_WEBHOOK_URL (the /exec URL) and MAIL_WEBHOOK_SECRET (the
// same secret written in the script). Consumer Gmail allows ~100
// recipients/day this way. Used when the Gmail API is not configured.
//
// Gmail API (most reliable for a @gmail.com sender, also HTTPS/443): when
// GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET and GMAIL_REFRESH_TOKEN are all set,
// mail is sent by Gmail itself from the authorized account, so it passes
// Gmail's own checks and lands in the inbox. This takes priority over Brevo.

const DEFAULT_FROM = 'NEOTRADE <netradeofficiall@gmail.com>';
const REQUIRED_VARS = ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS'];

// Strip surrounding quotes/whitespace pasted into env values.
function env(name) {
  let v = (process.env[name] || '').trim();
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
    v = v.slice(1, -1).trim();
  }
  return v;
}

function readConfig() {
  const user = env('SMTP_USER');
  const isGmail = /@gmail\.com$/i.test(user);
  const host = env('SMTP_HOST') || (isGmail ? 'smtp.gmail.com' : '');
  const port = parseInt(env('SMTP_PORT'), 10) || (isGmail && !env('SMTP_HOST') ? 465 : 587);
  const secureRaw = env('SMTP_SECURE').toLowerCase();
  const secure = secureRaw ? secureRaw === 'true' : port === 465;
  // Google shows App Passwords as "abcd efgh ijkl mnop"; the spaces are not part of it.
  const pass = isGmail ? env('SMTP_PASS').replace(/\s+/g, '') : env('SMTP_PASS');
  const values = { SMTP_HOST: host, SMTP_USER: user, SMTP_PASS: pass };
  return {
    host,
    port,
    secure,
    user,
    pass,
    from: env('SMTP_FROM') || DEFAULT_FROM,
    missing: REQUIRED_VARS.filter(name => !values[name])
  };
}

const config = readConfig();
const brevoKey = env('BREVO_API_KEY');
const gmail = {
  clientId: env('GMAIL_CLIENT_ID'),
  clientSecret: env('GMAIL_CLIENT_SECRET'),
  refreshToken: env('GMAIL_REFRESH_TOKEN')
};
const useGmail = !!(gmail.clientId && gmail.clientSecret && gmail.refreshToken);
const webhook = { url: env('MAIL_WEBHOOK_URL'), secret: env('MAIL_WEBHOOK_SECRET') };
const useWebhook = !useGmail && !!(webhook.url && webhook.secret);

// Apps Script answers a POST with a 302 to a googleusercontent.com URL that
// holds the script's output; fetch follows it and we read that JSON.
async function webhookSend(payload) {
  const res = await fetch(webhook.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ secret: webhook.secret, ...payload }),
    redirect: 'follow',
    signal: AbortSignal.timeout(30000)
  });
  const body = await res.text();
  let data;
  try { data = JSON.parse(body); } catch (e) {
    throw Object.assign(new Error(`unexpected response (HTTP ${res.status}) — check the web app is deployed with access "Anyone"`), { code: 'WEBHOOK' });
  }
  if (!res.ok || !data.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { code: 'WEBHOOK' });
  return data;
}

let gmailToken = null; // { value, expiresAt }
async function gmailAccessToken() {
  if (gmailToken && Date.now() < gmailToken.expiresAt) return gmailToken.value;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: gmail.clientId,
      client_secret: gmail.clientSecret,
      refresh_token: gmail.refreshToken,
      grant_type: 'refresh_token'
    }),
    signal: AbortSignal.timeout(15000)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw Object.assign(new Error(data.error_description || data.error || `HTTP ${res.status}`), { code: 'GMAIL_AUTH' });
  }
  gmailToken = { value: data.access_token, expiresAt: Date.now() + Math.max(60, (data.expires_in || 3600) - 120) * 1000 };
  return gmailToken.value;
}

async function gmailSend({ from, to, subject, html, text }) {
  const raw = await new MailComposer({ from, to, subject, html, text }).compile().build();
  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: { authorization: `Bearer ${await gmailAccessToken()}`, 'content-type': 'application/json' },
    body: JSON.stringify({ raw: raw.toString('base64url') }),
    signal: AbortSignal.timeout(15000)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error?.message || `HTTP ${res.status}`), { code: `GMAIL_${res.status}` });
  return data;
}

// "NEOTRADE <no-reply@x.com>" -> { name, email }
function parseFrom(from) {
  const m = from.match(/^\s*(.*?)\s*<([^>]+)>\s*$/);
  return m ? { name: m[1].replace(/^"|"$/g, '') || undefined, email: m[2].trim() } : { email: from };
}

async function brevoRequest(path, body) {
  const res = await fetch(`https://api.brevo.com/v3${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'api-key': brevoKey, 'content-type': 'application/json', accept: 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.message || `HTTP ${res.status}`), { code: data.code || `HTTP_${res.status}` });
  return data;
}

if (useGmail) {
  console.log(`[Mailer] Using Gmail API, from ${/@gmail\.com>?\s*$/i.test(config.from) ? config.from : DEFAULT_FROM}`);
} else if (useWebhook) {
  console.log('[Mailer] Using Google Apps Script relay (sends from the Gmail account that owns the script)');
} else if (brevoKey) {
  console.log(`[Mailer] Using Brevo HTTP API, from ${config.from}`);
  // Log which Brevo account this key belongs to — emails only show up in
  // that account's logs, so a key from a different account looks like
  // "sent" here but never appears in the dashboard being checked.
  describeBrevoAccount().then(info => console.log(`[Mailer] Brevo key belongs to ${info}`))
    .catch(error => console.error(`[Mailer] Brevo API key check failed — ${describeError(error)}`));
} else if (config.missing.length) {
  console.error(`[Mailer] SMTP is not configured — missing ${config.missing.join(', ')}. OTP emails will fail until these are set in the environment.`);
} else {
  console.log(`[Mailer] SMTP configured: ${config.host}:${config.port} (${config.secure ? 'implicit TLS' : 'STARTTLS required'}), from ${config.from}`);
}

const transporter = config.missing.length ? null : nodemailer.createTransport({
  host: config.host,
  port: config.port,
  secure: config.secure,
  // On non-implicit-TLS ports (587/2525) refuse to continue unless the server
  // upgrades with STARTTLS, so credentials are never sent in plain text.
  requireTLS: !config.secure,
  auth: { user: config.user, pass: config.pass },
  // Certificate verification stays ON (Node's default). servername makes SNI
  // and hostname checks work for providers behind shared certificates.
  tls: { servername: config.host, minVersion: 'TLSv1.2' },
  // Fail fast (e.g. a blocked port) instead of hanging the HTTP request.
  connectionTimeout: 15000,
  greetingTimeout: 10000,
  socketTimeout: 20000
});

async function describeBrevoAccount() {
  const a = await brevoRequest('/account');
  const credits = (a.plan || []).map(p => `${p.type}: ${p.credits} ${p.creditsType || 'credits'} left`).join(', ');
  return `account ${a.email} (${a.companyName || [a.firstName, a.lastName].filter(Boolean).join(' ') || 'no name'})${credits ? ' — ' + credits : ''}`;
}

// Brevo accepting a send only means it was queued. ~30s later, ask Brevo
// what actually happened (delivered, blocked, bounced, error + reason) and
// log it, so a failed delivery is visible in the server logs.
function logBrevoDelivery(messageId, to) {
  setTimeout(async () => {
    try {
      const data = await brevoRequest(`/smtp/statistics/events?messageId=${encodeURIComponent(messageId)}&limit=20&sort=desc`);
      const events = (data.events || []).map(e => e.event + (e.reason ? ` (${e.reason})` : '')).join(', ');
      console.log(`[Mailer] Brevo status for ${to} ${messageId}: ${events || 'no events yet (still queued, or not processed by this account)'}`);
    } catch (error) {
      console.error(`[Mailer] Could not read Brevo status for ${to}: ${describeError(error)}`);
    }
  }, 30000).unref();
}

function describeError(error) {
  // e.g. "EAUTH: Invalid login: 535 Authentication failed"
  return [error.code, error.message].filter(Boolean).join(': ');
}

// Subjects carry the one-time code; keep it out of the server logs.
function logSubject(subject) {
  return subject.replace(/^\S+ is your /, '<code> is your ');
}

async function sendMail({ to, subject, html, text }) {
  if (useGmail) {
    try {
      // Gmail only sends as the authorized account, so a non-Gmail SMTP_FROM
      // (e.g. a Brevo sender) falls back to the Gmail default.
      const from = /@gmail\.com>?\s*$/i.test(config.from) ? config.from : DEFAULT_FROM;
      const data = await gmailSend({ from, to, subject, html, text });
      console.log(`[Mailer] Sent "${logSubject(subject)}" to ${to} via Gmail API (${data.id})`);
      return { success: true };
    } catch (error) {
      console.error(`[Mailer] Gmail API failed to send "${logSubject(subject)}" to ${to}: ${describeError(error)}`);
      return { success: false, error: describeError(error) };
    }
  }
  if (useWebhook) {
    try {
      await webhookSend({ to, subject, html, text, name: parseFrom(config.from).name || 'NEOTRADE' });
      console.log(`[Mailer] Sent "${logSubject(subject)}" to ${to} via Apps Script`);
      return { success: true };
    } catch (error) {
      console.error(`[Mailer] Apps Script failed to send "${logSubject(subject)}" to ${to}: ${describeError(error)}`);
      return { success: false, error: describeError(error) };
    }
  }
  if (brevoKey) {
    try {
      const data = await brevoRequest('/smtp/email', { sender: parseFrom(config.from), to: [{ email: to }], subject, htmlContent: html, textContent: text });
      console.log(`[Mailer] Sent "${logSubject(subject)}" to ${to} via Brevo (${data.messageId})`);
      if (data.messageId) logBrevoDelivery(data.messageId, to);
      return { success: true };
    } catch (error) {
      console.error(`[Mailer] Brevo failed to send "${logSubject(subject)}" to ${to}: ${describeError(error)}`);
      return { success: false, error: describeError(error) };
    }
  }
  if (!transporter) {
    const error = `SMTP is not configured (missing ${config.missing.join(', ')})`;
    console.error(`[Mailer] Not sending "${logSubject(subject)}" to ${to}: ${error}`);
    return { success: false, error };
  }
  try {
    const info = await transporter.sendMail({ from: config.from, to, subject, html, text });
    console.log(`[Mailer] Sent "${logSubject(subject)}" to ${to} (${info.messageId})`);
    return { success: true };
  } catch (error) {
    console.error(`[Mailer] Failed to send "${logSubject(subject)}" to ${to}: ${describeError(error)}`);
    return { success: false, error: describeError(error) };
  }
}

// Deliberately plain: a fresh sender's heavily styled, dark, image-like email
// looks like phishing to Gmail's filters, while short, simple messages (the
// way big services send codes) are far more likely to reach the inbox.
function layout(bodyHtml) {
  return `<div style="font-family: Arial, Helvetica, sans-serif; font-size: 15px; line-height: 1.6; color: #222; max-width: 520px;">
${bodyHtml}
<p style="color: #777; font-size: 13px; margin-top: 24px;">— NEOTRADE team</p>
</div>`;
}

const P = 'margin: 0 0 12px;';

async function sendOtpEmail(toEmail, otpCode) {
  return sendMail({
    to: toEmail,
    subject: `${otpCode} is your NEOTRADE verification code`,
    text: `Hi,\n\nYour NEOTRADE verification code is: ${otpCode}\n\nEnter this code in the app to finish creating your account. It expires in 10 minutes.\n\nIf you didn't request this, you can ignore this email.\n\n— NEOTRADE team`,
    html: layout(`
<p style="${P}">Hi,</p>
<p style="${P}">Your NEOTRADE verification code is:</p>
<p style="margin: 0 0 12px; font-size: 24px; font-weight: bold; letter-spacing: 3px;">${otpCode}</p>
<p style="${P}">Enter this code in the app to finish creating your account. It expires in 10 minutes.</p>
<p style="${P}">If you didn't request this, you can ignore this email.</p>`)
  });
}

async function sendPasswordResetEmail(toEmail, resetCode) {
  return sendMail({
    to: toEmail,
    subject: `${resetCode} is your NEOTRADE password reset code`,
    text: `Hi,\n\nYour NEOTRADE password reset code is: ${resetCode}\n\nEnter this code in the app to choose a new password. It expires in 30 minutes.\n\nIf you didn't request a password reset, ignore this email — your password will not change.\n\n— NEOTRADE team`,
    html: layout(`
<p style="${P}">Hi,</p>
<p style="${P}">Your NEOTRADE password reset code is:</p>
<p style="margin: 0 0 12px; font-size: 24px; font-weight: bold; letter-spacing: 3px;">${resetCode}</p>
<p style="${P}">Enter this code in the app to choose a new password. It expires in 30 minutes.</p>
<p style="${P}">If you didn't request a password reset, ignore this email — your password will not change.</p>`)
  });
}

// Used by the existing admin route POST /api/admin/smtp/test (admin.js already
// imports it). Verifies connect + STARTTLS/TLS + login, and if a recipient is
// given also sends a real test email through the same path as OTP emails.
async function testSmtp(toEmail) {
  let brevoAccountInfo = '';
  if (useGmail) {
    try {
      await gmailAccessToken();
    } catch (error) {
      return { success: false, error: `Gmail API credentials rejected — ${describeError(error)}` };
    }
  } else if (useWebhook) {
    try {
      await webhookSend({ ping: true });
    } catch (error) {
      return { success: false, error: `Apps Script relay check failed — ${describeError(error)}` };
    }
  } else if (brevoKey) {
    try {
      brevoAccountInfo = await describeBrevoAccount();
    } catch (error) {
      return { success: false, error: `Brevo API key rejected — ${describeError(error)}` };
    }
  } else if (!transporter) {
    return { success: false, error: `SMTP is not configured. Set ${config.missing.join(', ')} in the Render environment variables.` };
  }
  if (!brevoKey && !useGmail && !useWebhook) {
    try {
      await transporter.verify();
    } catch (error) {
      return { success: false, error: `Connection/login to ${config.host}:${config.port} failed — ${describeError(error)}` };
    }
  }
  if (!toEmail) {
    return { success: true, message: useGmail ? 'Gmail API credentials are valid.' : useWebhook ? 'Apps Script relay is reachable.' : brevoKey ? `Brevo API key is valid — ${brevoAccountInfo}.` : `Connected and authenticated to ${config.host}:${config.port}.` };
  }
  const result = await sendMail({
    to: toEmail,
    subject: 'NEOTRADE SMTP test',
    text: 'This is a test email from the NEOTRADE admin panel. SMTP is working.',
    html: layout(`<p style="${P}">This is a test email from the NEOTRADE admin panel. Email sending is working.</p>`)
  });
  return result.success
    ? { success: true, message: `Test email sent to ${toEmail} from ${config.from}.` }
    : { success: false, error: `Authenticated, but sending failed — ${result.error}` };
}

module.exports = {
  sendOtpEmail,
  sendPasswordResetEmail,
  testSmtp
};
