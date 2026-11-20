# Session-Memo – 2026-11-20

## Ziel
Devin Remote (Linear WOR-150): devin-chat wird mobile Fernbedienung für Devin Desktop via ACP (`devin acp --process-model daemon`). Plan: `C:\Users\HenriB\.devin\plans\devin-remote.md` (verbindlich). Repo `C:\Users\HenriB\Projects\devin-chat`, Branch main, öffentlich – keine Geheimnisse.

## Stand
- Phase 0 fast fertig: Autostart-Lnk `devin-chat-worker.lnk` in shell:startup angelegt; Login-Input hat autocapitalize/autocorrect/spellcheck-Attribute (uncommitted); `.env` in .gitignore ok.
- Phase 1 fast fertig: Config gefunden `C:\Users\HenriB\AppData\Roaming\Devin\config.json`, Backup `config.json.bak-20261120` erstellt, `process_model:"daemon"` gesetzt (uncommitted-relevant, außerhalb Repo). Desktop NICHT neu starten (Henri in Sitzung spicy-lillipilli).
- Phase 2/3+/4/5/6 ausstehend.

## Entscheidungen
- Ich habe keine Subagent-Spawn-Möglichkeit → Phase 3 (worker/) und Phase 4 (docs/) mache ich selbst, strikt disjunkt über worker/PROTOCOL.md.
- Alter Worker (PID 3268, -r/session.json-Flow) läuft noch; wird nach Migration obsolet (aal2) → am Ende via wscript start-hidden.vbs neu als Bridge starten.
- Subagent-Aufteilung nicht möglich → selbst umsetzen, als Abweichung melden.

## Erkenntnisse
- MCP `supabase-remote` hat execute_sql/apply_migration.
- `devin list --format json`, `devin rm <id> --force`, `-r <id> -p` funktionieren; Lock nur bei interaktiv offener Sitzung.
- probe/acp.mjs = funktionierender JSON-RPC-Client.
- SQL liegt in `C:\Users\HenriB\.devin\plans\devin-remote-sql\0{1,2,3}-*.sql` – unverändert ausführen.

## Offen
- Exakte ACP-Methodennamen set_mode/set_config_option/rename/cancel/MCP-Auth per Probe ermitteln.
- MCP-OAuth vom Handy: offen.
- Neue bcrypt-Hashes lokal erzeugen (bcrypt-Tool nötig, z. B. node bcryptjs oder python).

## Nächste Schritte
1. Phase 0 Commit. 2. Phase 2: Bridge-Passwort+Hash lokal, .env (BRIDGE_*), 01-sql via execute_sql → bridge uid; 02-sql __BRIDGE_UID__ → apply_migration devin_remote. 3. PROTOCOL.md. 4. ACP-Probe. 5. worker.js Bridge + Tests + Live-Test (probe/). 6. docs/ Frontend. 7. E2E 390×844 + Test-TOTP (danach entfernen). 8. Neues PW (4 Wörter+Zahl) → `C:\Users\HenriB\.devin\plans\devin-remote-pw.txt`, bcrypt update, CHAT_PASSWORD aus .env, push, Bridge detached starten, Smoke-Test.

## Kontext
- worker/lib.js: buildSpawnEnv, parseModels, cleanAnswer, buildPrompt, buildSyncPrompt, isLockedError, newestSession, newSessionId.
- OWNER_ID=fd898a7a-bda3-45d4-a3d2-b7ed9990e591 (Henri, aal2 nötig). Supabase URL https://iazsajsohlwrkijasrvx.supabase.co.
- Nicht anfassen: Desktop-Prozess, Sitzung spicy-lillipilli, state.vscdb, Henri-Chat f1b48684 (fern-marmot/dear-pewter/profuse-sandpaper).
