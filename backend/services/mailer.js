const nodemailer = require('nodemailer');

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

if (brevoKey) {
  console.log(`[Mailer] Using Brevo HTTP API, from ${config.from}`);
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

function describeError(error) {
  // e.g. "EAUTH: Invalid login: 535 Authentication failed"
  return [error.code, error.message].filter(Boolean).join(': ');
}

async function sendMail({ to, subject, html, text }) {
  if (brevoKey) {
    try {
      const data = await brevoRequest('/smtp/email', { sender: parseFrom(config.from), to: [{ email: to }], subject, htmlContent: html, textContent: text });
      console.log(`[Mailer] Sent "${subject}" to ${to} via Brevo (${data.messageId})`);
      return { success: true };
    } catch (error) {
      console.error(`[Mailer] Brevo failed to send "${subject}" to ${to}: ${describeError(error)}`);
      return { success: false, error: describeError(error) };
    }
  }
  if (!transporter) {
    const error = `SMTP is not configured (missing ${config.missing.join(', ')})`;
    console.error(`[Mailer] Not sending "${subject}" to ${to}: ${error}`);
    return { success: false, error };
  }
  try {
    const info = await transporter.sendMail({ from: config.from, to, subject, html, text });
    console.log(`[Mailer] Sent "${subject}" to ${to} (${info.messageId})`);
    return { success: true };
  } catch (error) {
    console.error(`[Mailer] Failed to send "${subject}" to ${to}: ${describeError(error)}`);
    return { success: false, error: describeError(error) };
  }
}

function layout(title, bodyHtml) {
  return `
    <div style="background-color: #0b0e14; padding: 24px 12px; font-family: Arial, sans-serif;">
      <div style="max-width: 560px; margin: 0 auto; background-color: #141821; border: 1px solid #2a2f3a; border-radius: 12px; padding: 28px 24px;">
        <div style="text-align: center; font-size: 22px; font-weight: bold; letter-spacing: 2px; color: #f1d98a; margin-bottom: 6px;">NEOTRADE</div>
        <h2 style="color: #ffffff; text-align: center; font-size: 18px; margin: 0 0 20px;">${title}</h2>
        ${bodyHtml}
        <hr style="border: none; border-top: 1px solid #2a2f3a; margin: 24px 0 16px;" />
        <p style="color: #8b93a7; font-size: 12px; text-align: center; margin: 0;">&copy; ${new Date().getFullYear()} NEOTRADE. All rights reserved.</p>
      </div>
    </div>
  `;
}

function codeBlock(code) {
  return `
      <div style="background-color: #0b0e14; border: 1px solid #3a3320; padding: 16px; border-radius: 8px; text-align: center; margin: 20px 0;">
        <span style="font-size: 26px; font-weight: bold; letter-spacing: 6px; color: #f1d98a;">${code}</span>
      </div>`;
}

const P = 'color: #c9cfdb; font-size: 15px; line-height: 1.6;';

async function sendOtpEmail(toEmail, otpCode) {
  return sendMail({
    to: toEmail,
    subject: 'Your NEOTRADE Verification Code',
    text: `Your NEOTRADE verification code is ${otpCode}. It expires in 10 minutes. If you did not request this, please ignore this email.`,
    html: layout('Verification Code', `
      <p style="${P}">Hello,</p>
      <p style="${P}">Use the following code to verify your email and complete your NEOTRADE sign-up. This code expires in 10 minutes.</p>
      ${codeBlock(otpCode)}
      <p style="color: #8b93a7; font-size: 13px;">If you did not request this, please ignore this email.</p>
    `)
  });
}

async function sendPasswordResetEmail(toEmail, resetCode) {
  return sendMail({
    to: toEmail,
    subject: 'Reset your NEOTRADE password',
    text: `Your NEOTRADE password reset code is ${resetCode}. It expires in 30 minutes. If you did not request a password reset, ignore this email — your password will not change.`,
    html: layout('Password Reset', `
      <p style="${P}">Hello,</p>
      <p style="${P}">We received a request to reset your NEOTRADE password. Enter this code in the app to choose a new password. It expires in 30 minutes.</p>
      ${codeBlock(resetCode)}
      <p style="color: #8b93a7; font-size: 13px;">If you did not request a password reset, ignore this email — your password will not change.</p>
    `)
  });
}

// Used by the existing admin route POST /api/admin/smtp/test (admin.js already
// imports it). Verifies connect + STARTTLS/TLS + login, and if a recipient is
// given also sends a real test email through the same path as OTP emails.
async function testSmtp(toEmail) {
  if (brevoKey) {
    try {
      await brevoRequest('/account');
    } catch (error) {
      return { success: false, error: `Brevo API key rejected — ${describeError(error)}` };
    }
  } else if (!transporter) {
    return { success: false, error: `SMTP is not configured. Set ${config.missing.join(', ')} in the Render environment variables.` };
  }
  if (!brevoKey) {
    try {
      await transporter.verify();
    } catch (error) {
      return { success: false, error: `Connection/login to ${config.host}:${config.port} failed — ${describeError(error)}` };
    }
  }
  if (!toEmail) {
    return { success: true, message: brevoKey ? 'Brevo API key is valid.' : `Connected and authenticated to ${config.host}:${config.port}.` };
  }
  const result = await sendMail({
    to: toEmail,
    subject: 'NEOTRADE SMTP test',
    text: 'This is a test email from the NEOTRADE admin panel. SMTP is working.',
    html: layout('SMTP Test', `<p style="${P}">This is a test email from the NEOTRADE admin panel. SMTP is working.</p>`)
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
