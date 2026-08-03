/**
 * Zentrale Firmendaten — hier einmalig anpassen.
 * Werden automatisch in alle PDFs, Druckansichten und KI-Prompts übernommen.
 */
const FIRMA = {
  name:            'Frank Gehrmann Stahl- und Metallbau GmbH',
  nameKurz:        'Gehrmann Stahl- und Metallbau',
  slogan:          'Hochwertige Handwerksarbeit zum fairen Preis.',
  strasse:         'Ratingerstr. 85',
  plzOrt:          '42279 Heiligenhaus',
  tel:             '02102 85610',
  email:           'info@metallbau-gehrmann.de',
  web:             'www.metallbau-gehrmann.de',
  iban:            'DE12 3456 7890 1234 5678 90',
  bic:             'MUBADE12',
  bank:            'Musterbank DE',
  steuernr:        'USt-IdNr.: DE123456789',
  zahlungsfrist:   14,   // Tage
  angebotsgueltig: 30,   // Tage
};

module.exports = { FIRMA };
