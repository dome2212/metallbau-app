const db = require('./config/database');

const initialArticles = [
  // Rohre & Profile (Stahl / Edelstahl)
  { title: 'Stahlrohr quadratisch 40x40x3 mm', unit: 'm', unit_price: 12.50, description: 'S235JR, blank / schwarz' },
  { title: 'Stahlrohr rechteckig 80x40x4 mm', unit: 'm', unit_price: 18.90, description: 'S235JR für tragende Konstruktionen' },
  { title: 'Edelstahlrohr rund 42,4x2 mm', unit: 'm', unit_price: 24.00, description: 'V2A geschliffen Korn 240, Geländerbau' },
  { title: 'Flachstahl 40x8 mm', unit: 'm', unit_price: 6.20, description: 'S235JR gewalzt' },
  { title: 'Winkelstahl 50x50x5 mm', unit: 'm', unit_price: 9.80, description: 'Equal angle steel' },
  { title: 'U-Profil UPN 100', unit: 'm', unit_price: 28.50, description: 'Trägerprofil' },

  // Bleche
  { title: 'Tränenblech Stahl 3/5 mm', unit: 'm²', unit_price: 65.00, description: 'Riffelblech für Podeste und Rampen' },
  { title: 'Edelstahltischlerplatte / Glattblech V2A 2 mm', unit: 'm²', unit_price: 85.00, description: 'Korn 240 einseitig foliert' },
  { title: 'Aluminium Lochblech RV 5-8', unit: 'm²', unit_price: 72.00, description: 'Für Verkleidungen und Füllungen' },

  // Kleinteile & Zubehör
  { title: 'Zylinderschraube M8x30', unit: 'Stk', unit_price: 0.35, description: 'A2 Edelstahl DIN 912' },
  { title: 'Ankerbolze M12x100', unit: 'Stk', unit_price: 2.10, description: 'Schwerlastbefestigung galvanisch verzinkt' },
  { title: 'Korn 240 Schleifband 50x3500 mm', unit: 'Stk', unit_price: 14.50, description: 'Für Edelstahlbearbeitung' },
  { title: 'MAG Schweißdraht SG2 (15kg Spule)', unit: 'Stk', unit_price: 45.00, description: 'G3Si1 / ER70S-6' },

  // Arbeitsstunden & Leistungen
  { title: 'Fertigungsstunde Werkstatt', unit: 'Std', unit_price: 68.00, description: 'Schweißen, Zuschneiden, Vorrichten' },
  { title: 'Montagestunde vor Ort', unit: 'Std', unit_price: 75.00, description: 'Inkl. Montagepersonal und Standard-Werkzeug' },
  { title: 'Anfahrtspauschale Baustelle', unit: 'Psch', unit_price: 85.00, description: 'Bis 30 km Umkreis, inkl. Transporter' },
  { title: 'Planung & CAD-Konstruktion', unit: 'Std', unit_price: 85.00, description: 'Erstellung von Werk- und Montageplänen' }
];

async function seedArticles() {
  try {
    console.log('Starte das Einfügen der Standard-Metallbau-Artikel...');

    for (const article of initialArticles) {
      const queryText = `INSERT INTO articles (title, unit, unit_price, description) VALUES (?, ?, ?, ?)`;
      
      // Hier wurde der Kommentar entfernt, damit die Artikel tatsächlich in die Datenbank geschrieben werden:
      await dbQuery(queryText, [article.title, article.unit, article.unit_price, article.description]);
    }

    console.log('Alle Artikel wurden erfolgreich hinzugefügt!');
  } catch (err) {
    console.error('Fehler beim Seeden der Artikel:', err.message);
  }
}

module.exports = seedArticles;
