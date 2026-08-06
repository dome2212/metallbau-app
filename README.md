# 🔩 Metallbau-App – Betriebssoftware für Metallbau Gehrmann

Eine vollständige, mobile-optimierte Betriebssoftware für einen Metallbaubetrieb. Entwickelt als Node.js-Webanwendung mit EJS-Templates und Tailwind CSS. Läuft lokal (SQLite) oder in der Cloud (PostgreSQL auf Render).

---

## 📋 Inhaltsverzeichnis

- [Features](#-features)
- [Tech-Stack](#-tech-stack)
- [Voraussetzungen](#-voraussetzungen)
- [Installation (Lokal)](#-installation-lokal)
- [Deployment (Render / Cloud)](#-deployment-render--cloud)
- [Umgebungsvariablen](#-umgebungsvariablen)
- [WhatsApp-Benachrichtigungen](#-whatsapp-benachrichtigungen-callmebot)
- [KI-Assistent](#-ki-assistent-openrouter)
- [Firmendaten anpassen](#-firmendaten-anpassen)
- [Nutzerrollen](#-nutzerrollen)
- [Projektstruktur](#-projektstruktur)
- [Seiten & Routen](#-seiten--routen)
- [Standard-Login](#-standard-login)

---

## ✨ Features

### Für alle Nutzer (Chef & Monteure)

| Bereich | Beschreibung |
|---|---|
| 🏠 **Dashboard** | Rollenspezifische Startseite – Monteur sieht Monatsübersicht & Überstunden-Ampel, Chef sieht konfigurierbare KPI-Kacheln & offene Vorgänge |
| 📢 **Schwarzes Brett** | Chef postet Nachrichten an alle Mitarbeiter – optional mit WhatsApp-Push |
| 🏗️ **Aufträge & Baustellen** | Aufträge anlegen, bearbeiten, Statusverlauf, Schnellstatus ohne Reload, Suche & Filter |
| 📅 **Kalender** | Termine eintragen & löschen, Mitarbeiter zuweisen, Wetter-Frühwarnung (Wind, Böen, Regen) pro Termin |
| ⏱️ **Zeiterfassung** | Stempeluhr mit GPS-Prüfung, Geo-Fencing je Baustelle, Baustelle wechseln ohne Ausstempeln |
| 📊 **Monatsauswertung** | Ist- vs. Soll-Stunden, Über-/Minusstunden, CSV-Export, PDF-Export, Tagesfilter |
| 🌴 **Urlaub & Abwesenheit** | Urlaubsanträge, Krankmeldungen, Schulungen, Datei-Upload, Jahresübersicht |
| 🔍 **Globale Suche** | Tastenkürzel `/` – Suche über Aufträge, Kunden, Termine und Notizen |

### Nur für Chef (ADMIN)

| Bereich | Beschreibung |
|---|---|
| ⚙️ **Dashboard-Widgets** | 6 KPI-Kacheln individuell ein-/ausblendbar, Einstellung geräteübergreifend gespeichert |
| 👥 **Mitarbeiterverwaltung** | Nutzer anlegen, Passwort ändern, löschen, Rolle verwalten, WhatsApp & Benachrichtigungen konfigurieren |
| 📋 **Arbeitszeiten-Übersicht** | Alle Stempelzeiten aller Mitarbeiter, manuelle Einträge, Löschen, PDF-Export |
| 👤 **Kunden** | Kundenverwaltung mit Kontaktdaten und verknüpften Projekten |
| 📋 **Angebote** | Angebote erstellen, Positionen hinterlegen, KI-Assistent für Positionen & Bildanalyse, in Rechnung umwandeln, PDF-Download |
| 🧾 **Rechnungen** | Rechnungen verwalten, Mahnstatus, Rechnungsnummer ändern, KI-Mahntext, PDF-Download & Druckansicht |
| 📦 **Artikelstamm** | Standardartikel und Leistungen für Angebote & Rechnungen, KI-Vorschlag |

### Je Auftrag (Projektdetailseite)

- 📐 Digitales Aufmaß (Bauteilmaße mobil erfassen)
- 🛠️ Aufgaben & Mängel mit Foto-Nachweis und Status-Toggle
- 📝 Baustellen-Notizbuch (Text + Sprachnotizen)
- 📸 Abschlussfotos (Upload via Cloudinary)
- 📁 Zeichnungen & Dokumente hochladen
- 📍 Geo-Fencing Standort mit Adresssuche (OpenStreetMap Nominatim)
- 📅 Verknüpfte Termine mit Wettervorhersage
- 📄 **Lieferschein/Stundennachweis-PDF** (Stunden, Aufmaß, Aufgaben, Notizen)
- 🧾 **Rechnung direkt aus Auftrag erstellen** (Stunden & Auftragssumme werden automatisch übernommen)

### 📱 WhatsApp-Benachrichtigungen

Automatische Push-Nachrichten bei relevanten Ereignissen – kein bezahlter Dienst, kein Account nötig:

| Ereignis | Empfänger |
|---|---|
| Neuer Urlaubsantrag gestellt | Alle Admins |
| Urlaubsstatus genehmigt / abgelehnt | Betroffener Mitarbeiter |
| Neuer Eintrag auf dem Schwarzen Brett | Alle Mitarbeiter |
| Neuer Auftrag angelegt | Alle Mitarbeiter |
| Neuer Termin mit Mitarbeiter-Zuweisung | Nur zugewiesene Mitarbeiter |

### 🤖 KI-Assistent (OpenRouter)

| Funktion | Beschreibung |
|---|---|
| **Angebots-Assistent (Text)** | Freitext-Beschreibung → KI schlägt Positionen mit Menge, Einheit & Preis vor |
| **Angebots-Assistent (Bild)** | Foto hochladen → KI analysiert Metallbau-Leistungen und schlägt Positionen vor |
| **Artikel-Vorschlag** | Beschreibung → KI schlägt Artikelbezeichnung, Einheit & Preis vor |
| **Auftragsbeschreibung** | Stichworte → KI formuliert kurze sachliche Beschreibung |
| **Mahntext** | Rechnungsdaten → KI formuliert höflichen Mahnungstext (1.–n. Mahnung) |

---

## 🛠 Tech-Stack

| Kategorie | Technologie |
|---|---|
| **Backend** | Node.js · Express.js |
| **Templates** | EJS (Embedded JavaScript) |
| **Styling** | Tailwind CSS (via CDN) |
| **Datenbank** | PostgreSQL (Produktion) · SQLite (lokal) |
| **Auth** | JWT (Cookie-basiert) · bcryptjs |
| **Datei-Upload** | Multer · Cloudinary |
| **PDF-Generierung** | PDFKit (Angebote, Rechnungen, Lieferscheine, Zeiterfassung) |
| **Kalender** | FullCalendar |
| **Wetter** | Open-Meteo API (kostenlos, kein API-Key nötig) |
| **Geocoding** | OpenStreetMap Nominatim (kostenlos, kein API-Key nötig) |
| **WhatsApp** | CallMeBot API (kostenlos, kein Account nötig) |
| **KI** | OpenRouter API (kostenlose Modelle verfügbar) |
| **Rate Limiting** | express-rate-limit (Login: 10/15min · API: 200/min) |

---

## ✅ Voraussetzungen

- **Node.js** ≥ 18
- **npm** ≥ 9
- Für die Cloud: PostgreSQL-Datenbank (z. B. auf [Render](https://render.com))
- Für Datei-Uploads: [Cloudinary](https://cloudinary.com)-Account (kostenloser Plan reicht)
- Optional: [OpenRouter](https://openrouter.ai)-Account für KI-Features (kostenlose Modelle verfügbar)

---

## 🚀 Installation (Lokal)

```bash
# 1. Repository klonen
git clone https://github.com/dome2212/metallbau-app.git
cd metallbau-app

# 2. Abhängigkeiten installieren
npm install

# 3. Umgebungsvariablen anlegen
cp .env.example .env
# → .env mit einem Texteditor öffnen und die Werte eintragen

# 4. App starten (SQLite wird automatisch angelegt)
node server.js
# oder mit Sicherheitsprüfung:
npm start

# App läuft unter: http://localhost:3000
```

---

## ☁️ Deployment (Render / Cloud)

1. Repository auf GitHub pushen
2. Neuen **Web Service** auf [Render](https://render.com) erstellen
3. Build-Befehl: `npm install`
4. Start-Befehl: `node server.js`
5. Alle [Umgebungsvariablen](#-umgebungsvariablen) in den Render-Einstellungen hinterlegen
6. Separate **PostgreSQL-Datenbank** auf Render anlegen und `DATABASE_URL` eintragen

Die App erkennt automatisch ob `DATABASE_URL` gesetzt ist und wechselt zwischen PostgreSQL und SQLite.

> **Hinweis Reverse Proxy:** Render und vergleichbare Plattformen setzen den Header `X-Forwarded-For`. Die App setzt daher `app.set('trust proxy', 1)`, damit `express-rate-limit` die echte Client-IP korrekt ausliest.

---

## 🔑 Umgebungsvariablen

Alle Variablen sind in [`.env.example`](.env.example) dokumentiert.

| Variable | Beschreibung | Pflicht |
|---|---|---|
| `DATABASE_URL` | PostgreSQL Connection-String | Prod |
| `JWT_SECRET` | Zufälliger langer String für Token-Signierung | ✅ |
| `CLOUDINARY_CLOUD_NAME` | Cloudinary Cloud-Name | Upload |
| `CLOUDINARY_API_KEY` | Cloudinary API-Key | Upload |
| `CLOUDINARY_API_SECRET` | Cloudinary API-Secret | Upload |
| `FIRM_LAT` | GPS-Breitengrad des Firmensitzes (für Stempeluhr) | Stempeluhr |
| `FIRM_LNG` | GPS-Längengrad des Firmensitzes (für Stempeluhr) | Stempeluhr |
| `FIRM_RADIUS_METERS` | Erlaubter Radius in Metern (Standard: 300) | Stempeluhr |
| `OPENROUTER_API_KEY` | API-Key für KI-Features (openrouter.ai) | KI |
| `APP_URL` | Öffentliche URL der App (für KI-Referer-Header) | KI |
| `PORT` | Server-Port (Standard: 3000) | Optional |

> ⚠️ `.env` niemals in Git committen – sie ist in `.gitignore` ausgeschlossen.

---

## 📱 WhatsApp-Benachrichtigungen (CallMeBot)

Die App nutzt [CallMeBot](https://www.callmebot.com/blog/free-api-whatsapp-messages/) – einen kostenlosen Dienst, der WhatsApp-Nachrichten ohne eigenen Account oder bezahlte API sendet.

### Einrichtung pro Mitarbeiter

1. Der Mitarbeiter schickt **einmalig** per WhatsApp eine Nachricht an **+34 644 52 74 21**:
   ```
   I allow callmebot to send me messages
   ```
2. CallMeBot antwortet mit einem persönlichen **API-Key**
3. Im Admin-Panel unter **`/admin/users`** eintragen:
   - **WhatsApp-Nummer** (z. B. `015712345678` oder `+4915712345678`)
   - **API-Key** (aus Schritt 2)
   - **Benachrichtigungen aktivieren** (Toggle einschalten)

> Kein Umgebungsvariablen nötig – API-Key und Nummer werden pro Mitarbeiter in der Datenbank gespeichert.

### Benachrichtigungssteuerung

Jeder Mitarbeiter kann im Admin-Panel einzeln aktiviert oder deaktiviert werden (`whatsapp_notify`). Nur Nutzer mit eingetragener Nummer, API-Key **und** aktiviertem Toggle erhalten Nachrichten.

---

## 🤖 KI-Assistent (OpenRouter)

Die KI-Features nutzen [OpenRouter](https://openrouter.ai) als Gateway zu verschiedenen Sprachmodellen. Kostenlose Modelle sind verfügbar.

### Einrichtung

1. Account auf [openrouter.ai](https://openrouter.ai) anlegen (kostenlos)
2. API-Key unter [openrouter.ai/keys](https://openrouter.ai/keys) erstellen
3. In der `.env` eintragen:
   ```env
   OPENROUTER_API_KEY=sk-or-v1-...
   APP_URL=https://deine-app.onrender.com
   ```

### Verwendete Modelle

| Modell | Verwendung |
|---|---|
| `nvidia/nemotron-3-ultra-550b-a55b:free` | Text-Assistent (Angebote, Artikel, Beschreibungen, Mahntexte) |
| `google/gemma-4-26b-a4b-it:free` u. a. | Bild-Analyse (Fallback-Kette bei Rate-Limit) |

> Bei Rate-Limits des Vision-Modells probiert die App automatisch das nächste Modell in der Fallback-Kette.

---

## 🏢 Firmendaten anpassen

Alle Firmendaten sind **zentral** in [`utils/firma.js`](utils/firma.js) hinterlegt:

```js
const FIRMA = {
  name:            ',
  nameKurz:        '',
  slogan:          'Hochwertige Handwerksarbeit zum fairen Preis.',
  strasse:         '',
  plzOrt:          '',
  tel:             '',
  email:           '',
  web:             '',
  iban:            'DE12 3456 7890 1234 5678 90',  // ← anpassen
  bic:             'MUBADE12',                      // ← anpassen
  bank:            'Musterbank DE',                 // ← anpassen
  steuernr:        'USt-IdNr.: DE123456789',        // ← anpassen
  zahlungsfrist:   14,   // Tage
  angebotsgueltig: 30,   // Tage
};
```

Diese Werte werden automatisch in **alle PDFs** (Angebote, Rechnungen, Lieferscheine) und die **Browser-Druckansicht** übernommen.

---

## 👤 Nutzerrollen

| Rolle | Beschreibung |
|---|---|
| `ADMIN` | Vollzugriff – Chef, sieht alle Bereiche inkl. Finanzen & Mitarbeiterverwaltung |
| `EMPLOYEE` | Monteur – sieht Aufträge, Kalender, eigene Zeiterfassung, Schwarzes Brett |

---

## 📁 Projektstruktur

```
metallbau-app/
├── server.js                    # Einstiegspunkt: Middleware, Rate-Limiting, KI-Routen, globale Suche
├── config/
│   └── database.js              # DB-Verbindung (PostgreSQL / SQLite)
├── middleware/
│   └── auth.js                  # JWT-Verifikation, requireAdmin-Guard
├── routes/
│   ├── authRoutes.js            # Login / Logout / Standard-Admin anlegen
│   ├── adminRoutes.js           # Mitarbeiterverwaltung, Zeiterfassung-Admin, Ticker, PDF
│   ├── projectRoutes.js         # Aufträge, Aufmaß, Aufgaben, Notizen, Fotos, Sketches
│   ├── customerRoutes.js        # Kunden & verknüpfte Dateien
│   ├── calendarRoutes.js        # Termine, Mitarbeiter-Zuweisung, Wetter-API
│   ├── timetrackingRoutes.js    # Stempeluhr, GPS, Geo-Fencing, Monatsauswertung
│   ├── vacationRoutes.js        # Urlaubsanträge, Status, Jahresanspruch
│   ├── documentRoutes.js        # Angebote → Rechnungen, PDFs
│   └── articleRoutes.js         # Artikelstamm
├── utils/
│   ├── db.js                    # Gemeinsame dbQuery-Hilfsfunktion (SQLite & PostgreSQL)
│   ├── firma.js                 # Zentrale Firmendaten (für PDFs & KI-Prompts)
│   └── notifier.js              # E-Mail (Nodemailer) & WhatsApp (CallMeBot)
├── views/
│   ├── partials/
│   │   ├── header.ejs           # HTML-Head, Body-Start
│   │   └── sidebar.ejs          # Navigation, Suchoverlay, Dark Mode
│   ├── dashboard.ejs            # Chef-Dashboard (KPI-Widgets, Schwarzes Brett)
│   ├── dashboard-employee.ejs   # Mitarbeiter-Dashboard (Überstunden-Ampel)
│   ├── projects.ejs             # Auftragsliste mit Filter & Schnellstatus
│   ├── project-detail.ejs       # Auftragsdetail (Aufmaß, Aufgaben, Fotos, Notizen, …)
│   ├── project-invoice-create.ejs # Rechnung aus Auftrag erstellen
│   ├── calendar.ejs             # Kalender (FullCalendar + Wetter-Frühwarnung)
│   ├── timetracking.ejs         # Stempeluhr (GPS, Geo-Fencing, Baustelle wechseln)
│   ├── admin-timetracking.ejs   # Arbeitszeiten-Übersicht (alle Mitarbeiter)
│   ├── time-monthly.ejs         # Monatliche Stundenübersicht (Mitarbeiter)
│   ├── vacations.ejs            # Urlaub & Abwesenheit
│   ├── customers.ejs            # Kundenliste
│   ├── customer-projects.ejs    # Projekte je Kunde
│   ├── admin-users.ejs          # Mitarbeiterverwaltung (inkl. WhatsApp-Einstellungen)
│   ├── invoices.ejs             # Rechnungsliste
│   ├── invoice-detail.ejs       # Rechnungsdetail (Positionen, Rechnungsnr. ändern)
│   ├── invoice-pdf.ejs          # Browser-Druckansicht Rechnung
│   ├── offers.ejs               # Angebotsliste
│   ├── documents.ejs            # Dokumentenübersicht
│   ├── articles.ejs             # Artikelstamm
│   └── login.ejs                # Login-Seite
├── Public/
│   └── (statische Dateien)
├── .env.example                 # Vorlage für Umgebungsvariablen
├── .gitignore
├── package.json
└── README.md
```

---

## 🗺 Seiten & Routen

| Route | Methode | Zugriff | Beschreibung |
|---|---|---|---|
| `/` | GET | Alle | Dashboard (rollenabhängig) |
| `/login` | GET/POST | Öffentlich | Login |
| `/logout` | GET | Alle | Abmelden |
| `/projects` | GET | Alle | Auftragsliste |
| `/projects/add` | POST | Admin | Neuen Auftrag anlegen |
| `/projects/:id` | GET | Alle | Auftragsdetail |
| `/projects/:id/pdf` | GET | Admin | Lieferschein-PDF |
| `/projects/:id/create-invoice` | GET/POST | Admin | Rechnung aus Auftrag |
| `/calendar` | GET | Alle | Terminkalender |
| `/api/appointments` | GET | Alle | Termine (JSON, für Kalender) |
| `/api/appointments/add` | POST | Alle | Termin anlegen |
| `/api/weather` | GET | Alle | Wettervorhersage (JSON) |
| `/timetracking` | GET | Alle | Stempeluhr |
| `/timetracking/stamp` | POST | Alle | Stempeln (IN / OUT / SWITCH) |
| `/admin/timetracking` | GET | Admin | Arbeitszeiten-Übersicht |
| `/admin/timetracking/pdf` | GET | Admin | Arbeitszeitennachweis-PDF |
| `/vacations` | GET | Alle | Urlaub & Abwesenheit |
| `/vacations/add` | POST | Alle | Urlaubsantrag stellen |
| `/vacations/status` | POST | Admin | Urlaub genehmigen / ablehnen |
| `/customers` | GET | Admin | Kundenverwaltung |
| `/documents/offers` | GET | Admin | Angebote |
| `/documents/invoices` | GET | Admin | Rechnungen |
| `/documents/invoices/:id` | GET | Admin | Rechnungsdetail |
| `/documents/invoices/:id/pdf` | GET | Admin | Rechnung Druckansicht |
| `/documents/invoices/:id/pdf-download` | GET | Admin | Rechnung PDF-Download |
| `/articles` | GET | Admin | Artikelstamm |
| `/admin/users` | GET | Admin | Mitarbeiterverwaltung |
| `/admin/users/set-whatsapp` | POST | Admin | WhatsApp-Daten eines Mitarbeiters setzen |
| `/admin/users/toggle-whatsapp-notify` | POST | Admin | Benachrichtigungen ein-/ausschalten |
| `/ticker/add` | POST | Admin | Schwarzes-Brett-Eintrag hinzufügen |
| `/api/search` | GET | Alle | Globale Suche (JSON) |
| `/api/ai/offer-assistant` | POST | Alle | KI: Angebotspositionen aus Text |
| `/api/ai/offer-assistant-image` | POST | Alle | KI: Angebotspositionen aus Foto |
| `/api/ai/article-suggest` | POST | Alle | KI: Artikel-Vorschlag |
| `/api/ai/project-description` | POST | Alle | KI: Auftragsbeschreibung |
| `/api/ai/payment-reminder` | POST | Alle | KI: Mahntext generieren |

---

## 🔐 Standard-Login

Nach dem ersten Start wird automatisch ein Admin-Nutzer angelegt:

| Feld | Wert |
|---|---|
| Benutzername | `chef` |
| Passwort | `chef123` |

> ⚠️ **Passwort nach dem ersten Login unbedingt ändern!**  
> In der Mitarbeiterverwaltung unter `/admin/users`.

---

## 📝 Lizenz

Privates Projekt – alle Rechte vorbehalten.  
Entwickelt von **Domenic Rosic**.
