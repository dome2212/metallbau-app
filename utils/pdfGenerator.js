const PDFDocument = require('pdfkit');

/**
 * Erzeugt ein einfaches Dokument-PDF (Angebot / Rechnung).
 * firmaInfo ist optional – wird kein Objekt übergeben, greifen die Fallback-Werte.
 * In server.js steht die zentrale FIRMA-Konstante; beim Aufruf einfach { firmaInfo: FIRMA } übergeben.
 */
function generateDocumentPDF(docData, customerData, items, res, firmaInfo = {}) {
  const firma = {
    name:          firmaInfo.name          || 'Metallbau Gehrmann',
    slogan:        firmaInfo.slogan        || 'Stahlbau · Edelstahlverarbeitung · Geländer & Tore',
    strasse:       firmaInfo.strasse       || 'Musterstraße 1',
    plzOrt:        firmaInfo.plzOrt        || '45000 Musterstadt',
    tel:           firmaInfo.tel           || '+49 123 456789',
    iban:          firmaInfo.iban          || 'DE12 3456 7890 1234 5678 90',
    bic:           firmaInfo.bic           || 'MUBADE12',
    bank:          firmaInfo.bank          || 'Musterbank DE',
    zahlungsfrist: firmaInfo.zahlungsfrist || 14,
  };

  const doc = new PDFDocument({ margin: 50 });

  // Stream direkt an HTTP-Response senden
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename=${docData.doc_number}.pdf`);
  doc.pipe(res);

  // Kopfzeile / Absender
  doc.fontSize(18).text(firma.name.toUpperCase(), { align: 'right' });
  doc.fontSize(9).text(`${firma.strasse}, ${firma.plzOrt}  |  Tel: ${firma.tel}`, { align: 'right' });
  doc.fontSize(8).text(firma.slogan, { align: 'right' });
  doc.moveDown(2);

  // Empfänger
  doc.fontSize(10).text(customerData.company_name || customerData.contact_person);
  doc.text(customerData.address);
  doc.moveDown(2);

  // Titel & Dokumentnummer
  const title = docData.doc_type === 'OFFER' ? 'Angebot' : 'Rechnung';
  doc.fontSize(16).text(`${title} Nr. ${docData.doc_number}`, { underline: true });
  doc.fontSize(10).text(`Datum: ${new Date(docData.created_at).toLocaleDateString('de-DE')}`);
  doc.moveDown(1.5);

  // Positionstabelle
  doc.text('Pos. | Beschreibung | Menge | Einzelpreis | Gesamtpreis', { bold: true });
  doc.text('--------------------------------------------------------------------------------');

  items.forEach((item, idx) => {
    doc.text(
      `${idx + 1}. ${item.description} | ${item.quantity} ${item.unit} | ` +
      `${item.unit_price.toLocaleString('de-DE', { style: 'currency', currency: 'EUR' })} | ` +
      `${item.total_price.toLocaleString('de-DE', { style: 'currency', currency: 'EUR' })}`
    );
  });

  doc.moveDown(2);
  doc.text('--------------------------------------------------------------------------------');
  doc.text(`Nettobetrag: ${docData.subtotal.toLocaleString('de-DE', { style: 'currency', currency: 'EUR' })}`, { align: 'right' });
  doc.text(`zzgl. ${docData.tax_rate}% MwSt.: ${docData.tax_amount.toLocaleString('de-DE', { style: 'currency', currency: 'EUR' })}`, { align: 'right' });
  doc.fontSize(12).text(`Gesamtbetrag (Brutto): ${docData.total_amount.toLocaleString('de-DE', { style: 'currency', currency: 'EUR' })}`, { align: 'right', bold: true });

  doc.moveDown(2);
  doc.fontSize(8).text(`Bitte überweisen Sie den Betrag innerhalb von ${firma.zahlungsfrist} Tagen.`);
  doc.text(`IBAN: ${firma.iban}  –  BIC: ${firma.bic}  –  ${firma.bank}`);

  doc.end();
}

module.exports = { generateDocumentPDF };
