const PDFDocument = require('pdfkit');

function generateDocumentPDF(docData, customerData, items, res) {
  const doc = new PDFDocument({ margin: 50 });

  // Stream direkt an HTTP-Response senden
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename=${docData.doc_number}.pdf`);
  doc.pipe(res);

  // Kopfzeile / Absender Metallbau
  doc.fontSize(18).text('Metallbau Schmidt GmbH', { align: 'right' });
  doc.fontSize(9).text('Industriestraße 12, 12345 Musterstadt | Tel: 01234-56789', { align: 'right' });
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
      `${item.unit_price.toLocaleString('de-DE', {style:'currency', currency:'EUR'})} | ` +
      `${item.total_price.toLocaleString('de-DE', {style:'currency', currency:'EUR'})}`
    );
  });

  doc.moveDown(2);
  doc.text('--------------------------------------------------------------------------------');
  doc.text(`Nettobetrag: ${docData.subtotal.toLocaleString('de-DE', {style:'currency', currency:'EUR'})}`, { align: 'right' });
  doc.text(`zzgl. ${docData.tax_rate}% MwSt.: ${docData.tax_amount.toLocaleString('de-DE', {style:'currency', currency:'EUR'})}`, { align: 'right' });
  doc.fontSize(12).text(`Gesamtbetrag (Brutto): ${docData.total_amount.toLocaleString('de-DE', {style:'currency', currency:'EUR'})}`, { align: 'right', bold: true });

  doc.end();
}

module.exports = { generateDocumentPDF };
