/**
 * DATEV-Export für Rechnungen (Buchungsstapel, EXTF-Format)
 * ----------------------------------------------------------
 * Erzeugt eine CSV-Datei im DATEV-Format "EXTF" (Kategorie 21, Buchungsstapel),
 * die sich direkt in DATEV Kanzlei-Rechnungswesen bzw. von jedem Steuerberater
 * importieren lässt.
 *
 * Wichtig: Die exakten Erlös- und Debitorenkonten hängen vom individuellen
 * Kontenrahmen (SKR03/SKR04) und der Kontenzuordnung beim Steuerberater ab.
 * Diese Werte werden daher aus den Firmeneinstellungen (DATEV-Tab) gelesen –
 * die Standardwerte (8400/4400 für 19%, 8300/4300 für 7%) sind übliche
 * SKR03/SKR04-Werte, sollten aber vor dem ersten Import mit dem
 * Steuerberater abgeglichen werden.
 */

// Feste Debitoren-Kontonummer pro Kunde: Basis-Konto + Kundennummer.
// Ist keine Kundennummer hinterlegt, wird sie aus der internen Kunden-ID abgeleitet.
function debitorenKonto(customer, basis) {
  const base = parseInt(basis, 10) || 10000;
  const num  = (customer.customer_number || '').toString().trim();
  if (num && /^\d+$/.test(num)) return String(base + parseInt(num, 10));
  return String(base + (customer.customer_id || customer.id || 0));
}

// Betrag im DATEV-Format: Punkt als Tausender wird entfernt, Komma als Dezimaltrennzeichen, immer 2 Nachkommastellen, ohne Vorzeichen.
function formatBetrag(value) {
  const n = Math.abs(parseFloat(value) || 0);
  return n.toFixed(2).replace('.', ',');
}

// Datum im DATEV-Format TTMM (Belegdatum im laufenden Wirtschaftsjahr, ohne Jahr).
function formatBelegdatum(dateInput) {
  const d = new Date(dateInput);
  const tt = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${tt}${mm}`;
}

function formatDatumJJJJMMTT(dateInput) {
  const d = new Date(dateInput);
  const jjjj = d.getFullYear();
  const mm   = String(d.getMonth() + 1).padStart(2, '0');
  const tt   = String(d.getDate()).padStart(2, '0');
  return `${jjjj}${mm}${tt}`;
}

// CSV-Feld nach DATEV-Regeln in Anführungszeichen setzen (Text-Felder) bzw. unverändert lassen (Zahlen).
function csvText(value) {
  const s = (value ?? '').toString().replace(/"/g, "'");
  return `"${s}"`;
}

/**
 * Erzeugt den vollständigen DATEV-CSV-Inhalt (als String) für einen Satz Rechnungen.
 * @param {Array} invoices - Rechnungen (documents mit doc_type='INVOICE'), inkl. Kundendaten (join)
 * @param {Object} firma - Firmeneinstellungen (getFirma())
 * @param {Object} range - { von: 'YYYY-MM-DD', bis: 'YYYY-MM-DD' }
 * @returns {string} CSV-Inhalt (CRLF-Zeilenumbrüche, wie von DATEV gefordert)
 */
function buildDatevCsv(invoices, firma, range) {
  const beraterNr   = firma.datev_berater_nr   || '1001';
  const mandantNr   = firma.datev_mandanten_nr || '1';
  const sachkontenLen = parseInt(firma.datev_sachkontenlaenge || '4', 10);
  const wjBeginn    = firma.datev_wj_beginn || '0101';
  const debitorenBasis = firma.datev_debitoren_basis || '10000';

  const erloeskonto = (taxRate) => {
    const rate = parseFloat(taxRate);
    if (rate === 19) return firma.datev_erloeskonto_19 || '8400';
    if (rate === 7)  return firma.datev_erloeskonto_7  || '8300';
    return firma.datev_erloeskonto_0 || '8200';
  };

  const buSchluessel = (taxRate) => {
    const rate = parseFloat(taxRate);
    if (rate === 19) return '3';   // Standard-BU-Schlüssel USt. 19% (SKR03/04)
    if (rate === 7)  return '2';   // Standard-BU-Schlüssel USt. 7%
    return '';                      // steuerfrei: kein BU-Schlüssel
  };

  const heute = formatDatumJJJJMMTT(new Date());
  const vonD  = formatDatumJJJJMMTT(range.von);
  const bisD  = formatDatumJJJJMMTT(range.bis);

  // ── Kopfzeile 1: Metadaten (fest vorgeschriebene Reihenfolge lt. DATEV-Format) ──
  const header1 = [
    'EXTF', '700', '21', csvText('Buchungsstapel'), '7', heute, '',
    csvText('RE'), csvText('MetallbauApp'), beraterNr, mandantNr,
    wjBeginn, sachkontenLen, vonD, bisD, csvText(''), csvText(''),
    '0', '0', csvText('EUR'), '', '', csvText(''), '0'
  ].join(';');

  // ── Kopfzeile 2: Spaltenüberschriften ──
  const columns = [
    'Umsatz (ohne Soll/Haben-Kz)', 'Soll/Haben-Kennzeichen', 'WKZ Umsatz', 'Kurs',
    'Basis-Umsatz', 'WKZ Basis-Umsatz', 'Konto', 'Gegenkonto (ohne BU-Schlüssel)',
    'BU-Schlüssel', 'Belegdatum', 'Belegfeld 1', 'Belegfeld 2', 'Skonto', 'Buchungstext'
  ];
  const header2 = columns.map(csvText).join(';');

  // ── Datenzeilen: eine Buchungszeile pro Rechnung (Bruttobuchung auf Debitorenkonto) ──
  const rows = invoices.map(inv => {
    const konto        = debitorenKonto(inv, debitorenBasis);
    const gegenkonto    = erloeskonto(inv.tax_rate);
    const bu           = buSchluessel(inv.tax_rate);
    const belegdatum   = formatBelegdatum(inv.created_at);
    const belegfeld1   = (inv.invoice_number || inv.doc_number || '').toString();
    const buchungstext = (inv.company_name || inv.contact_person || 'Kunde').toString();

    return [
      formatBetrag(inv.total_amount),   // Umsatz (Brutto)
      'S',                              // Soll (Debitor wird belastet)
      'EUR',
      '', '', '',
      konto,
      gegenkonto,
      bu,
      belegdatum,
      csvText(belegfeld1),
      '',
      '',
      csvText(buchungstext)
    ].join(';');
  });

  const allLines = [header1, header2, ...rows];
  return allLines.join('\r\n') + '\r\n';
}

module.exports = { buildDatevCsv, debitorenKonto };
