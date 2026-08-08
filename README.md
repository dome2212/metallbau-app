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
- [RFID-Stempeluhr](#-rfid-stempeluhr-raspberry-pi)
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
| 🏠 **Dashboard** | Rollenspezifische Startseite – Monteur sieht Monatsübersicht, Überstunden-Ampel mit Fortschrittsbalken & heutige Stunden live; Chef sieht konfigurierbare KPI-Kacheln, überfällige Aufgaben & offene Vorgänge |
| 📢 **Schwarzes Brett** | Chef postet Nachrichten an alle Mitarbeiter – optional mit WhatsApp-Push |
| 🏗️ **Aufträge & Baustellen** | Aufträge anlegen, bearbeiten, Statusverlauf, Schnellstatus ohne Reload, Suche & Filter, Archiv-Toggle für abgeschlossene Aufträge |
| 📅 **Kalender** | Termine eintragen & löschen, Mitarbeiter zuweisen, Wetter-Frühwarnung (Wind, Böen, Regen) pro Termin |
| ⏱️ **Zeiterfassung** | Stempeluhr mit GPS-Prüfung, Geo-Fencing je Baustelle, Baustelle wechseln ohne Ausstempeln |
| 📊 **Monatsauswertung** | Ist- vs. Soll-Stunden, Über-/Minusstunden, Projektspalte, CSV-Export, **PDF-Stundenzettel** mit Unterschriften-Zeile |
| 🌴 **Urlaub & Abwesenheit** | Urlaubsanträge, Krankmeldungen, Schulungen, Datei-Upload, Jahresübersicht |
| 🔍 **Globale Suche** | Tastenkürzel `/` – durchsucht Aufträge, Kunden, Termine, Notizen, **Mitarbeiter & Artikel** |
| 📱 **PWA** | Installierbar auf dem Smartphone, Offline-Fallback-Seite, Stempel offline puffern & synchronisieren |

### Nur für Chef / Admin

| Bereich | Beschreibung |
|---|---|
| ⚙️ **Dashboard-Widgets** | 6 KPI-Kacheln individuell ein-/ausblendbar, Drag & Drop Layout, überfällige Aufgaben-Block |
| 👥 **Mitarbeiterverwaltung** | Nutzer anlegen, Passwort ändern, Rolle verwalten, WhatsApp & RFID-Chip konfigurieren |
| 📅 **Personalplanung** | Wochenplan: wer arbeitet wann auf welcher Baustelle – Klick-Zuweisung, Vor-/Nächste-Woche-Navigation |
| 📋 **Arbeitszeiten-Übersicht** | Alle Stempelzeiten aller Mitarbeiter, manuelle Einträge, Löschen, PDF-Export |
| 👤 **Kunden** | Kundenverwaltung mit Kontaktdaten und verknüpften Projekten |
| 📋 **Angebote** | Angebote erstellen, KI-Assistent für Positionen & Bildanalyse, in Rechnung umwandeln, PDF-Download |
| 🧾 **Rechnungen** | Rechnungen verwalten, Mahnstatus, KI-Mahntext, PDF-Download & Druckansicht |
| 📦 **Artikelstamm** | Standardartikel und Leistungen für Angebote & Rechnungen, KI-Vorschlag, Bearbeiten & Löschen |
| 🏢 **Firmendaten** | Alle PDF-Daten, Logo, Sidebar-Logo, Farben, Dark-Mode-Standard zentral konfigurierbar |
| ⚙️ **Admin-Panel** | KPI-Schwellen, Stempeluhr-Einstellungen, Geofencing, Push-Benachrichtigungen, Backup |

### Je Auftrag (Projektdetailseite)

- 📐 Digitales Aufmaß (Bauteilmaße mobil erfassen)
- 🛠️ Aufgaben & Mängel mit Foto-Nachweis und Status-Toggle
- 📝 Baustellen-Notizbuch (Text + Sprachnotizen)
- 📸 Abschlussfotos (Upload via Cloudinary)
- 📁 Zeichnungen & Dokumente hochladen
- 📍 Geo-Fencing Standort mit Adresssuche (OpenStreetMap Nominatim)
- 📅 Verknüpfte Termine mit Wettervorhersage
- ⏱️ **Stunden & Nachkalkulation** (welcher Mitarbeiter wie viele Stunden – direkt aus Stempeluhrdaten)
- 📄 **Lieferschein/Stundennachweis-PDF** (Stunden, Aufmaß, Aufgaben, Notizen)
- 🧾 **Rechnung direkt aus Auftrag erstellen**
- 🤖 **KI-Angebot & KI-Statusbericht** (Freitext oder Skizzenanalyse)

### 📱 WhatsApp-Benachrichtigungen

| Ereignis | Empfänger |
|---|---|
| Neuer Urlaubsantrag gestellt | Alle Admins **und Chefs** |
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
| **KI-Statusbericht** | Projektdaten → KI erstellt strukturierten Statusbericht |

### 🔖 RFID-Stempeluhr (Raspberry Pi)

Mitarbeiter stempeln per Chipkarte – kein Smartphone nötig:

- **Hardware:** Raspberry Pi (any) + RC522 Lesegerät (~30 €)
- **Sicherheit:** Gesichert per `RFID_API_KEY` in der `.env`
- **Logik:** Erstes Halten = Einstempeln, zweites Halten = Ausstempeln (automatisch)
- **Feedback:** Grüne/rote LED + Buzzer (optional)
- **UIDs verwalten:** Im Admin-Panel unter `/admin/users` → Spalte „🔖 RFID-Chip"
- **Script:** [`docs/rfid_stamp.py`](docs/rfid_stamp.py) – vollständig kommentiert, Autostart via systemd

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
| **PDF-Generierung** | PDFKit (Angebote, Rechnungen, Lieferscheine, Stundenzetteln) |
| **Kalender** | FullCalendar |
| **Wetter** | Open-Meteo API (kostenlos, kein API-Key nötig) |
| **Geocoding** | OpenStreetMap Nominatim (kostenlos, kein API-Key nötig) |
| **WhatsApp** | CallMeBot API (kostenlos, kein Account nötig) |
| **KI** | OpenRouter API (kostenlose Modelle verfügbar) |
| **RFID** | RC522 + Python `mfrc522` auf Raspberry Pi |
| **PWA** | Service Worker · Web App Manifest · IndexedDB Offline-Puffer |
| **Rate Limiting** | express-rate-limit (Login: 10/15min · API: 200/min) |

---

## ✅ Voraussetzungen

- **Node.js** ≥ 18
- **npm** ≥ 9
- Für die Cloud: PostgreSQL-Datenbank (z. B. auf [Render](https://render.com))
- Für Datei-Uploads: [Cloudinary](https://cloudinary.com)-Account (kostenloser Plan reicht)
- Optional: [OpenRouter](https://openrouter.ai)-Account für KI-Features (kostenlose Modelle verfügbar)
- Optional: Raspberry Pi + RC522 für RFID-Stempeluhr

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

> **Hinweis Reverse Proxy:** Render setzt den Header `X-Forwarded-For`. Die App setzt daher `app.set('trust proxy', 1)`, damit `express-rate-limit` die echte Client-IP korrekt ausliest.

---

## 🔑 Umgebungsvariablen

Alle Variablen sind in [`.env.example`](.env.example) dokumentiert.

| Variable | Beschreibung | Pflicht |
|---|---|---|
| `DATABASE_URL` | PostgreSQL Connection-String | Produktion |
| `JWT_SECRET` | Zufälliger langer String für Token-Signierung | ✅ |
| `CLOUDINARY_CLOUD_NAME` | Cloudinary Cloud-Name | Upload |
| `CLOUDINARY_API_KEY` | Cloudinary API-Key | Upload |
| `CLOUDINARY_API_SECRET` | Cloudinary API-Secret | Upload |
| `FIRM_LAT` | GPS-Breitengrad des Firmensitzes | Stempeluhr |
| `FIRM_LNG` | GPS-Längengrad des Firmensitzes | Stempeluhr |
| `FIRM_RADIUS_METERS` | Erlaubter Radius in Metern (Standard: 300) | Stempeluhr |
| `RFID_API_KEY` | Geheimes Passwort für den Raspberry Pi RFID-Scanner | RFID |
| `OPENROUTER_API_KEY` | API-Key für KI-Features (openrouter.ai) | KI |
| `APP_URL` | Öffentliche URL der App (für KI-Referer-Header) | KI |
| `BACKUP_EMAIL` | E-Mail-Adresse für automatische Datenbank-Backups | Backup |
| `SMTP_USER` | SMTP-Benutzername (für Backup-E-Mails) | Backup |
| `SMTP_PASS` | SMTP-Passwort | Backup |
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
   - **WhatsApp-Nummer** (z. B. `015712345678`)
   - **API-Key** (aus Schritt 2)
   - Benachrichtigungs-Toggle einschalten

> Kein Umgebungsvariablen nötig – API-Key und Nummer werden pro Mitarbeiter in der Datenbank gespeichert.

---

## 🤖 KI-Assistent (OpenRouter)

Die KI-Features nutzen [OpenRouter](https://openrouter.ai) als Gateway zu verschiedenen Sprachmodellen.

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

---

## 🔖 RFID-Stempeluhr (Raspberry Pi)

Mitarbeiter können sich per Chipkarte ein- und ausstempeln – kein Smartphone, kein Passwort nötig.

### Benötigte Hardware (~35 €)

| Teil | Preis |
|---|---|
| Raspberry Pi Zero 2 W (empfohlen) | ~18 € |
| RC522 RFID-Lesegerät (inkl. Karte & Schlüsselanhänger) | ~7 € |
| microSD-Karte 8 GB | ~7 € |
| USB-Netzteil 5V/2,5A | ~8 € |
| Optional: grüne/rote LED + Buzzer | ~3 € |

### Einrichtung

```bash
# 1. Python-Pakete auf dem Pi installieren
sudo apt install python3-pip python3-spidev
pip3 install mfrc522 requests RPi.GPIO

# 2. Script kopieren und konfigurieren
nano /home/pi/rfid_stamp.py
# APP_URL und RFID_KEY eintragen

# 3. Autostart
sudo systemctl enable rfid-stamp
sudo systemctl start rfid-stamp
```

### Konfiguration

```env
# .env / Render Environment Variables
RFID_API_KEY=DeinLangesGeheimesPasswort
```

Chip-UIDs werden im Admin-Panel unter **`/admin/users`** → Spalte **🔖 RFID-Chip** pro Mitarbeiter hinterlegt.

Das vollständige Python-Script mit Verkabelungsanleitung und systemd-Service liegt unter [`docs/rfid_stamp.py`](docs/rfid_stamp.py).

### Verkabelung RC522 → Raspberry Pi

| RC522 | GPIO | Pin |
|---|---|---|
| SDA | GPIO 8 | 24 |
| SCK | GPIO 11 | 23 |
| MOSI | GPIO 10 | 19 |
| MISO | GPIO 9 | 21 |
| GND | GND | 6 |
| RST | GPIO 25 | 22 |
| 3.3V | 3.3V | 1 |

---

## 🏢 Firmendaten anpassen

Firmendaten werden über **`/admin/company-settings`** direkt in der App gepflegt und in der Datenbank gespeichert. Dort konfigurierbar:

- Firmenname, Kurzname, Slogan, Adresse, Kontakt
- Bankverbindung (IBAN, BIC, Bank)
- Zahlungsfrist & Angebotsgültigkeit (Tage)
- PDF-Logo & Sidebar-Logo (Upload via Cloudinary)
- Sidebar-Darstellung (Text oder Logo, Größe)
- App-Farben (Primärfarbe, Sidebar, Topbar, Hintergrund)
- Dark-Mode als Standard
- Footer-Text in der Sidebar

---

## 👤 Nutzerrollen

| Rolle | Beschreibung |
|---|---|
| `CHEF` | Vollzugriff inkl. Finanzen, alle Summen sichtbar, Mitarbeiterverwaltung |
| `ADMIN` | Wie Chef, aber Geldbeträge ausgeblendet |
| `EMPLOYEE` | Monteur – sieht Aufträge, Kalender, eigene Zeiterfassung, Schwarzes Brett, Urlaub |

---

## 📁 Projektstruktur

```
metallbau-app/
├── server.js                       # Einstiegspunkt: Middleware, globale Routen (Suche, RFID, Dark-Mode)
├── config/
│   └── database.js                 # DB-Verbindung (PostgreSQL / SQLite)
├── middleware/
│   └── auth.js                     # JWT-Verifikation, requireAdmin, hasPerm
├── routes/
│   ├── authRoutes.js               # Login / Logout / Standard-Admin anlegen
│   ├── adminRoutes.js              # Mitarbeiter, Arbeitszeiten-Admin, Ticker, Personalplanung, RFID
│   ├── dashboardRoutes.js          # Dashboard (Chef & Mitarbeiter), Widget-Einstellungen
│   ├── projectRoutes.js            # Aufträge, Aufmaß, Aufgaben, Notizen, Fotos, Nachkalkulation
│   ├── customerRoutes.js           # Kunden & verknüpfte Dateien
│   ├── calendarRoutes.js           # Termine, Mitarbeiter-Zuweisung, Wetter-API
│   ├── timetrackingRoutes.js       # Stempeluhr, GPS, Geo-Fencing, Monatsauswertung, PDF
│   ├── vacationRoutes.js           # Urlaubsanträge, Status, Jahresanspruch
│   ├── documentRoutes.js           # Angebote → Rechnungen, PDFs
│   ├── articleRoutes.js            # Artikelstamm (CRUD)
│   ├── companySettingsRoutes.js    # Firmendaten, Logo-Upload
│   ├── reportsRoutes.js            # Auswertungen & Berichte
│   ├── tickerRoutes.js             # Schwarzes Brett
│   ├── appointmentRoutes.js        # Terminfunktionen
│   ├── pushRoutes.js               # Push-Benachrichtigungen
│   └── aiRoutes.js                 # KI-Endpunkte
├── utils/
│   ├── db.js                       # dbQuery-Hilfsfunktion (SQLite & PostgreSQL kompatibel)
│   ├── firma.js                    # Fallback-Firmendaten
│   ├── companySettings.js          # Firmendaten aus DB laden (mit Cache)
│   ├── notifier.js                 # WhatsApp (CallMeBot)
│   ├── backup.js                   # Automatisches DB-Backup per E-Mail
│   └── holidays.js                 # NRW-Feiertage (für Urlaubsberechnung)
├── views/
│   ├── partials/
│   │   ├── header.ejs              # HTML-Head, CSS, Dark Mode, Toast, Bottom Nav
│   │   └── sidebar.ejs             # Navigation, Suche, Sidebar-Einstellungen
│   ├── dashboard.ejs               # Chef-Dashboard (KPI, überfällige Tasks, Schwarzes Brett)
│   ├── dashboard-employee.ejs      # Mitarbeiter-Dashboard (Ampel, Stunden, Drag & Drop)
│   ├── staffplan.ejs               # Personalplanung (Wochenplan)
│   ├── projects.ejs                # Auftragsliste (Filter, Archiv-Toggle)
│   ├── project-detail.ejs          # Auftragsdetail (Aufmaß, Aufgaben, Stunden, KI)
│   ├── project-board.ejs           # Kanban-Board (Fertigungsphasen)
│   ├── project-invoice-create.ejs  # Rechnung aus Auftrag
│   ├── calendar.ejs                # Terminkalender + Urlaubskalender
│   ├── timetracking.ejs            # Stempeluhr (GPS, Geo-Fencing)
│   ├── admin-timetracking.ejs      # Arbeitszeiten-Übersicht (alle Mitarbeiter)
│   ├── time-monthly.ejs            # Monatliche Stundenübersicht + PDF-Export
│   ├── vacations.ejs               # Urlaub & Abwesenheit
│   ├── customers.ejs               # Kundenliste
│   ├── customer-projects.ejs       # Projekte je Kunde
│   ├── admin-users.ejs             # Mitarbeiterverwaltung (WhatsApp, RFID)
│   ├── admin-panel.ejs             # Admin-Einstellungen
│   ├── company-settings.ejs        # Firmendaten & Logo
│   ├── invoices.ejs / offers.ejs   # Rechnungs- / Angebotsliste
│   ├── invoice-detail.ejs          # Rechnungsdetail
│   ├── invoice-pdf.ejs             # Druckansicht Rechnung
│   ├── documents.ejs               # Dokumentenübersicht
│   ├── articles.ejs                # Artikelstamm
│   ├── reports.ejs                 # Auswertungen & Berichte
│   ├── steel-calculator.ejs        # Stahlrechner (Profile, Gewicht, Preis)
│   ├── treppe.ejs                  # Treppenkonfigurator
│   ├── map.ejs                     # Baustellen-Karte
│   ├── lexikon.ejs                 # Metallbau-Lexikon
│   ├── ticker.ejs                  # Schwarzes Brett (Admin)
│   ├── profile.ejs                 # Passwort ändern
│   └── login.ejs                   # Login-Seite
├── Public/
│   ├── sw.js                       # Service Worker (Offline-Fallback, Stempel-Puffer)
│   ├── manifest.json               # PWA-Manifest
│   └── offline.html                # Offline-Fallback-Seite
├── docs/
│   └── rfid_stamp.py               # Python-Script für Raspberry Pi RFID-Stempeluhr
├── .env.example                    # Vorlage für Umgebungsvariablen
├── .gitignore
├── package.json
└── README.md
```

---

## 🗺 Seiten & Routen

### Öffentlich & Alle Nutzer

| Route | Methode | Beschreibung |
|---|---|---|
| `/` | GET | Dashboard (rollenabhängig: Chef oder Mitarbeiter) |
| `/login` | GET/POST | Login |
| `/logout` | GET | Abmelden |
| `/profile` | GET/POST | Passwort ändern |

### Aufträge

| Route | Methode | Zugriff | Beschreibung |
|---|---|---|---|
| `/projects` | GET | Alle | Auftragsliste (mit Archiv-Toggle) |
| `/projects/add` | POST | Admin | Neuen Auftrag anlegen |
| `/projects/:id` | GET | Alle | Auftragsdetail inkl. Stunden-Nachkalkulation |
| `/projects/:id/pdf` | GET | Admin | Lieferschein-PDF |
| `/projects/:id/create-invoice` | GET/POST | Admin | Rechnung aus Auftrag erstellen |
| `/projects/update-status` | POST | Admin | Schnellstatus (AJAX) |
| `/project-board` | GET | Alle | Kanban-Board |

### Zeiterfassung

| Route | Methode | Zugriff | Beschreibung |
|---|---|---|---|
| `/timetracking` | GET | Alle | Stempeluhr |
| `/timetracking/stamp` | POST | Alle | Stempeln (IN / OUT / SWITCH) |
| `/timetracking/admin/monthly` | GET | Alle | Monatsauswertung |
| `/timetracking/admin/export-csv` | GET | Alle | CSV-Export |
| `/timetracking/admin/export-pdf` | GET | Alle | **PDF-Stundenzettel** |
| `/admin/timetracking` | GET | Admin | Alle Mitarbeiter |
| `/admin/timetracking/pdf` | GET | Admin | Arbeitszeitennachweis-PDF |

### Kalender & Urlaub

| Route | Methode | Beschreibung |
|---|---|---|
| `/calendar` | GET | Terminkalender + Urlaubskalender |
| `/vacations` | GET | Urlaub & Abwesenheit |
| `/vacations/add` | POST | Antrag stellen |
| `/vacations/status` | POST | Genehmigen / Ablehnen (Admin) |

### Admin

| Route | Methode | Beschreibung |
|---|---|---|
| `/admin/users` | GET | Mitarbeiterverwaltung |
| `/admin/users/add` | POST | Neuen Account anlegen |
| `/admin/users/set-rfid` | POST | RFID-UID zuweisen |
| `/admin/staffplan` | GET | **Personalplanung – Wochenplan** |
| `/admin/staffplan/save` | POST | Zuweisung speichern (AJAX) |
| `/admin/company-settings` | GET/POST | Firmendaten & Logo |
| `/admin/panel` | GET | Admin-Einstellungen |

### Dokumente & Artikel

| Route | Methode | Beschreibung |
|---|---|---|
| `/documents/offers` | GET | Angebote |
| `/documents/invoices` | GET | Rechnungen |
| `/documents/invoices/:id` | GET | Rechnungsdetail |
| `/documents/invoices/:id/pdf-download` | GET | PDF-Download |
| `/articles` | GET | Artikelstamm |
| `/articles/edit` | POST | Artikel bearbeiten |

### API

| Route | Methode | Beschreibung |
|---|---|---|
| `/api/search` | GET | Globale Suche (Aufträge, Kunden, Termine, Notizen, Mitarbeiter, Artikel) |
| `/api/today-hours` | GET | Heutige Arbeitsstunden (für Mitarbeiter-Dashboard) |
| `/api/dark-mode` | POST | Dark-Mode serverseitig speichern |
| `/api/rfid/stamp` | POST | **RFID-Stempel** (Raspberry Pi, gesichert per X-RFID-Key) |
| `/api/user-settings` | POST | Widget-Einstellungen speichern |
| `/api/weather` | GET | Wettervorhersage (Open-Meteo) |

### KI

| Route | Beschreibung |
|---|---|
| `/api/ai/offer-assistant` | Angebotspositionen aus Freitext |
| `/api/ai/offer-assistant-image` | Angebotspositionen aus Foto |
| `/api/ai/article-suggest` | Artikel-Vorschlag |
| `/api/ai/project-description` | Auftragsbeschreibung generieren |
| `/api/ai/payment-reminder` | Mahntext generieren |

---

## 🔐 Standard-Login

Beim ersten Start wird automatisch ein Chef-Nutzer angelegt, falls noch keiner existiert.
Das **zufällig generierte Passwort** wird **einmalig in der Konsole** ausgegeben:

```
==========================================
🔑 Standard-Chef angelegt!
   User: chef
   PW:   <zufälliges Passwort>
   ⚠️  Bitte SOFORT nach dem ersten Login ändern!
==========================================
```

> ⚠️ **Passwort nach dem ersten Login sofort ändern!**
> Unter `/admin/users` → Passwort des Mitarbeiters ändern.

> 💡 Es gibt **keine hartcodierten Standard-Zugangsdaten** mehr.
> Falls du das Passwort verloren hast, lösche den `chef`-Eintrag in der Datenbank – beim nächsten Start wird ein neues generiert.

---

## 📝 Lizenz

Privates Projekt – alle Rechte vorbehalten.  
Entwickelt von **Domenic Rosic**.
