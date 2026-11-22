# Devin Remote – Protokoll (Vertrag Bridge ↔ Frontend)

Kein Geheimnis in dieser Datei. Tabellen/Methoden/Felder sind der gemeinsame Vertrag
von `worker/` (Bridge) und `docs/` (Frontend). Änderungen nur abgestimmt.

## Tabellen (Supabase, Owner = Henri, `owner` = OWNER_ID)

### `public.rpc` – Aufträge Frontend → Bridge
Frontend (Owner mit `aal2`) legt eine Zeile an:

| Feld | Wert |
|---|---|
| `owner` | wird per Default auf `auth.uid()` gesetzt (Henri) |
| `method` | `_bridge/…` (Liste unten) |
| `params` | Methoden-Parameter |
| `status` | `pending` (Default) |

Bridge pollt `status='pending'`, setzt `status='running'`, schreibt am Ende
`status='done'` + `result` oder `status='error'` + `error={code,message}`.
Aufräumen: done/error-Rows älter als 1 Tag werden von der Bridge gelöscht.

### `public.events` – Ereignisstrom Bridge → Frontend
Append-only. Felder: `id` (bigint, monoton), `owner` (Henri), `session_id` (text, ACP-Session-Id),
`kind`, `payload` (jsonb). Aufräumen: Rows älter als 2 Tage werden gelöscht.

| `kind` | `payload` |
|---|---|
| `update` | `{bundled:[u1,u2,…]}` oder Einzel-`session/update`-Payload `{sessionId, update:{sessionUpdate,…}}` |
| `notification` | `{method, params}` einer ACP-Benachrichtigung (`_cognition.ai/*`) |
| `request` | `{rpcId, method, params}` – Agent→Client-Request (z. B. `session/request_permission`); `rpcId` ist die brückenseitige Korrelations-Id |
| `bridge` | `{type:…}` brückeninterne Ereignisse (`request_answered`, `session_closed`, `error`) |

Chunk-Bündelung: `update`-Ereignisse werden pro Session gebündelt – Flush nach
**150 ms** oder wenn das gebündelte JSON **> 4 KB** wird.

Payload-Splitting: Ist ein Event-Payload serialisiert **> 200 KB**, wird es in
mehrere Rows aufgeteilt: `payload={split:{id,seq,total},data:"<Textslice>"}` –
Frontend verkettet `data` in `seq`-Reihenfolge und parst das Ergebnis als JSON.

### `public.bridge_status` – Herzschlag (pk `owner`)
`{owner, last_seen, hostname, daemon_ok, version}` – upsert alle 30 s.

## `_bridge/*`-Methoden (rpc.method)

| Methode | params | result |
|---|---|---|
| `_bridge/ping` | `{}` | `{pong:true, version, hostname, daemon_ok}` |
| `_bridge/session/list` | `{cwd?, query?, orderBy?, sortDirection?}` | `{sessions:[{sessionId,cwd,title,updatedAt,additionalDirectories?,_meta}]}` |
| `_bridge/session/new` | `{cwd, additionalDirectories?}` | `{sessionId, modes, configOptions, _meta}` |
| `_bridge/session/load` | `{sessionId, cwd, additionalDirectories?}` | `{sessionId, modes, configOptions, _meta}` (Replay fließt als `events kind=update`) |
| `_bridge/session/close` | `{sessionId}` | `{}` |
| `_bridge/session/delete` | `{sessionId}` | `{}` |
| `_bridge/session/rename` | `{sessionId, title}` | `{}` |
| `_bridge/session/prompt` | `{sessionId, prompt:[contentBlock]}` | `{stopReason, usage?, _meta?}` – läuft synchron bis Turnende; Updates fließen als Events |
| `_bridge/session/cancel` | `{sessionId}` | `{cancelled:true}` |
| `_bridge/session/set_mode` | `{sessionId, modeId}` | `{}` |
| `_bridge/session/set_config_option` | `{sessionId, configId, value}` | `{configOptions}` |
| `_bridge/session/defaultConfigOptions` | `{cwd?}` | `{configOptions}` |
| `_bridge/respond` | `{requestEventId, response}` | `{}` – beantwortet offenen Agent→Client-Request; Bridge schreibt `events kind=bridge type=request_answered` |

Content-Block für prompt: ACP-Form, z. B. `{type:'text',text:…}` oder
`{type:'image',data:<base64>,mimeType}`.

## ACP-Methoden (verifiziert gegen `devin acp`, 2026-11-22)

- `initialize {protocolVersion:1, clientCapabilities:{fs:{readTextFile:false,writeTextFile:false},terminal:false}, clientInfo}`
- `session/list {cwd?, query?, orderBy?, sortDirection?}` – ohne `cwd`: alle Sitzungen
- `session/new {cwd, mcpServers:[], additionalDirectories?}` → `{sessionId, modes, configOptions, _meta}`
- `session/load {sessionId, cwd, mcpServers:[]}` → gleiche Form; Replay = `session/update`-Notifications
- `session/close {sessionId}` · `session/delete {sessionId}`
- `session/prompt {sessionId, prompt:[…]}` → `{stopReason:'end_turn'|'cancelled'|…, usage}`
- `session/cancel` = **Notification** (kein Response), → `stopReason:'cancelled'`
- `session/set_mode {sessionId, modeId}` → `{}`
- `session/set_config_option {sessionId, configId, value}` → `{configOptions}` (auch für `configId:'mode'` nutzbar)
- `_cognition.ai/session/rename {sessionId, title}` → `{}` (`session/rename` existiert NICHT)
- `_cognition.ai/session/defaultConfigOptions {cwd}` → `{configOptions}` (nur `{cwd}` akzeptiert)
- Agent→Client-Request `session/request_permission` → Antwort `{outcome:{outcome:'selected',optionId}}`

`session/update`-Varianten: `agent_message_chunk`, `agent_thought_chunk`,
`user_message_chunk`, `tool_call`, `tool_call_update`, `usage_update`,
`session_info_update`, `available_commands_update`, `config_option_update`,
`current_mode_update`, `plan`. Notifications: `_cognition.ai/agent_stopped`,
`_cognition.ai/turn_stats`, `_cognition.ai/output`, `_cognition.ai/mcp/serversChanged`,
`_cognition.ai/thinking_complete`.

MCP-Serverliste: **kein** Listen-Request gefunden (`mcp/list`, `_cognition.ai/mcp/*` alle
-32601); `serversChanged` kommt mit leerem `params` – Status der Server nur indirekt
(Permission/Auth-Flows oder Desktop) sichtbar.
