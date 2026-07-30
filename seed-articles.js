const db = require('./config/database');

const initialArticles = [
  // --- BAUSTAHL (S235JR / S355) ---
  {
    title: 'Quadratrohr 40x40x3 mm S235',
    unit: 'm',
    unit_price: 8.20,
    description: 'Hohlprofil Stahl blank / S235JR'
  },
  {
    title: 'Rechteckrohr 60x40x3 mm S235',
    unit: 'm',
    unit_price: 11.50,
    description: 'Hohlprofil Stahl blank / S235JR'
  },
  {
    title: 'Flachstahl 40x8 mm S235',
    unit: 'm',
    unit_price: 6.50,
    description: 'Flachstahl nach DIN EN 10058 / S235JR'
  },
  {
    title: 'Winkelstahl 40x40x4 mm S235',
    unit: 'm',
    unit_price: 5.80,
    description: 'Gleichschenkliger Winkelstahl / S235JR'
  },
  {
    title: 'Rundrohr 42.4x3.2 mm (1 1/4") S235',
    unit: 'm',
    unit_price: 9.80,
    description: 'Gewinderohr / Siederohr S235JR'
  },
  {
    title: 'Stahlblech 2.0 mm S235JR',
    unit: 'm²',
    unit_price: 38.00,
    description: 'Feinblech DC01 / S235JR blank'
  },
  {
    title: 'Tränenblech 3/4.5 mm Duett S235',
    unit: 'm²',
    unit_price: 52.00,
    description: 'Riffelblech / Rutschhemmend'
  },
  {
    title: 'Träger HEB 100 S235JR',
    unit: 'm',
    unit_price: 32.00,
    description: 'Breitflanschträger / S235JR'
  },

  // --- EDELSTAHL (V2A / V4A) ---
  {
    title: 'Edelstahl Rohr 42.4x2.0 mm V2A',
    unit: 'm',
    unit_price: 18.50,
    description: 'Geschliffen K240 (1.4301) - Standard Geländerrohr'
  },
  {
    title: 'Edelstahl Quadratrohr 40x40x2.0 mm V2A',
    unit: 'm',
    unit_price: 22.00,
    description: 'Geschliffen K240 (1.4301)'
  },
  {
    title: 'Edelstahl Vollgut Rund 12 mm V2A',
    unit: 'm',
    unit_price: 7.90,
    description: 'Blank gezogen h9 (1.4301) - Füllstäbe'
  },
  {
    title: 'Edelstahl Flach 40x8 mm V2A',
    unit: 'm',
    unit_price: 16.50,
    description: 'Geschliffen K240 (1.4301)'
  },
  {
    title: 'Edelstahl Blech 1.5 mm V2A (1.4301)',
    unit: 'm²',
    unit_price: 75.00,
    description: 'Einseitig geschliffen mit Schutzfolie'
  },
  {
    title: 'Edelstahl Blech 2.0 mm V4A (1.4571)',
    unit: 'm²',
    unit_price: 110.00,
    description: 'Säure- und chlorbeständig (V4A)'
  }
];

console.log('🔄 Starte Befüllung des Artikelstamms...');

let addedCount = 0;
let skippedCount = 0;

initialArticles.forEach((article, index) => {
  // Prüfen, ob Artikel mit demselben Namen bereits existiert
  db.get('SELECT id FROM articles WHERE title = ?', [article.title], (err, row) => {
    if (err) {
      console.error(`❌ Fehler bei Prüfung von "${article.title}":`, err.message);
    } else if (row) {
      skippedCount++;
    } else {
      // Artikel einfügen
      const sql = `INSERT INTO articles (title, unit, unit_price, description) VALUES (?, ?, ?, ?)`;
      db.run(sql, [article.title, article.unit, article.unit_price, article.description], (insertErr) => {
        if (insertErr) {
          console.error(`❌ Fehler beim Einfügen von "${article.title}":`, insertErr.message);
        } else {
          addedCount++;
        }
      });
    }

    // Wenn alle Elemente verarbeitet wurden, Zusammenfassung anzeigen
    if (index === initialArticles.length - 1) {
      setTimeout(() => {
        console.log(`\n==================================================`);
        console.log(`✅ Artikelstamm erfolgreich aktualisiert!`);
        console.log(`➕ Neu hinzugefügt: ${addedCount}`);
        console.log(`⏩ Übersprungen (bereits vorhanden): ${skippedCount}`);
        console.log(`==================================================\n`);
        process.exit();
      }, 500);
    }
  });
});