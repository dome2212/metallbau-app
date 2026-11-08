const mailer = require('./mailer');

/**
 * E-Mail senden (nutzt die SMTP-Einstellungen aus dem Admin-Panel bzw. .env).
 * @returns {Promise<{ok:boolean,error?:string}>}
 */
async function sendEmail(to, subject, htmlContent, attachments) {
  if (!to) return { ok: false, error: 'Keine Empfänger-Adresse' };
  const r = await mailer.sendMail({
    to, subject, html: htmlContent,
    attachments: (attachments || []).map(a => ({
      filename: a.filename, content: a.content, contentType: a.contentType || 'application/pdf'
    }))
  });
  if (r.ok) console.log('📧 E-Mail gesendet an: ' + to);
  else console.error('E-Mail-Versand fehlgeschlagen:', r.error);
  return r;
}

async function sendWhatsApp(toPhone, message, apiKey) {
  try {
    if (!toPhone || !apiKey) return;
    let phone = toPhone.replace(/\s+/g, '').replace(/[^+\d]/g, '');
    if (phone.startsWith('0')) phone = '+49' + phone.substring(1);
    if (phone.startsWith('+')) phone = phone.substring(1);
    const url = `https://api.callmebot.com/whatsapp.php?phone=${encodeURIComponent(phone)}&apikey=${encodeURIComponent(apiKey)}&text=${encodeURIComponent(message)}`;
    const res = await fetch(url);
    if (res.ok) {
      console.log(`📱 WhatsApp (CallMeBot) gesendet an: +${phone}`);
    } else {
      console.error(`📱 CallMeBot Fehler (${res.status}) für +${phone}`);
    }
  } catch (error) {
    console.error('Fehler beim WhatsApp-Versand (CallMeBot):', error.message);
  }
}

module.exports = { sendEmail, sendWhatsApp };
