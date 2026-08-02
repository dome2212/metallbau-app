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
| 📢 **Schwarzes Brett** | Chef postet Nachrichten an alle Mitarbeiter |
| 🏗️ **Aufträge & Baustellen** | Aufträge anlegen, bearbeiten, Statusverlauf, Schnellstatus ohne Reload, Suche & Filter |
| 📅 **Kalender** | Termine eintragen & löschen, Wetter-Frühwarnung (Wind, Böen, Regen) pro Termin |
| ⏱️ **Zeiterfassung** | Stempeluhr mit GPS-Prüfung, Geo-Fencing je Baustelle, Baustelle wechseln ohne Ausstempeln |
| 📊 **Monatsauswertung** | Ist- vs. Soll-Stunden, Über-/Minusstunden, CSV-Export, PDF-Export, Tagesfilter |
| 🌴 **Urlaub & Abwesenheit** | Urlaubsanträge, Krankmeldungen, Schulungen, Datei-Upload, Jahresübersicht |
| 🔍 **Globale Suche** | Tastenkürzel `/` – Suche über Aufträge, Kunden, Termine und Notizen |

### Nur für Chef (ADMIN)

| Bereich | Beschreibung |
|---|---|
| ⚙️ **Dashboard-Widgets** | 6 KPI-Kacheln individuell ein-/ausblendbar, Einstellung geräteübergreifend gespeichert |
| 👥 **Mitarbeiterverwaltung** | Nutzer anlegen, Passwort ändern, löschen, Rolle verwalten |
| 📋 **Arbeitszeiten-Übersicht** | Alle Stempelzeiten aller Mitarbeiter, manuelle Einträge, Löschen, PDF-Export |
| 👤 **Kunden** | Kundenverwaltung mit Kontaktdaten und verknüpften Projekten |
| 📋 **Angebote** | Angebote erstellen, Positionen hinterlegen, in Rechnung umwandeln, PDF-Download |
| 🧾 **Rechnungen** | Rechnungen verwalten, Mahnstatus, Rechnungsnummer ändern, PDF-Download & Druckansicht |
| 📦 **Artikelstamm** | Standardartikel und Leistungen für Angebote & Rechnungen |

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

---

## ✅ Voraussetzungen

- **Node.js** ≥ 18
- **npm** ≥ 9
- Für die Cloud: PostgreSQL-Datenbank (z. B. auf [Render](https://render.com))
- Für Datei-Uploads: [Cloudinary](https://cloudinary.com)-Account (kostenloser Plan reicht)

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
| `PORT` | Server-Port (Standard: 3000) | Optional |

> ⚠️ `.env` niemals in Git committen – sie ist in `.gitignore` ausgeschlossen.

---

## 🏢 Firmendaten anpassen

Alle Firmendaten (Name, Adresse, Bankverbindung, USt-Nr. usw.) sind **zentral an einer einzigen Stelle** in `server.js` hinterlegt:

```js
// server.js – Zeile ~35
const FIRMA = {
  name:            'Frank Gehrmann Stahl- und Metallbau GmbH',
  nameKurz:        'Metallbau-Gehrmann',
  slogan:          'Hochwertige Handwerksarbeit zum fairen Preis.',
  strasse:         'Ratingerstr. 85',
  plzOrt:          '42279 Heiligenhaus',
  tel:             '02102 85610',
  email:           'info@metallbau-gehrmann.de',
  web:             'www.metallbau-gehrmann.de',
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
├── server.js                    # Haupt-Anwendung (alle Routen, Middleware, PDF-Generierung)
├── config/
│   └── database.js              # DB-Verbindung (PostgreSQL / SQLite), Tabellen-Setup
├── middleware/
│   └── auth.js                  # JWT-Verifikation, requireAdmin-Guard
├── routes/
│   ├── authRoutes.js            # Login / Logout / Standard-Admin anlegen
│   └── documentRoutes.js        # Angebot → Projekt, Angebot → Rechnung (alte Dokumente-API)
├── utils/
│   └── notifier.js              # E-Mail & WhatsApp Benachrichtigungen (optional)
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
│   ├── admin-users.ejs          # Mitarbeiterverwaltung
│   ├── invoices.ejs             # Rechnungsliste
│   ├── invoice-detail.ejs       # Rechnungsdetail (Positionen, Rechnungsnr. ändern)
│   ├── invoice-pdf.ejs          # Browser-Druckansicht Rechnung
│   ├── offers.ejs               # Angebotsliste
│   ├── documents.ejs            # Dokumentenübersicht (ältere API)
│   ├── articles.ejs             # Artikelstamm
│   └── login.ejs                # Login-Seite
├── Public/
│   └── (statische Dateien)
├── .env.example                 # Vorlage für Umgebungsvariablen
├── .gitignore
├── package.json
└── README.md
```

> **Hinweis:** Die meisten Routen sind direkt in `server.js` implementiert. `routes/authRoutes.js` und `routes/documentRoutes.js` werden als Express-Router eingebunden.

---

## 🗺 Seiten & Routen

| Route | Methode | Zugriff | Beschreibung |
|---|---|---|---|
| `/` | GET | Alle | Dashboard (rollenabhängig) |
| `/login` | GET/POST | Öffentlich | Login |
| `/logout` | GET | Alle | Abmelden |
| `/projects` | GET | Alle | Auftragsliste |
| `/projects/:id` | GET | Alle | Auftragsdetail |
| `/projects/:id/pdf` | GET | Admin | Lieferschein-PDF |
| `/projects/:id/create-invoice` | GET | Admin | Rechnungsvorschau aus Auftrag |
| `/projects/:id/create-invoice` | POST | Admin | Rechnung aus Auftrag speichern |
| `/calendar` | GET | Alle | Terminkalender |
| `/timetracking` | GET | Alle | Stempeluhr |
| `/timetracking/stamp` | POST | Alle | Stempeln (IN / OUT / SWITCH) |
| `/admin/timetracking` | GET | Admin | Arbeitszeiten-Übersicht |
| `/admin/timetracking/pdf` | GET | Admin | Arbeitszeitennachweis-PDF |
| `/vacations` | GET | Alle | Urlaub & Abwesenheit |
| `/customers` | GET | Admin | Kundenverwaltung |
| `/documents/offers` | GET | Admin | Angebote |
| `/documents/invoices` | GET | Admin | Rechnungen |
| `/documents/invoices/:id` | GET | Admin | Rechnungsdetail |
| `/documents/invoices/:id/pdf` | GET | Admin | Rechnung Druckansicht |
| `/documents/invoices/:id/pdf-download` | GET | Admin | Rechnung PDF-Download |
| `/articles` | GET | Admin | Artikelstamm |
| `/admin/users` | GET | Admin | Mitarbeiterverwaltung |
| `/api/search` | GET | Alle | Globale Suche (JSON) |
| `/api/appointments` | GET | Alle | Termine (JSON, für Kalender) |
| `/api/weather` | GET | Alle | Wettervorhersage (JSON) |

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
