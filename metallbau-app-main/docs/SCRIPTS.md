# Scripts für Sicherheit und Wartung

## Audit-Skript

Das `audit.sh` Skript führt automatisch Sicherheitschecks durch:

```bash
chmod +x scripts/audit.sh
./scripts/audit.sh
```

## NPM Commands

### Automatischer Audit beim Start
```bash
npm start
```
- Prüft auf moderate und höhere Sicherheitsprobleme
- Startet Server nur wenn Check erfolgreich ist

### Erzwungener Start (ignoriert Audit)
```bash
npm run start:force
```

### Audit ohne zu starten
```bash
npm run audit
```

### Automatische Fixes
```bash
npm run audit:fix
```

## Sicherheitsprotokolle

1. **npm audit** läuft automatisch vor dem Start
2. **Abhängigkeiten** werden wöchentlich mit Dependabot aktualisiert
3. **.env Dateien** sind im `.gitignore` und werden nie committed
4. **Passwörter** sind mit bcryptjs gehasht
5. **JWT Tokens** sind signiert und verschlüsselt
