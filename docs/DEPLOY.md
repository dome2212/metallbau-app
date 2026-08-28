# Deployment (Render)

## Root Directory
Im Render-Service **Root Directory leer lassen** (bzw. auf den Ordner setzen, der direkt `server.js` und `views/` enthält).  
**Nicht** einen verschachtelten Unterordner wie `metallbau-app-main/` wählen.

## Build & Start
- **Build Command:** `npm install`
- **Start Command:** `npm start`  
  (`prestart` baut automatisch Tailwind CSS)

## Wichtige Env-Vars
Siehe `.env.example`. Mindestens:
- `PORT` (Render setzt das meist automatisch)
- `JWT_SECRET`
- Datenbank: entweder Postgres (`DB_*`) oder SQLite (`SQLITE_DB`)
- optional: Cloudinary, E-Mail, `GROQ_API_KEY`, Web-Push Keys

## Häufige Fehler
1. **Could not find include file partials/...**  
   - Root Directory falsch  
   - Oder EJS-Beispielcode mit `<%- include(...) %>` in HTML-Kommentaren (EJS führt das trotzdem aus)

2. **Kein CSS / kaputtes Layout**  
   - `Public/css/tailwind.min.css` fehlt und `npm run build:css` ist fehlgeschlagen  
   - Prüfe Build-Logs; Tailwind ist Dependency und wird per `prestart` gebaut

3. **Nested Git-Ordner**  
   Nie einen kompletten zweiten App-Ordner ins Repo committen.

## Dark Mode
Standard ist Dark Mode (`dark_mode_default: true` in Firmeneinstellungen).  
Nutzerwahl wird in `localStorage` unter `darkMode` gespeichert.

## Backup
- Admin → System/Info: **Backup herunterladen** oder per E-Mail senden
- Route: `GET /admin/backup/download` (nur Admin)

## Architektur (kurz)
- `server.js` – Bootstrap, Middleware, Cron
- `routes/aiApiRoutes.js` – KI-Endpunkte unter `/api/ai`
- `routes/rfidRoutes.js` – RFID-Stempel unter `/api/rfid`
- `views/partials/admin/tab-*.ejs` – Admin-Panel Tabs

## Deploy-Checkliste (Smoke)

1. `GET /health` → `{ ok: true, db: "up" }`
2. Login Chef / Admin / Sekretärin / Mitarbeiter
3. Dashboard lädt ohne EJS-Fehler
4. Sekretärin: Kunden + Belege sichtbar, Admin-Panel 403
5. Stempel (IN/OUT) einmal testen
6. Optional: KI-Anfrage (wenn API-Key gesetzt)

## Rechte-Test lokal

```bash
JWT_SECRET=test node scripts/test-perms.js
```

## Backup wiederherstellen
Admin → System: Datei wählen (.sqlite lokal / .sql auf Render-Postgres) → **Backup einspielen**.
Vorher immer ein frisches Download-Backup machen.
