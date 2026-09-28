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
//   SMTP_FROM    Sender shown to users, e.g. "NETRONTRADE <no-reply@mydomain.com>".
//                Must be a sender/domain verified with the provider. It is kept
//                separate from SMTP_USER on purpose.

const REQUIRED_VARS = ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM'];

// Strip surrounding quotes/whitespace pasted into env values.
function env(name) {
  let v = (process.env[name] || '').trim();
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
    v = v.slice(1, -1).trim();
  }
  return v;
}

function readConfig() {
  const port = parseInt(env('SMTP_PORT'), 10) || 587;
  const secureRaw = env('SMTP_SECURE').toLowerCase();
  const secure = secureRaw ? secureRaw === 'true' : port === 465;
  return {
    host: env('SMTP_HOST'),
    port,
    secure,
    user: env('SMTP_USER'),
    pass: env('SMTP_PASS'),
    from: env('SMTP_FROM'),
    missing: REQUIRED_VARS.filter(name => !env(name))
  };
}

const config = readConfig();

if (config.missing.length) {
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
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #ddd; border-radius: 8px;">
      <h2 style="color: #333; text-align: center;">${title}</h2>
      ${bodyHtml}
      <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;" />
      <p style="color: #999; font-size: 12px; text-align: center;">&copy; ${new Date().getFullYear()} NETRONTRADE. All rights reserved.</p>
    </div>
  `;
}

async function sendOtpEmail(toEmail, otpCode) {
  return sendMail({
    to: toEmail,
    subject: 'Your NETRONTRADE Verification Code',
    text: `Your NETRONTRADE verification code is ${otpCode}. It expires in 10 minutes. If you did not request this, please ignore this email.`,
    html: layout('Verification Code', `
      <p style="color: #555; font-size: 16px;">Hello,</p>
      <p style="color: #555; font-size: 16px;">Please use the following OTP code to verify your account or complete your sign-up process. This code will expire in 10 minutes.</p>
      <div style="background-color: #f4f4f4; padding: 15px; border-radius: 5px; text-align: center; margin: 20px 0;">
        <span style="font-size: 24px; font-weight: bold; letter-spacing: 5px; color: #000;">${otpCode}</span>
      </div>
      <p style="color: #555; font-size: 14px;">If you did not request this, please ignore this email.</p>
    `)
  });
}

// Used by the existing admin route POST /api/admin/smtp/test (admin.js already
// imports it). Verifies connect + STARTTLS/TLS + login, and if a recipient is
// given also sends a real test email through the same path as OTP emails.
async function testSmtp(toEmail) {
  if (!transporter) {
    return { success: false, error: `SMTP is not configured. Set ${config.missing.join(', ')} in the Render environment variables.` };
  }
  try {
    await transporter.verify();
  } catch (error) {
    return { success: false, error: `Connection/login to ${config.host}:${config.port} failed — ${describeError(error)}` };
  }
  if (!toEmail) {
    return { success: true, message: `Connected and authenticated to ${config.host}:${config.port}.` };
  }
  const result = await sendMail({
    to: toEmail,
    subject: 'NETRONTRADE SMTP test',
    text: 'This is a test email from the NETRONTRADE admin panel. SMTP is working.',
    html: layout('SMTP Test', '<p style="color: #555; font-size: 16px;">This is a test email from the NETRONTRADE admin panel. SMTP is working.</p>')
  });
  return result.success
    ? { success: true, message: `Test email sent to ${toEmail} from ${config.from}.` }
    : { success: false, error: `Authenticated, but sending failed — ${result.error}` };
}

module.exports = {
  sendOtpEmail,
  testSmtp
};
