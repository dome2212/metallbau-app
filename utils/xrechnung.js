/**
 * Erzeugt eine XRechnung 3.0 (UBL Invoice) als XML-String.
 * Für den Versand an öffentliche Auftraggeber / E-Rechnungs-Portale.
 */
function escapeXml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtAmount(n) {
  return Number(n || 0).toFixed(2);
}

function fmtDate(d) {
  if (!d) return new Date().toISOString().slice(0, 10);
  try {
    return new Date(d).toISOString().slice(0, 10);
  } catch {
    return String(d).slice(0, 10);
  }
}

/**
 * @param {object} opts
 * @param {object} opts.invoice  - documents row (+ invoice_number)
 * @param {Array}  opts.items    - document_items
 * @param {object} opts.customer - customer row
 * @param {object} opts.firma    - company settings
 */
function buildXRechnungXml({ invoice, items, customer, firma }) {
  const docNr = invoice.invoice_number || invoice.doc_number || String(invoice.id);
  const issueDate = fmtDate(invoice.created_at);
  const dueDate = fmtDate(invoice.due_date || invoice.created_at);
  const currency = 'EUR';
  const taxRate = parseFloat(invoice.tax_rate != null ? invoice.tax_rate : (firma.default_tax_rate || 19)) || 19;

  let lineNet = 0;
  const lines = (items || []).map((it, idx) => {
    const qty = parseFloat(it.quantity) || 0;
    const price = parseFloat(it.price) || 0;
    const line = qty * price;
    lineNet += line;
    const lineId = idx + 1;
    return `
    <cac:InvoiceLine>
      <cbc:ID>${lineId}</cbc:ID>
      <cbc:InvoicedQuantity unitCode="C62">${fmtAmount(qty)}</cbc:InvoicedQuantity>
      <cbc:LineExtensionAmount currencyID="${currency}">${fmtAmount(line)}</cbc:LineExtensionAmount>
      <cac:Item>
        <cbc:Description>${escapeXml(it.description || 'Position')}</cbc:Description>
        <cbc:Name>${escapeXml((it.description || 'Position').slice(0, 100))}</cbc:Name>
        <cac:ClassifiedTaxCategory>
          <cbc:ID>S</cbc:ID>
          <cbc:Percent>${fmtAmount(taxRate)}</cbc:Percent>
          <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>
        </cac:ClassifiedTaxCategory>
      </cac:Item>
      <cac:Price>
        <cbc:PriceAmount currencyID="${currency}">${fmtAmount(price)}</cbc:PriceAmount>
      </cac:Price>
    </cac:InvoiceLine>`;
  }).join('');

  const subtotal = parseFloat(invoice.subtotal) || lineNet;
  const taxAmount = parseFloat(invoice.tax_amount) || (subtotal * taxRate / 100);
  const total = parseFloat(invoice.total_amount) || (subtotal + taxAmount);

  const sellerName = firma.name || firma.nameKurz || 'Firma';
  const sellerStreet = firma.street || '';
  const sellerZip = firma.zip || '';
  const sellerCity = firma.city || '';
  const sellerCountry = 'DE';
  const sellerVat = (firma.steuernr || '').replace(/.*?(DE\d{9}).*/i, '$1') || firma.ust_id || 'DE000000000';
  const sellerIban = (firma.iban || '').replace(/\s+/g, '');
  const sellerEmail = firma.email || '';

  const buyerName = customer.company_name || customer.contact_person || 'Kunde';
  const buyerStreet = customer.street || '';
  const buyerZip = customer.zip || '';
  const buyerCity = customer.city || '';
  const buyerEmail = customer.email || '';
  const buyerVat = customer.ust_id || '';
  const leitweg = customer.leitweg_id || buyerVat || '9999999999999'; // Fallback Leitweg-ID

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"
  xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
  xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
  <cbc:CustomizationID>urn:cen.eu:en16931:2017#compliant#urn:xeinkauf.de:kosit:xrechnung_3.0</cbc:CustomizationID>
  <cbc:ProfileID>urn:fdc:peppol.eu:2017:poacc:billing:01:1.0</cbc:ProfileID>
  <cbc:ID>${escapeXml(docNr)}</cbc:ID>
  <cbc:IssueDate>${issueDate}</cbc:IssueDate>
  <cbc:DueDate>${dueDate}</cbc:DueDate>
  <cbc:InvoiceTypeCode>380</cbc:InvoiceTypeCode>
  <cbc:DocumentCurrencyCode>${currency}</cbc:DocumentCurrencyCode>
  <cbc:BuyerReference>${escapeXml(leitweg)}</cbc:BuyerReference>
  <cac:AccountingSupplierParty>
    <cac:Party>
      <cac:PartyName><cbc:Name>${escapeXml(sellerName)}</cbc:Name></cac:PartyName>
      <cac:PostalAddress>
        <cbc:StreetName>${escapeXml(sellerStreet)}</cbc:StreetName>
        <cbc:CityName>${escapeXml(sellerCity)}</cbc:CityName>
        <cbc:PostalZone>${escapeXml(sellerZip)}</cbc:PostalZone>
        <cac:Country><cbc:IdentificationCode>${sellerCountry}</cbc:IdentificationCode></cac:Country>
      </cac:PostalAddress>
      <cac:PartyTaxScheme>
        <cbc:CompanyID>${escapeXml(sellerVat)}</cbc:CompanyID>
        <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>
      </cac:PartyTaxScheme>
      <cac:PartyLegalEntity>
        <cbc:RegistrationName>${escapeXml(sellerName)}</cbc:RegistrationName>
      </cac:PartyLegalEntity>
      <cac:Contact>
        <cbc:ElectronicMail>${escapeXml(sellerEmail)}</cbc:ElectronicMail>
      </cac:Contact>
    </cac:Party>
  </cac:AccountingSupplierParty>
  <cac:AccountingCustomerParty>
    <cac:Party>
      <cac:PartyName><cbc:Name>${escapeXml(buyerName)}</cbc:Name></cac:PartyName>
      <cac:PostalAddress>
        <cbc:StreetName>${escapeXml(buyerStreet)}</cbc:StreetName>
        <cbc:CityName>${escapeXml(buyerCity)}</cbc:CityName>
        <cbc:PostalZone>${escapeXml(buyerZip)}</cbc:PostalZone>
        <cac:Country><cbc:IdentificationCode>DE</cbc:IdentificationCode></cac:Country>
      </cac:PostalAddress>
      ${buyerVat ? `<cac:PartyTaxScheme>
        <cbc:CompanyID>${escapeXml(buyerVat)}</cbc:CompanyID>
        <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>
      </cac:PartyTaxScheme>` : ''}
      <cac:PartyLegalEntity>
        <cbc:RegistrationName>${escapeXml(buyerName)}</cbc:RegistrationName>
      </cac:PartyLegalEntity>
      ${buyerEmail ? `<cac:Contact><cbc:ElectronicMail>${escapeXml(buyerEmail)}</cbc:ElectronicMail></cac:Contact>` : ''}
    </cac:Party>
  </cac:AccountingCustomerParty>
  ${sellerIban ? `<cac:PaymentMeans>
    <cbc:PaymentMeansCode>58</cbc:PaymentMeansCode>
    <cac:PayeeFinancialAccount>
      <cbc:ID>${escapeXml(sellerIban)}</cbc:ID>
    </cac:PayeeFinancialAccount>
  </cac:PaymentMeans>` : ''}
  <cac:TaxTotal>
    <cbc:TaxAmount currencyID="${currency}">${fmtAmount(taxAmount)}</cbc:TaxAmount>
    <cac:TaxSubtotal>
      <cbc:TaxableAmount currencyID="${currency}">${fmtAmount(subtotal)}</cbc:TaxableAmount>
      <cbc:TaxAmount currencyID="${currency}">${fmtAmount(taxAmount)}</cbc:TaxAmount>
      <cac:TaxCategory>
        <cbc:ID>S</cbc:ID>
        <cbc:Percent>${fmtAmount(taxRate)}</cbc:Percent>
        <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>
      </cac:TaxCategory>
    </cac:TaxSubtotal>
  </cac:TaxTotal>
  <cac:LegalMonetaryTotal>
    <cbc:LineExtensionAmount currencyID="${currency}">${fmtAmount(subtotal)}</cbc:LineExtensionAmount>
    <cbc:TaxExclusiveAmount currencyID="${currency}">${fmtAmount(subtotal)}</cbc:TaxExclusiveAmount>
    <cbc:TaxInclusiveAmount currencyID="${currency}">${fmtAmount(total)}</cbc:TaxInclusiveAmount>
    <cbc:PayableAmount currencyID="${currency}">${fmtAmount(total)}</cbc:PayableAmount>
  </cac:LegalMonetaryTotal>
  ${lines}
</Invoice>
`;
  return xml.trim() + '\n';
}

/**
 * Prüft, ob die Pflichtangaben für eine praxistaugliche XRechnung vorhanden sind.
 * @returns {{ ok: boolean, errors: string[], warnings: string[] }}
 */
function validateXRechnung({ invoice, items, customer, firma }) {
  const errors = [];
  const warnings = [];

  const sellerName = firma && (firma.name || firma.nameKurz);
  if (!sellerName) errors.push('Firmenname fehlt in den Firmeneinstellungen');
  const sellerVat = ((firma && (firma.steuernr || firma.ust_id)) || '').toString();
  if (!/DE\d{9}/i.test(sellerVat) && !(firma && firma.ust_id)) {
    warnings.push('USt-IdNr. der Firma prüfen (Format DE123456789)');
  }
  if (!(firma && firma.iban)) warnings.push('IBAN der Firma fehlt (Zahlungsinformationen)');
  if (!(firma && (firma.street || firma.city))) warnings.push('Adresse der Firma unvollständig');

  const buyerName = customer && (customer.company_name || customer.contact_person);
  if (!buyerName) errors.push('Kundenname fehlt');
  if (!(customer && (customer.street || customer.city))) warnings.push('Kundenadresse unvollständig');

  const leitweg = (customer && (customer.leitweg_id || '')).toString().trim();
  if (!leitweg) {
    errors.push('Leitweg-ID des Kunden fehlt (Pflicht bei öffentlicher Hand / vielen Portalen)');
  }

  if (!(items && items.length)) errors.push('Keine Rechnungspositionen');
  if (!invoice || !(invoice.doc_number || invoice.invoice_number)) errors.push('Rechnungsnummer fehlt');

  return { ok: errors.length === 0, errors, warnings };
}

module.exports = { buildXRechnungXml, validateXRechnung };
