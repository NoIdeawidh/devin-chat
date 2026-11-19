# Devin-Chat

Ein privater Chat (wie ChatGPT/Claude) für Henri. Das Web-Frontend läuft als
statische Seite (GitHub Pages unter `/devin-chat/`), Supabase speichert Chats
und Nachrichten, und ein Node-Worker auf dem PC holt sich offene Nachrichten,
lässt sie von der Devin CLI beantworten und schreibt das Ergebnis zurück.

## Teile

- `docs/` – statisches Frontend (kein Build-Schritt, alle Pfade relativ).
- `worker/` – Node-24-Worker (ESM), einzige Dependency `@supabase/supabase-js`.
- Supabase-Tabellen: `chats`, `messages`, `models`, `worker_status`.

## Worker starten

```powershell
cd worker
npm install
copy .env.example .env   # Passwort eintragen
.\start-worker.cmd        # sichtbar, oder:
wscript start-hidden.vbs  # versteckt im Hintergrund
```

Der Worker schreibt `worker/worker.log`, legt pro Chat ein Arbeitsverzeichnis
unter `worker/sessions/<chat_id>/` an (Kontext über `-c`) und hält den PC wach.

## Tests

```powershell
cd worker
node --test
```
