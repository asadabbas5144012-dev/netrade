// NEOTRADE OTP email relay — Google Apps Script (free, no card needed).
//
// Setup (logged in as netradeofficiall@gmail.com):
//  1. https://script.google.com -> New project -> paste this whole file.
//  2. Change SECRET below to your own long random text. Put the SAME text in
//     Render as MAIL_WEBHOOK_SECRET.
//  3. Deploy -> New deployment -> type "Web app"; Execute as: Me;
//     Who has access: Anyone -> Deploy -> Authorize access (Advanced ->
//     Go to project -> Allow).
//  4. Copy the Web app URL (ends in /exec) into Render as MAIL_WEBHOOK_URL.
//
// After editing this script later: Deploy -> Manage deployments -> Edit ->
// Version: New version -> Deploy (the URL stays the same).

const SECRET = 'CHANGE-ME-to-a-long-random-secret';

function doPost(e) {
  let data;
  try {
    data = JSON.parse(e.postData.contents);
  } catch (err) {
    return reply({ ok: false, error: 'bad request' });
  }
  if (!data || data.secret !== SECRET) return reply({ ok: false, error: 'forbidden: secret does not match' });
  if (data.ping) return reply({ ok: true, quotaLeft: MailApp.getRemainingDailyQuota() });
  if (!data.to || !data.subject) return reply({ ok: false, error: 'missing to/subject' });
  try {
    GmailApp.sendEmail(data.to, data.subject, data.text || '', {
      htmlBody: data.html || undefined,
      name: data.name || 'NEOTRADE'
    });
    return reply({ ok: true });
  } catch (err) {
    return reply({ ok: false, error: String(err && err.message || err) });
  }
}

function reply(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
