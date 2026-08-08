# 🔩 Metallbau-App – Betriebssoftware

Eine vollständige, mobile-optimierte Betriebssoftware für Metallbaubetriebe. Entwickelt als Node.js-Webanwendung mit EJS-Templates und Tailwind CSS. Läuft lokal (SQLite) oder in der Cloud (PostgreSQL auf Render).

---

## 📋 Inhaltsverzeichnis

- [Features](#-features)
- [Sicherheit](#-sicherheit)
- [Tech-Stack](#-tech-stack)
- [Voraussetzungen](#-voraussetzungen)
- [Installation (Lokal)](#-installation-lokal)
- [Deployment (Render / Cloud)](#-deployment-render--cloud)
- [Umgebungsvariablen](#-umgebungsvariablen)
- [WhatsApp-Benachrichtigungen](#-whatsapp-benachrichtigungen-callmebot)
- [KI-Assistent](#-ki-assistent-openrouter)
- [RFID-Stempeluhr](#-rfid-stempeluhr-raspberry-pi)
- [Lagerverwaltung](#-lagerverwaltung)
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
| 🏠 **Dashboard** | Rollenspezifische Startseite – Monteur sieht Monatsübersicht, Überstunden-Ampel & heutige Stunden live; Chef sieht konfigurierbare KPI-Kacheln, überfällige Aufgaben & offene Vorgänge |
| 📢 **Schwarzes Brett** | Chef postet Nachrichten an alle Mitarbeiter – optional mit WhatsApp-Push |
| 🏗️ **Aufträge & Baustellen** | Aufträge anlegen, bearbeiten, Statusverlauf, Schnellstatus ohne Reload, Suche & Filter, Archiv-Toggle |
| 📅 **Kalender** | Termine eintragen & löschen, Mitarbeiter zuweisen, Wetter-Frühwarnung (Wind, Böen, Regen) pro Termin |
| ⏱️ **Zeiterfassung** | Stempeluhr mit GPS-Prüfung, Geo-Fencing je Baustelle, Baustelle wechseln ohne Ausstempeln |
| 📊 **Monatsauswertung** | Ist- vs. Soll-Stunden, Über-/Minusstunden, Projektspalte, CSV-Export, **PDF-Stundenzettel** mit Unterschriften-Zeile |
| 🌴 **Urlaub & Abwesenheit** | Urlaubsanträge, Krankmeldungen, Schulungen, Datei-Upload, Jahresübersicht |
| 🔍 **Globale Suche** | Tastenkürzel `/` – durchsucht Aufträge, Kunden, Termine, Notizen, Mitarbeiter & Artikel |
| 📱 **PWA** | Installierbar auf dem Smartphone, Offline-Fallback-Seite, Stempel offline puffern & synchronisieren |

### Nur für Chef / Admin

| Bereich | Beschreibung |
|---|---|
| ⚙️ **Dashboard-Widgets** | 6 KPI-Kacheln individuell ein-/ausblendbar, Drag & Drop Layout |
| 👥 **Mitarbeiterverwaltung** | Nutzer anlegen, Passwort ändern, Rolle verwalten, WhatsApp & RFID-Chip konfigurieren |
| 📅 **Personalplanung** | Wochenplan: wer arbeitet wann auf welcher Baustelle – Klick-Zuweisung |
| 📋 **Arbeitszeiten-Übersicht** | Alle Stempelzeiten aller Mitarbeiter, manuelle Einträge, Löschen, PDF-Export |
| 👤 **Kunden** | Kundenverwaltung mit Kontaktdaten und verknüpften Projekten |
| 📋 **Angebote** | Angebote erstellen, KI-Assistent für Positionen & Bildanalyse, Nachtrags-Management, PDF-Download |
| 🧾 **Rechnungen** | Rechnungen verwalten, Mahnstatus, KI-Mahntext, PDF-Download & Druckansicht |
| 📦 **Artikelstamm** | Standardartikel und Leistungen für Angebote & Rechnungen, KI-Vorschlag |
| 🏭 **Lagerverwaltung** | Material einlagern, Entnahmen buchen, Mindestbestand, Reststücke, Lieferschein-Scan per KI |
| 🏢 **Firmendaten** | Alle PDF-Daten, Logo, Sidebar-Logo, Farben, Dark-Mode-Standard zentral konfigurierbar |
| ⚙️ **Admin-Panel** | KPI-Schwellen, Stempeluhr-Einstellungen, Geofencing, eigene Lager-Tabs, Push-Benachrichtigungen |

### Je Auftrag (Projektdetailseite)

- 📐 Digitales Aufmaß (Bauteilmaße mobil erfassen)
- 🛠️ Aufgaben & Mängel mit Foto-Nachweis, Status-Toggle und **KI-Mängelanalyse** (Foto → Beschreibung)
- 💬 Interner Baustellen-Chat (Live-Polling, Löschen eigener Nachrichten)
- 📝 Baustellen-Notizbuch (Text + Sprachnotizen)
- 📸 Abschlussfotos (Upload via Cloudinary)
- 📁 Zeichnungen & Dokumente hochladen
- 📍 Geo-Fencing Standort mit Adresssuche (OpenStreetMap Nominatim)
- 📅 Verknüpfte Termine mit Wettervorhersage
- ⏱️ **Stunden & Nachkalkulation** (welcher Mitarbeiter wie viele Stunden – direkt aus Stempeluhrdaten)
- 📄 **Lieferschein/Stundennachweis-PDF**
- 🧾 **Rechnung direkt aus Auftrag erstellen**
- 🤖 **KI-Angebot & KI-Statusbericht**

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
| **Leistungsbeschreibung** | Stichpunkte → KI formuliert professionelle Positionsbeschreibung für Angebote & Nachträge |
| **Artikel-Vorschlag** | Beschreibung → KI schlägt Artikelbezeichnung, Einheit & Preis vor |
| **Auftragsbeschreibung** | Stichworte → KI formuliert kurze sachliche Beschreibung |
| **Mahntext** | Rechnungsdaten → KI formuliert höflichen Mahnungstext (1.–n. Mahnung) |
| **KI-Statusbericht** | Projektdaten → KI erstellt strukturierten Statusbericht |
| **KI-Mängelanalyse** | Foto eines Bauteils → KI erkennt Mängel und schlägt Titel, Beschreibung & Kategorie vor |
| **Lieferschein-Scan** | Lieferschein-Foto → KI extrahiert Materialpositionen direkt ins Lager |

### 🔖 RFID-Stempeluhr (Raspberry Pi)

Mitarbeiter stempeln per Chipkarte – kein Smartphone nötig:

- **Hardware:** Raspberry Pi (any) + RC522 Lesegerät (~30 €)
- **Sicherheit:** Gesichert per `RFID_API_KEY` in der `.env` (fail-closed – ohne Key kein Zugriff)
- **Logik:** Erstes Halten = Einstempeln, zweites Halten = Ausstempeln (automatisch)
- **Feedback:** Grüne/rote LED + Buzzer (optional)
- **UIDs verwalten:** Im Admin-Panel unter `/admin/users` → Spalte „🔖 RFID-Chip"
- **Script:** [`docs/rfid_stamp.py`](docs/rfid_stamp.py) – vollständig kommentiert, Autostart via systemd

---

## 🔒 Sicherheit

| Bereich | Maßnahme |
|---|---|
| **Passwörter** | bcryptjs (cost 10), keine hartcodierten Defaults – zufälliges Passwort beim ersten Start |
| **JWT** | `JWT_SECRET` ist Pflicht – Server startet ohne diese Variable nicht |
| **RFID-Endpunkt** | Fail-closed: ohne `RFID_API_KEY` gibt der Endpunkt 503 zurück |
| **Zeiterfassung** | IDOR-Schutz: Mitarbeiter können nur eigene Daten abrufen, Admins alle |
| **XSS** | Nutzereingaben in öffentlichen Freigabe-Links werden escaped |
| **Abhängigkeiten** | 0 bekannte Sicherheitslücken (`npm audit`) |
| **API-Keys** | Keine echten Keys im Repository – nur Platzhalter |

---

## 🛠 Tech-Stack

| Kategorie | Technologie |
|---|---|
| **Backend** | Node.js · Express.js |
| **Templates** | EJS (Embedded JavaScript) |
| **Styling** | Tailwind CSS (via CDN) |
| **Datenbank** | PostgreSQL (Produktion) · SQLite (lokal) |
| **Auth** | JWT (Cookie-basiert, HTTP-Only) · bcryptjs |
| **Datei-Upload** | Multer · Cloudinary v2 (eigener Storage-Adapter) |
| **PDF-Generierung** | PDFKit (Angebote, Rechnungen, Lieferscheine, Stundenzetteln) |
| **Kalender** | FullCalendar |
| **Wetter** | Open-Meteo API (kostenlos, kein API-Key nötig) |
| **Geocoding** | OpenStreetMap Nominatim (kostenlos, kein API-Key nötig) |
| **WhatsApp** | CallMeBot API (kostenlos) |
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
# → .env öffnen und mindestens JWT_SECRET setzen

# JWT_SECRET generieren:
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"

# 4. App starten (SQLite wird automatisch angelegt)
node server.js

# App läuft unter: http://localhost:3000
```

Beim ersten Start wird ein Chef-Account mit zufälligem Passwort angelegt – **in der Konsole ausgegeben**.

---

## ☁️ Deployment (Render / Cloud)

1. Repository auf GitHub pushen
2. Neuen **Web Service** auf [Render](https://render.com) erstellen
3. Build-Befehl: `npm install`
4. Start-Befehl: `node server.js`
5. Alle [Umgebungsvariablen](#-umgebungsvariablen) in den Render-Einstellungen hinterlegen
6. Separate **PostgreSQL-Datenbank** auf Render anlegen und `DATABASE_URL` eintragen

Die App erkennt automatisch ob `DATABASE_URL` gesetzt ist und wechselt zwischen PostgreSQL und SQLite.

> **Hinweis Reverse Proxy:** Render setzt den Header `X-Forwarded-For`. Die App setzt `app.set('trust proxy', 1)`, damit `express-rate-limit` die echte Client-IP korrekt ausliest.

---

## 🔑 Umgebungsvariablen

Alle Variablen sind in [`.env.example`](.env.example) dokumentiert.

| Variable | Beschreibung | Pflicht |
|---|---|---|
| `JWT_SECRET` | Langer zufälliger String für Token-Signierung – **Server startet ohne diesen Wert nicht** | ✅ |
| `DATABASE_URL` | PostgreSQL Connection-String | Produktion |
| `CLOUDINARY_CLOUD_NAME` | Cloudinary Cloud-Name | Upload |
| `CLOUDINARY_API_KEY` | Cloudinary API-Key | Upload |
| `CLOUDINARY_API_SECRET` | Cloudinary API-Secret | Upload |
| `RFID_API_KEY` | Geheimes Passwort für den Raspberry Pi RFID-Scanner (fail-closed ohne diesen Wert) | RFID |
| `OPENROUTER_API_KEY` | API-Key für KI-Features (openrouter.ai) | KI |
| `APP_URL` | Öffentliche URL der App (für KI-Referer-Header) | KI |
| `BACKUP_EMAIL` | E-Mail-Adresse für automatische Datenbank-Backups | Backup |
| `SMTP_USER` / `SMTP_PASS` | SMTP-Zugangsdaten (für Backup-E-Mails) | Backup |
| `PORT` | Server-Port (Standard: 3000) | Optional |

> ⚠️ `.env` niemals in Git committen – sie ist in `.gitignore` ausgeschlossen.

---

## 📱 WhatsApp-Benachrichtigungen (CallMeBot)

Die App nutzt [CallMeBot](https://www.callmebot.com/blog/free-api-whatsapp-messages/) – einen kostenlosen Dienst ohne eigenen Account oder bezahlte API.

### Einrichtung pro Mitarbeiter

1. Der Mitarbeiter schickt **einmalig** per WhatsApp an **+34 644 52 74 21**:
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

Die KI-Features nutzen [OpenRouter](https://openrouter.ai) als Gateway zu verschiedenen Sprachmodellen – alle verwendeten Modelle sind kostenlos.

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
# APP_URL und RFID_KEY eintragen (Werte aus der .env)

# 3. Autostart
sudo systemctl enable rfid-stamp
sudo systemctl start rfid-stamp
```

### Konfiguration

```env
# Render / .env
RFID_API_KEY=DeinLangesGeheimesPasswort
```

Chip-UIDs werden im Admin-Panel unter **`/admin/users`** → Spalte **🔖 RFID-Chip** pro Mitarbeiter hinterlegt.

Das vollständige Python-Script mit Verkabelungsanleitung liegt unter [`docs/rfid_stamp.py`](docs/rfid_stamp.py).

> ⚠️ Falls `RFID_API_KEY` nicht gesetzt ist, gibt der Endpunkt **503** zurück (fail-closed – kein ungeschützter Zugriff möglich).

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

## 🏭 Lagerverwaltung

Die Lagerverwaltung (`/lager`) ermöglicht das Verwalten von Materialien, Entnahmen und Reststücken.

### Standard-Tabs (fest)

| Tab | Inhalt |
|---|---|
| 🔩 Baustahl | Stahlprofile, Flachstahl, Rohre, Winkel… |
| ✨ Edelstahl | VA-Stahl, V2A, V4A… |
| 🔧 Schrauben | Schrauben & Kleinteile mit Gewinde, Länge, Kopfform, Güte |
| 📤 Entnahmen | Buchungsprotokoll – wer hat wann was entnommen |
| ✂️ Reststücke | Abschnitte & Reststücke aus laufender Produktion |

### Eigene Tabs

Im **Admin-Panel → 🏭 Lager-Tabs** können beliebige zusätzliche Kategorien angelegt werden:

- **Icon** per Emoji-Picker wählen (Kategorien: Werkzeug, Material, Transport, Gebäude, Natur, Symbole)
- **Bezeichnung** frei wählbar (z. B. „Aluminium", „Farben & Lacke", „Werkzeuge")
- **Farbe** als farbiger Punkt auswählen (8 Farben)
- **Reihenfolge** per Drag & Drop anpassen
- **Live-Vorschau** des Tab-Badges beim Bearbeiten

> ⚠️ Den internen **Key** eines Tabs nach dem ersten Speichern nicht mehr ändern – bereits eingelagerte Artikel sind per `material_type = key` zugeordnet.

### Features

- **Lieferschein-Scan:** Lieferschein fotografieren → KI extrahiert alle Positionen automatisch
- **Mindestbestand:** Warnung wenn Bestand unter Schwellwert fällt
- **Einlagern / Bearbeiten:** Modal mit KI-gestützter Leistungsbeschreibung (✨ KI-Button)
- **Verschieben:** Material zwischen Tabs verschieben
- **Entnahme:** Direkt einer Baustelle zuordnen

---

## 🏢 Firmendaten anpassen

Firmendaten werden über **`/admin/company-settings`** direkt in der App gepflegt:

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
| `ADMIN` | Wie Chef, aber Geldbeträge ausgeblendet (konfigurierbar) |
| `EMPLOYEE` | Monteur – sieht Aufträge, Kalender, eigene Zeiterfassung, Schwarzes Brett, Urlaub |

Zugriffsrechte für ADMIN und EMPLOYEE sind im Admin-Panel unter **🔐 Zugriff** feingranular konfigurierbar.

---

## 📁 Projektstruktur

```
metallbau-app/
├── server.js                       # Einstiegspunkt: Middleware, globale Routen (Suche, RFID, KI, Dark-Mode)
├── config/
│   └── database.js                 # DB-Verbindung (PostgreSQL / SQLite) + erster Chef-User
├── middleware/
│   └── auth.js                     # JWT-Verifikation, requireAdmin, requireChef, hasPerm
├── routes/
│   ├── authRoutes.js               # Login / Logout / Standard-Admin anlegen
│   ├── adminRoutes.js              # Mitarbeiter, Arbeitszeiten-Admin, Ticker, Personalplanung, RFID
│   ├── dashboardRoutes.js          # Dashboard (Chef & Mitarbeiter), Widget-Einstellungen
│   ├── projectRoutes.js            # Aufträge, Aufmaß, Aufgaben, Chat, Notizen, Fotos, Nachkalkulation
│   ├── customerRoutes.js           # Kunden & verknüpfte Dateien
│   ├── calendarRoutes.js           # Termine, Mitarbeiter-Zuweisung, Wetter-API
│   ├── timetrackingRoutes.js       # Stempeluhr, GPS, Geo-Fencing, Monatsauswertung, PDF
│   ├── vacationRoutes.js           # Urlaubsanträge, Status, Jahresanspruch
│   ├── documentRoutes.js           # Angebote → Rechnungen, Nachträge, PDFs
│   ├── lagerRoutes.js              # Lagerverwaltung, Entnahmen, Reststücke, KI-Scan
│   ├── articleRoutes.js            # Artikelstamm (CRUD)
│   ├── companySettingsRoutes.js    # Firmendaten, Logo-Upload, Admin-Panel, Lager-Tabs
│   ├── reportsRoutes.js            # Auswertungen & Berichte
│   └── apiRoutes.js                # REST-API v2
├── utils/
│   ├── db.js                       # dbQuery-Hilfsfunktion (SQLite & PostgreSQL kompatibel)
│   ├── companySettings.js          # Firmendaten aus DB laden (mit In-Memory-Cache)
│   ├── cloudinaryStorage.js        # Eigener Multer-Storage-Adapter für Cloudinary v2
│   ├── migrations.js               # Leichtgewichtiges DB-Migrations-System
│   ├── notifier.js                 # WhatsApp (CallMeBot)
│   ├── backup.js                   # Automatisches DB-Backup per E-Mail
│   └── holidays.js                 # NRW-Feiertage (für Urlaubsberechnung)
├── views/
│   ├── partials/
│   │   ├── header.ejs              # HTML-Head, CSS, Dark Mode, Toast, Bottom Nav
│   │   └── sidebar.ejs             # Navigation, Suche, Sidebar-Einstellungen
│   ├── dashboard.ejs               # Chef-Dashboard (KPI, überfällige Tasks, Schwarzes Brett)
│   ├── dashboard-employee.ejs      # Mitarbeiter-Dashboard (Ampel, Stunden)
│   ├── staffplan.ejs               # Personalplanung (Wochenplan)
│   ├── projects.ejs                # Auftragsliste (Filter, Archiv-Toggle)
│   ├── project-detail.ejs          # Auftragsdetail (Aufmaß, Aufgaben, Chat, Stunden, KI)
│   ├── project-board.ejs           # Kanban-Board
│   ├── project-invoice-create.ejs  # Rechnung aus Auftrag
│   ├── calendar.ejs                # Terminkalender + Urlaubskalender
│   ├── timetracking.ejs            # Stempeluhr (GPS, Geo-Fencing)
│   ├── admin-timetracking.ejs      # Arbeitszeiten-Übersicht (alle Mitarbeiter)
│   ├── time-monthly.ejs            # Monatliche Stundenübersicht + PDF-Export
│   ├── vacations.ejs               # Urlaub & Abwesenheit
│   ├── customers.ejs               # Kundenliste
│   ├── customer-projects.ejs       # Projekte je Kunde
│   ├── admin-users.ejs             # Mitarbeiterverwaltung (WhatsApp, RFID)
│   ├── admin-panel.ejs             # Admin-Einstellungen (inkl. Lager-Tab-Verwaltung)
│   ├── company-settings.ejs        # Firmendaten & Logo
│   ├── lager.ejs                   # Lagerverwaltung (dynamische Tabs, KI-Scan)
│   ├── invoices.ejs / offers.ejs   # Rechnungs- / Angebotsliste
│   ├── offer-detail.ejs            # Angebotsdetail (KI-Leistungsbeschreibung, Nachträge)
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
| `/projects/:id/chat/add` | POST | Alle | Chat-Nachricht senden |
| `/projects/:id/chat/messages` | GET | Alle | Neue Nachrichten polling |
| `/projects/:id/pdf` | GET | Admin | Lieferschein-PDF |
| `/projects/:id/create-invoice` | GET/POST | Admin | Rechnung aus Auftrag erstellen |
| `/projects/update-status` | POST | Admin | Schnellstatus (AJAX) |
| `/project-board` | GET | Alle | Kanban-Board |

### Zeiterfassung

| Route | Methode | Zugriff | Beschreibung |
|---|---|---|---|
| `/timetracking` | GET | Alle | Stempeluhr |
| `/timetracking/stamp` | POST | Alle | Stempeln (IN / OUT / SWITCH) |
| `/timetracking/admin/monthly` | GET | Alle* | Monatsauswertung |
| `/timetracking/admin/export-csv` | GET | Alle* | CSV-Export |
| `/timetracking/admin/export-pdf` | GET | Alle* | PDF-Stundenzettel |
| `/admin/timetracking` | GET | Admin | Alle Mitarbeiter |

> *) Mitarbeiter sehen nur eigene Daten. Fremde `user_id` im Query-Parameter nur für Admin/Chef erlaubt.

### Kalender & Urlaub

| Route | Methode | Beschreibung |
|---|---|---|
| `/calendar` | GET | Terminkalender + Urlaubskalender |
| `/vacations` | GET | Urlaub & Abwesenheit |
| `/vacations/add` | POST | Antrag stellen |
| `/vacations/status` | POST | Genehmigen / Ablehnen (Admin) |

### Lager

| Route | Methode | Beschreibung |
|---|---|---|
| `/lager` | GET | Lagerliste (Tab via `?tab=`) |
| `/lager/add` | POST | Material einlagern |
| `/lager/edit` | POST | Eintrag bearbeiten |
| `/lager/move` | POST | Material zwischen Tabs verschieben |
| `/lager/delete` | POST | Eintrag löschen |
| `/lager/entnahme` | POST | Entnahme buchen |
| `/lager/rest/add` | POST | Reststück einlagern |
| `/lager/scan` | POST | Lieferschein-Bild per KI analysieren |
| `/lager/scan-save` | POST | KI-Scan-Ergebnis speichern |

### Admin

| Route | Methode | Beschreibung |
|---|---|---|
| `/admin/users` | GET | Mitarbeiterverwaltung |
| `/admin/users/add` | POST | Neuen Account anlegen |
| `/admin/users/set-rfid` | POST | RFID-UID zuweisen |
| `/admin/staffplan` | GET | Personalplanung – Wochenplan |
| `/admin/company-settings` | GET/POST | Firmendaten & Logo |
| `/admin/panel` | GET | Admin-Einstellungen |
| `/admin/panel/lager` | POST | Eigene Lager-Tabs speichern |

### Dokumente & Artikel

| Route | Methode | Beschreibung |
|---|---|---|
| `/documents/offers` | GET | Angebote |
| `/documents/offers/:id` | GET | Angebotsdetail |
| `/documents/offers/:id/nachtraege/create` | POST | Nachtrag anlegen |
| `/documents/nachtrag/approve/:token` | GET/POST | Öffentlicher Freigabe-Link |
| `/documents/invoices` | GET | Rechnungen |
| `/documents/invoices/:id` | GET | Rechnungsdetail |
| `/documents/invoices/:id/pdf-download` | GET | PDF-Download |
| `/articles` | GET | Artikelstamm |

### API

| Route | Methode | Beschreibung |
|---|---|---|
| `/api/search` | GET | Globale Suche |
| `/api/today-hours` | GET | Heutige Arbeitsstunden |
| `/api/dark-mode` | POST | Dark-Mode serverseitig speichern |
| `/api/rfid/stamp` | POST | RFID-Stempel (gesichert per `X-RFID-Key`, fail-closed) |
| `/api/weather` | GET | Wettervorhersage (Open-Meteo) |

### KI-Endpunkte

| Route | Beschreibung |
|---|---|
| `/api/ai/offer-assistant` | Angebotspositionen aus Freitext |
| `/api/ai/offer-assistant-image` | Angebotspositionen aus Foto |
| `/api/ai/expand-position` | Leistungsbeschreibung aus Stichpunkten |
| `/api/ai/defect-analyze` | Mängelanalyse aus Bauteil-Foto |
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

> 💡 Es gibt **keine hartcodierten Standard-Zugangsdaten**.  
> Falls das Passwort verloren geht, lösche den `chef`-Eintrag in der Datenbank – beim nächsten Start wird ein neues generiert.

---

## 📝 Lizenz

Privates Projekt – alle Rechte vorbehalten.  
Entwickelt von **Domenic Rosic**.
