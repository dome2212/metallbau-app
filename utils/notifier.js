const nodemailer = require('nodemailer');

function createTransporter() {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.example.com',
    port: parseInt(process.env.SMTP_PORT || '465', 10),
    secure: String(process.env.SMTP_SECURE || 'true') !== 'false',
    auth: {
      user: process.env.SMTP_USER || 'dein-benutzer@example.com',
      pass: process.env.SMTP_PASS || 'dein-passwort'
    }
  });
}

/**
 * E-Mail senden.
 * @param {string} to
 * @param {string} subject
 * @param {string} htmlContent
 * @param {Array<{filename:string, content:Buffer, contentType?:string}>} [attachments]
 */
async function sendEmail(to, subject, htmlContent, attachments) {
  try {
    if (!to) return { ok: false, error: 'Keine Empfänger-Adresse' };
    const transporter = createTransporter();
    const mail = {
      from: process.env.SMTP_FROM || '"Metallbau Management" <noreply@metallbau-management.de>',
      to,
      subject,
      html: htmlContent
    };
    if (attachments && attachments.length) {
      mail.attachments = attachments.map(a => ({
        filename: a.filename,
        content: a.content,
        contentType: a.contentType || 'application/pdf'
      }));
    }
    await transporter.sendMail(mail);
    console.log(`📧 E-Mail erfolgreich gesendet an: ${to}`);
    return { ok: true };
  } catch (error) {
    console.error('Fehler beim E-Mail-Versand:', error);
    return { ok: false, error: error.message };
  }
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
