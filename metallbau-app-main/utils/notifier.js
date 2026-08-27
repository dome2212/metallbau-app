const nodemailer = require('nodemailer');

// E-Mail Transporter konfigurieren
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.example.com',
  port: process.env.SMTP_PORT || 465,
  secure: true,
  auth: {
    user: process.env.SMTP_USER || 'dein-benutzer@example.com',
    pass: process.env.SMTP_PASS || 'dein-passwort'
  }
});

// 1. E-Mail senden
async function sendEmail(to, subject, htmlContent) {
  try {
    if (!to) return;
    await transporter.sendMail({
      from: '"Metallbau Management" <noreply@metallbau-management.de>',
      to,
      subject,
      html: htmlContent
    });
    console.log(`📧 E-Mail erfolgreich gesendet an: ${to}`);
  } catch (error) {
    console.error('Fehler beim E-Mail-Versand:', error);
  }
}

// 2. WhatsApp via CallMeBot senden
// Jeder Empfänger benötigt einen eigenen API-Key:
//   → WhatsApp an +34 644 52 74 21 senden: "I allow callmebot to send me messages"
//   → API-Key wird zurückgeschickt und im Admin-Panel eingetragen
async function sendWhatsApp(toPhone, message, apiKey) {
  try {
    if (!toPhone || !apiKey) return;

    // Nummer normalisieren: führende 0 → +49, Leerzeichen entfernen
    let phone = toPhone.replace(/\s+/g, '').replace(/[^+\d]/g, '');
    if (phone.startsWith('0')) phone = '+49' + phone.substring(1);
    if (phone.startsWith('+')) phone = phone.substring(1); // CallMeBot erwartet ohne +

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
