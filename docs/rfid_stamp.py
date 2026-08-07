#!/usr/bin/env python3
"""
RFID Stempeluhr – Raspberry Pi Script
======================================
Hardware:
  - Raspberry Pi (beliebiges Modell mit WLAN)
  - RC522 RFID-Lesegerät (SPI-Anschluss)
  - Optional: rote + grüne LED an GPIO, Buzzer an GPIO

Installation:
  sudo apt update && sudo apt install -y python3-pip python3-spidev
  pip3 install mfrc522 requests RPi.GPIO

Verkabelung RC522 → Raspberry Pi GPIO:
  SDA  → GPIO 8  (Pin 24)
  SCK  → GPIO 11 (Pin 23)
  MOSI → GPIO 10 (Pin 19)
  MISO → GPIO 9  (Pin 21)
  GND  → GND     (Pin 6)
  RST  → GPIO 25 (Pin 22)
  3.3V → 3.3V    (Pin 1)

Konfiguration:
  APP_URL    = URL deiner App (z.B. https://deine-app.onrender.com)
  RFID_KEY   = Wert aus deiner .env → RFID_API_KEY
  LED_GREEN  = GPIO-Pin grüne LED (0 = deaktiviert)
  LED_RED    = GPIO-Pin rote LED  (0 = deaktiviert)
  BUZZER_PIN = GPIO-Pin Buzzer    (0 = deaktiviert)

Autostart:
  sudo nano /etc/systemd/system/rfid-stamp.service
  → Inhalt:
     [Unit]
     Description=RFID Stempeluhr
     After=network.target

     [Service]
     ExecStart=/usr/bin/python3 /home/pi/rfid_stamp.py
     Restart=always
     User=pi

     [Install]
     WantedBy=multi-user.target

  sudo systemctl enable rfid-stamp
  sudo systemctl start rfid-stamp
"""

import time
import requests
import RPi.GPIO as GPIO

# ── Konfiguration ──────────────────────────────────────────────────────────────
APP_URL    = "https://deine-app.onrender.com"   # ← HIER deine App-URL eintragen
RFID_KEY   = "ein_langes_geheimes_passwort_hier_einsetzen"  # ← aus .env → RFID_API_KEY

LED_GREEN  = 17   # GPIO-Pin grüne LED  (0 = nicht vorhanden)
LED_RED    = 27   # GPIO-Pin rote LED   (0 = nicht vorhanden)
BUZZER_PIN = 22   # GPIO-Pin Buzzer     (0 = nicht vorhanden)

COOLDOWN_SECONDS = 3   # Mindestabstand zwischen zwei Scans desselben Chips
# ──────────────────────────────────────────────────────────────────────────────

# GPIO Setup
GPIO.setmode(GPIO.BCM)
GPIO.setwarnings(False)
if LED_GREEN:  GPIO.setup(LED_GREEN,  GPIO.OUT, initial=GPIO.LOW)
if LED_RED:    GPIO.setup(LED_RED,    GPIO.OUT, initial=GPIO.LOW)
if BUZZER_PIN: GPIO.setup(BUZZER_PIN, GPIO.OUT, initial=GPIO.LOW)

last_scan = {}   # uid → timestamp – verhindert Doppel-Scans


def beep(pin, duration=0.1, count=1):
    if not pin:
        return
    for _ in range(count):
        GPIO.output(pin, GPIO.HIGH)
        time.sleep(duration)
        GPIO.output(pin, GPIO.LOW)
        time.sleep(0.05)


def led_ok():
    if LED_GREEN:
        GPIO.output(LED_GREEN, GPIO.HIGH)
        time.sleep(1.2)
        GPIO.output(LED_GREEN, GPIO.LOW)


def led_err():
    if LED_RED:
        GPIO.output(LED_RED, GPIO.HIGH)
        time.sleep(1.2)
        GPIO.output(LED_RED, GPIO.LOW)


def send_stamp(uid: str):
    """Sendet die UID an die App-API und gibt die Antwort zurück."""
    try:
        resp = requests.post(
            f"{APP_URL}/api/rfid/stamp",
            json={"uid": uid},
            headers={"X-RFID-Key": RFID_KEY, "Content-Type": "application/json"},
            timeout=8,
        )
        return resp.json()
    except Exception as e:
        print(f"[FEHLER] Netzwerk: {e}")
        return None


def on_card_detected(uid: str):
    uid = uid.upper()
    now = time.time()

    # Cooldown prüfen (selber Chip zu schnell)
    if uid in last_scan and now - last_scan[uid] < COOLDOWN_SECONDS:
        return
    last_scan[uid] = now

    print(f"[SCAN] UID: {uid}")
    result = send_stamp(uid)

    if result and result.get("ok"):
        stamp_type = result.get("type", "?")
        username   = result.get("username", "?")
        print(f"[OK] {username} → {stamp_type}")
        beep(BUZZER_PIN, 0.08, 1 if stamp_type == "IN" else 2)
        led_ok()
    else:
        error = result.get("error", "Unbekannter Fehler") if result else "Keine Antwort"
        print(f"[FEHLER] {error}")
        beep(BUZZER_PIN, 0.4, 3)
        led_err()


def main():
    try:
        from mfrc522 import SimpleMFRC522
        reader = SimpleMFRC522()
        print("[RFID-Stempeluhr] Bereit – Chip ans Lesegerät halten …")
        while True:
            try:
                uid, _ = reader.read_no_block()
                if uid:
                    on_card_detected(str(uid))
            except Exception as e:
                print(f"[WARN] Lesefehler: {e}")
            time.sleep(0.3)
    except KeyboardInterrupt:
        print("\n[RFID-Stempeluhr] Beendet.")
    finally:
        GPIO.cleanup()


if __name__ == "__main__":
    main()
