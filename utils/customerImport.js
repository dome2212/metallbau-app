/**
 * Kunden-Import aus CSV / Excel
 * Erwartete Spalten (deutsch oder englisch, Groß/Klein egal):
 *   Firma / company_name / Name
 *   Ansprechpartner / contact_person
 *   E-Mail / email
 *   Telefon / phone / mobil
 *   Straße / street / Adresse
 *   PLZ / zip / postal_code
 *   Ort / city
 *   Kundennummer / customer_number / KdNr
 *   USt-IdNr / ust_id / vat_id
 *   Leitweg-ID / leitweg_id
 *   Notizen / notes
 */

const FIELD_ALIASES = {
  company_name: ['firma', 'company_name', 'company', 'name', 'kundenname', 'firmenname', 'organisation', 'kunde'],
  contact_person: ['ansprechpartner', 'contact_person', 'contact', 'kontakt', 'ansprechpartner_name', 'person'],
  email: ['email', 'e-mail', 'e_mail', 'mail'],
  phone: ['telefon', 'phone', 'tel', 'mobil', 'handy', 'mobile', 'fon'],
  street: ['strasse', 'straße', 'street', 'adresse', 'address', 'anschrift'],
  zip: ['plz', 'zip', 'postal_code', 'postleitzahl'],
  city: ['ort', 'city', 'stadt', 'wohnort'],
  customer_number: ['kundennummer', 'customer_number', 'kdnr', 'kd_nr', 'kundenr', 'nummer', 'nr'],
  ust_id: ['ust_id', 'ustid', 'ust-idnr', 'ust id', 'vat_id', 'vat', 'umsatzsteuer'],
  leitweg_id: ['leitweg_id', 'leitweg', 'leitweg-id', 'xrechnung'],
  notes: ['notizen', 'notes', 'bemerkung', 'bemerkungen', 'kommentar', 'info'],
};

function normalizeHeader(h) {
  return String(h || '')
    .replace(/^\uFEFF/, '')
    .trim()
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
}

function mapHeaders(headers) {
  const mapping = {};
  const normalized = headers.map(normalizeHeader);
  for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
    for (let i = 0; i < normalized.length; i++) {
      if (aliases.includes(normalized[i])) {
        mapping[field] = i;
        break;
      }
    }
  }
  return mapping;
}

function parseCsv(text) {
  const raw = String(text || '').replace(/^\uFEFF/, '');
  if (!raw.trim()) return { headers: [], rows: [] };

  // Delimiter: ; or ,
  const firstLine = raw.split(/\r?\n/).find(l => l.trim()) || '';
  const delim = (firstLine.split(';').length > firstLine.split(',').length) ? ';' : ',';

  const lines = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === '"') {
      if (inQuotes && raw[i + 1] === '"') { cur += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if ((ch === '\n' || ch === '\r') && !inQuotes) {
      if (ch === '\r' && raw[i + 1] === '\n') i++;
      lines.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur.length) lines.push(cur);

  function splitLine(line) {
    const cells = [];
    let c = '';
    let q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (q && line[i + 1] === '"') { c += '"'; i++; }
        else q = !q;
      } else if (ch === delim && !q) {
        cells.push(c.trim());
        c = '';
      } else c += ch;
    }
    cells.push(c.trim());
    return cells;
  }

  const nonEmpty = lines.filter(l => l.trim().length);
  if (!nonEmpty.length) return { headers: [], rows: [] };
  const headers = splitLine(nonEmpty[0]);
  const rows = nonEmpty.slice(1).map(splitLine);
  return { headers, rows };
}

function parseBuffer(buffer, filename) {
  const name = String(filename || '').toLowerCase();
  if (name.endsWith('.xlsx') || name.endsWith('.xls')) {
    let XLSX;
    try { XLSX = require('xlsx'); } catch (e) {
      throw new Error('Excel-Import benötigt das Paket „xlsx“. Bitte `npm install xlsx` ausführen oder die Datei als CSV speichern.');
    }
    const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const data = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: false });
    if (!data.length) return { headers: [], rows: [] };
    const headers = data[0].map(h => String(h || ''));
    const rows = data.slice(1).map(r => {
      const row = [];
      for (let i = 0; i < headers.length; i++) row.push(String(r[i] != null ? r[i] : '').trim());
      return row;
    });
    return { headers, rows };
  }
  // CSV / TXT
  return parseCsv(buffer.toString('utf8'));
}

function rowsToCustomers(headers, rows) {
  const map = mapHeaders(headers);
  if (map.company_name === undefined && map.contact_person === undefined && map.customer_number === undefined) {
    throw new Error('Keine erkennbaren Spalten. Mindestens Firma, Name oder Kundennummer nötig. Gefunden: ' + headers.join(', '));
  }

  const customers = [];
  for (const cells of rows) {
    const get = (field) => {
      const idx = map[field];
      if (idx === undefined) return null;
      const v = cells[idx];
      if (v == null) return null;
      const s = String(v).trim();
      return s || null;
    };
    const company_name = get('company_name');
    const contact_person = get('contact_person');
    const customer_number = get('customer_number');
    if (!company_name && !contact_person && !customer_number) continue;

    customers.push({
      company_name: company_name || contact_person || ('Kunde ' + (customer_number || '')),
      contact_person,
      email: get('email'),
      phone: get('phone'),
      street: get('street'),
      zip: get('zip'),
      city: get('city'),
      customer_number,
      ust_id: get('ust_id'),
      leitweg_id: get('leitweg_id'),
      notes: get('notes'),
    });
  }
  return { customers, mapping: map, headers };
}

function buildTemplateCsv() {
  const header = 'Firma;Ansprechpartner;E-Mail;Telefon;Straße;PLZ;Ort;Kundennummer;USt-IdNr;Leitweg-ID;Notizen';
  const example = 'Muster Metall GmbH;Max Mustermann;max@muster.de;0211 123456;Musterstr. 1;40210;Düsseldorf;K-1001;DE123456789;;Stammkunde';
  return header + '\r\n' + example + '\r\n';
}

module.exports = {
  parseBuffer,
  rowsToCustomers,
  mapHeaders,
  buildTemplateCsv,
  FIELD_ALIASES,
};
