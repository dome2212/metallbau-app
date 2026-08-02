const nodemailer = require('nodemailer');
const twilio = require('twilio');

// E-Mail Transporter konfigurieren (Trage hier deine SMTP-Daten ein oder nutze .env-Variablen)
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.example.com',
  port: process.env.SMTP_PORT || 465,
  secure: true,
  auth: {
    user: process.env.SMTP_USER || 'dein-benutzer@example.com',
    pass: process.env.SMTP_PASS || 'dein-passwort'
  }
});

// Twilio Client lazy initialisieren – erst beim ersten Aufruf, nicht beim Start
function getTwilioClient() {
  const sid  = process.env.TWILIO_SID;
  const auth = process.env.TWILIO_AUTH;
  if (!sid || !auth || !sid.startsWith('AC')) return null;
  return twilio(sid, auth);
}

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

// 2. WhatsApp Nachricht senden
async function sendWhatsApp(toPhone, message) {
  try {
    const twilioClient = getTwilioClient();
    if (!twilioClient || !toPhone) return;
    // Formatierung anpassen (z.B. Leerzeichen entfernen)
    let formattedPhone = toPhone.replace(/\s+/g, '');
    if (formattedPhone.startsWith('0')) {
      formattedPhone = '+49' + formattedPhone.substring(1); // Standardmäßig Deutschland, anpassbar
    }

    await twilioClient.messages.create({
      from: process.env.TWILIO_WHATSAPP_FROM || 'whatsapp:+14155238886', // Twilio Sandbox oder Business Nummer
      to: `whatsapp:${formattedPhone}`,
      body: message
    });
    console.log(`📱 WhatsApp erfolgreich gesendet an: ${formattedPhone}`);
  } catch (error) {
    console.error('Fehler beim WhatsApp-Versand:', error);
  }
}

module.exports = { sendEmail, sendWhatsApp };
