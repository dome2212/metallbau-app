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
- [Nutzerrollen](#-nutzerrollen)
- [Projektstruktur](#-projektstruktur)
- [Seiten & Routen](#-seiten--routen)
- [Standard-Login](#-standard-login)

---

## ✨ Features

### Für alle Nutzer (Chef & Monteure)

| Bereich | Beschreibung |
|---|---|
| 🏠 **Dashboard** | Rollenspezifische Startseite – Monteur sieht Monatsübersicht & Überstunden-Ampel, Chef sieht konfigurierbare KPI-Kacheln (6 Widgets, DB-gespeichert) & offene Vorgänge |
| 📢 **Schwarzes Brett** | Chef postet Nachrichten an alle Mitarbeiter, Monteure lesen sie auf ihrer Startseite |
| 🏗️ **Aufträge & Baustellen** | Aufträge anlegen, bearbeiten, Statusverlauf (In Planung → Abgeschlossen), Schnellstatus-Änderung ohne Seitenreload, Suche & Statusfilter, Auftragssumme (nur Chef) |
| 📅 **Kalender** | Termine eintragen & löschen, Wetter-Frühwarnung (Wind, Böen, Regen) für jeden Termin |
| ⏱️ **Zeiterfassung** | Stempeluhr (Ein-/Ausstempeln), GPS-Standortprüfung, Geofencing je Baustelle, Kunden-Zuordnung |
| 📊 **Monatsauswertung** | Ist- vs. Soll-Stunden, Über-/Minusstunden, CSV-Export, Tagesfilter – zusammengeführt in einer Ansicht |
| 🌴 **Urlaub & Abwesenheit** | Urlaubsanträge, Krankmeldungen, Schulungen, Datei-Upload, Jahresübersicht mit Fortschrittsbalken |
| 🔍 **Globale Suche** | Tastenkürzel `/` öffnet eine Overlay-Suche über Aufträge, Kunden, Termine und Notizen mit Tastaturnavigation |

### Nur für Chef (ADMIN)

| Bereich | Beschreibung |
|---|---|
| ⚙️ **Dashboard-Widgets** | 6 KPI-Kacheln (Angebote, Rechnungen, Kunden, Aufträge, Fällige Rechnungen, Offene Mängel) – individuell ein-/ausblendbar, Einstellung in DB gespeichert (geräteübergreifend) |
| 👥 **Mitarbeiter-Logins** | Nutzer anlegen, Passwort ändern, löschen, Rolle verwalten |
| 📋 **Arbeitszeiten-Übersicht** | Alle Stempelzeiten aller Mitarbeiter, manuelle Einträge, Löschen, PDF-Export |
| 👤 **Kunden** | Kundenverwaltung mit Kontaktdaten, Dateien, verknüpfte Projekte |
| 📋 **Angebote** | Angebote erstellen, Positionen hinterlegen, direkt in Rechnung umwandeln |
| 🧾 **Rechnungen** | Rechnungen verwalten, Mahnstatus, PDF-Download |
| 📦 **Artikelstamm** | Standardartikel und Leistungen für Angebote & Rechnungen |

### Je Auftrag (Projektdetailseite)

- 📐 Digitales Aufmaß (Bauteilmaße mobil erfassen)
- ✏️ Handskizzen auf Canvas (Stift, Linie, Rechteck, Radierer, Farb- & Stärkenauswahl)
- 🛠️ Aufgaben & Mängel mit Foto-Nachweis
- 📝 Baustellen-Notizbuch
- 📸 Abschlussfotos (Upload via Cloudinary)
- 📁 Zeichnungen & Dokumente hochladen
- 📍 Geo-Fencing Standort mit Adresssuche (Nominatim)
- 📅 Verknüpfte Termine mit Wettervorhersage
- 📄 **Lieferschein/Stundennachweis-PDF** (Stunden, Aufmaß, Aufgaben, Notizen auf Knopfdruck)

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
| **PDF-Generierung** | PDFKit |
| **Kalender** | FullCalendar |
| **Wetter** | Open-Meteo API (kostenlos, kein API-Key) |

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
git clone https://github.com/dein-nutzername/metallbau-app.git
cd metallbau-app

# 2. Abhängigkeiten installieren
npm install

# 3. Umgebungsvariablen anlegen
cp .env.example .env
# → .env mit einem Texteditor öffnen und die Werte eintragen

# 4. App starten (SQLite wird automatisch angelegt)
npm run start:force

# App läuft unter: http://localhost:3000
```

> **Hinweis:** `npm start` führt vor dem Start einen Security-Audit durch. Bei Warnungen die Abhängigkeiten mit `npm audit fix` bereinigen oder direkt `npm run start:force` verwenden.

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

Alle Variablen sind in [`.env.example`](.env.example) dokumentiert. Pflichtfelder für den Produktionsbetrieb:

| Variable | Beschreibung | Pflicht |
|---|---|---|
| `DATABASE_URL` | PostgreSQL Connection-String (Render stellt ihn bereit) | Prod |
| `JWT_SECRET` | Zufälliger langer String für Token-Signierung | ✅ |
| `CLOUDINARY_CLOUD_NAME` | Cloudinary Cloud-Name | Upload |
| `CLOUDINARY_API_KEY` | Cloudinary API-Key | Upload |
| `CLOUDINARY_API_SECRET` | Cloudinary API-Secret | Upload |
| `FIRM_LAT` | GPS-Breitengrad des Firmensitzes | Stempeluhr |
| `FIRM_LNG` | GPS-Längengrad des Firmensitzes | Stempeluhr |
| `FIRM_RADIUS_METERS` | Radius in Metern für Stempeluhr-Prüfung | Stempeluhr |
| `PORT` | Server-Port (Standard: 3000) | Optional |

> ⚠️ `.env` niemals in Git committen – sie ist in `.gitignore` ausgeschlossen.

---

## 👤 Nutzerrollen

| Rolle | Beschreibung |
|---|---|
| `ADMIN` | Vollzugriff – Chef, sieht alle Bereiche inkl. Finanzen, Mitarbeiterverwaltung |
| `EMPLOYEE` | Monteur – sieht Aufträge, Kalender, eigene Zeiterfassung, Schwarzes Brett, Tools |

---

## 📁 Projektstruktur

```
metallbau-app/
├── server.js              # Haupt-Anwendungsdatei (alle Routen & Middleware)
├── config/
│   └── database.js        # Datenbankverbindung (PostgreSQL / SQLite, Tabellen-Setup)
├── middleware/
│   └── auth.js            # JWT-Verifikation, requireAdmin-Guard
├── routes/
│   ├── authRoutes.js      # Login / Logout
│   ├── adminRoutes.js     # Admin-Bereich (Nutzer, Arbeitszeiten)
│   ├── projectRoutes.js   # Aufträge (teilweise in server.js)
│   ├── timetrackingRoutes.js # Stempeluhr, Monatsexport
│   ├── calendarRoutes.js  # Termine
│   ├── vacationRoutes.js  # Urlaub & Abwesenheit
│   ├── documentRoutes.js  # Angebote & Rechnungen
│   ├── customerRoutes.js  # Kunden
│   ├── articleRoutes.js   # Artikelstamm
│   └── dashboardRoutes.js # Dashboard
├── utils/
│   └── notifier.js        # E-Mail & WhatsApp Benachrichtigungen (optional)
├── views/
│   ├── partials/
│   │   ├── header.ejs     # HTML-Head, Body-Start
│   │   └── sidebar.ejs    # Navigation, Suchoverlay
│   ├── dashboard.ejs          # Chef-Dashboard
│   ├── dashboard-employee.ejs # Mitarbeiter-Dashboard (Überstunden-Ampel)
│   ├── projects.ejs           # Auftragsliste
│   ├── project-detail.ejs     # Auftragsdetail (Aufmaß, Skizzen, Fotos, …)
│   ├── calendar.ejs           # Kalender (FullCalendar + Wetter)
│   ├── timetracking.ejs       # Stempeluhr
│   ├── admin-timetracking.ejs # Arbeitszeiten-Übersicht (zusammengeführt)
│   ├── vacations.ejs          # Urlaub & Abwesenheit
│   ├── customers.ejs          # Kundenliste
│   ├── admin-users.ejs        # Mitarbeiterverwaltung
│   ├── invoices.ejs           # Rechnungen
│   ├── offers.ejs             # Angebote
│   └── articles.ejs           # Artikelstamm
├── Public/
│   └── manifest.json      # PWA-Manifest
├── .env.example           # Umgebungsvariablen-Vorlage
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
| `/projects/:id` | GET | Alle | Auftragsdetail |
| `/projects/:id/pdf` | GET | Admin | Lieferschein-PDF |
| `/calendar` | GET | Alle | Terminkalender |
| `/timetracking` | GET | Alle | Stempeluhr |
| `/admin/timetracking` | GET | Admin | Arbeitszeiten-Übersicht |
| `/admin/timetracking/pdf` | GET | Admin | Arbeitszeitennachweis-PDF |
| `/vacations` | GET | Alle | Urlaub & Abwesenheit |
| `/customers` | GET | Admin | Kundenverwaltung |
| `/documents/offers` | GET | Admin | Angebote |
| `/documents/invoices` | GET | Admin | Rechnungen |
| `/articles` | GET | Admin | Artikelstamm |
| `/admin/users` | GET | Admin | Mitarbeiterverwaltung |
| `/api/user-settings` | POST | Admin | Widget-Einstellungen speichern (JSON) |
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
