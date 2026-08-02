# 🔒 Metallbau-App - Sichere Version

Eine vollständige Metallbau-Management-Lösung mit integrierten Sicherheitsfeatures.

## ✨ Neue Sicherheitsfeatures

### 🛡️ Automatische Sicherheitsprüfungen
- **npm audit** läuft automatisch beim Serverstart
- Blockiert Start bei kritischen Sicherheitsproblemen
- Wöchentliche automatische Dependency-Updates via Dependabot

### 🔐 Geschützte Credentials
- `.env` Dateien sind vollständig im `.gitignore`
- `.env.example` enthält Template für alle notwendigen Variablen
- Keine Secrets werden jemals im Repository gelagert

### 🔑 Authentifizierung & Verschlüsselung
- Passwörter mit **bcryptjs** gehasht (10 Runden)
- JWT-Tokens für sichere Sessions
- Cookie-Parser für sichere Cookie-Verwaltung

### 📦 Dependency-Management
- Automatische Sicherheitsupdates
- npm audit auf jedes Start
- Regelmäßige Überprüfung auf Vulnerabilities

## 🚀 Installation

```bash
# Dependencies installieren
npm install

# .env Datei erstellen (von .env.example kopieren)
cp .env.example .env
# Jetzt .env mit echten Werten ausfüllen!

# Server mit Sicherheitsprüfung starten
npm start

# Oder ohne Prüfung starten (falls notwendig)
npm run start:force
```

## 📋 Verfügbare Commands

| Befehl | Beschreibung |
|--------|-------------|
| `npm start` | Startet Server mit npm audit Prüfung |
| `npm run start:force` | Startet Server ohne Audit |
| `npm run audit` | Zeigt Sicherheitsprobleme |
| `npm run audit:fix` | Versucht automatische Fixes |

## 📁 Projektstruktur

```
metallbau-app/
├── .env.example          # Template für Umgebungsvariablen
├── .gitignore            # Verbessert mit Security Best Practices
├── SECURITY.md           # Sicherheitsrichtlinien
├── package.json          # Mit npm audit beim Start
├── server.js             # Express Server
├── .github/
│   └── dependabot.yml    # Automatische Dependency-Updates
├── scripts/
│   └── audit.sh          # Audit-Skript
└── docs/
    └── SCRIPTS.md        # Dokumentation
```

## 🔒 Umgebungsvariablen

Alle erforderlichen Umgebungsvariablen finden sich in `.env.example`:

```env
# Server
PORT=3000
NODE_ENV=production

# Database
DB_HOST=localhost
DB_NAME=metallbau_db
DB_USER=your_user
DB_PASSWORD=your_password

# JWT (Mindestens 32 Zeichen!)
JWT_SECRET=your_super_secret_jwt_key_change_this

# Cloudinary (für Bild-Uploads)
CLOUDINARY_CLOUD_NAME=...
CLOUDINARY_API_KEY=...
CLOUDINARY_API_SECRET=...
```

## 🛡️ Sicherheitschecklist

- ✅ `.env` im `.gitignore`
- ✅ npm audit beim Start
- ✅ Dependabot aktiviert
- ✅ Passwörter mit bcryptjs gehasht
- ✅ JWT-Tokens verschlüsselt
- ✅ HTTPS bereit (in Production)
- ✅ Cookie-Secure in Production

## 📝 Sicherheitsrichtlinien

Siehe `SECURITY.md` für:
- Vulnerability Reporting
- Best Practices für Entwickler
- Abhängigkeitssicherheit
- Deployment-Checkliste

## 🚀 Deployment

1. `.env` mit echten Secrets konfigurieren
2. `npm install` ausführen
3. `npm start` startet Server mit Security Checks
4. Logs prüfen auf Audit-Ergebnisse

## 📞 Support

Bei Sicherheitsfragen siehe `SECURITY.md` für Kontaktinformationen.

---

**Zuletzt aktualisiert:** 2026-08-02
