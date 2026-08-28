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
