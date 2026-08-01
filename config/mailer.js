const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.example.com',
  port: process.env.SMTP_PORT || 587,
  secure: false, // true für Port 465, false für andere Ports
  auth: {
    user: process.env.SMTP_USER || 'deine-email@example.com',
    pass: process.env.SMTP_PASS || 'dein-passwort'
  }
});

const sendStatusEmail = async (customerEmail, projectName, newStatus) => {
  if (!customerEmail) return;
  
  try {
    await transporter.sendMail({
      from: '"Metallbau Management" <noreply@metallbau.de>',
      to: customerEmail,
      subject: `Statusupdate zu Ihrem Projekt: ${projectName}`,
      text: `Hallo,\n\nIhr Projekt "${projectName}" hat einen neuen Status erreicht: ${newStatus}.\n\nMit freundlichen Grüßen\nIhr Metallbau-Team`,
      html: `<p>Hallo,</p><p>Ihr Projekt <b>${projectName}</b> hat einen neuen Status erreicht: <b>${newStatus}</b>.</p><p>Mit freundlichen Grüßen<br>Ihr Metallbau-Team</p>`
    });
  } catch (error) {
    console.error('Fehler beim E-Mail-Versand:', error);
  }
};

module.exports = { sendStatusEmail };
