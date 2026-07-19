---
name: ektoswhispr-cli
description: Use this skill whenever the user wants to operate on EktosWhispr notes, folders, transcriptions, or audio from a terminal or shell while the EktosWhispr desktop app is running. The CLI talks to the desktop app's local loopback bridge (`src/helpers/cliBridge.js`) — there is no cloud backend in this offline fork. Trigger this skill when the user mentions "ektoswhispr cli", running shell commands against EktosWhispr, automating note workflows, or scripting any EktosWhispr operation — even if they don't say "CLI" explicitly.
---

# EktosWhispr CLI (local bridge only)

This offline fork has no first-party cloud API — do not assume a `remote`/cloud backend, API keys, or hosted service exist. The only backend a CLI (or any external tool) can talk to is the desktop app's **local loopback bridge**, implemented in `src/helpers/cliBridge.js` and documented in [CLAUDE.md](../../CLAUDE.md) under `cliBridge.js`.

## How the bridge works

- Started by the running desktop app on a port in `8200`–`8219` (first available), bound to `127.0.0.1` only.
- On start, writes `{version, port, token}` to `~/.ektoswhispr/cli-bridge.json`, mode `0600`.
- Every request must come from a loopback address (`127.0.0.1`, `::1`, `::ffff:127.0.0.1`) and carry `Authorization: Bearer <token>` matching the token in that file — otherwise `403`/`401`.
- Max request body: 1 MB.
- If the desktop app isn't running, the bridge file is stale/missing and there is nothing to connect to — there is no fallback cloud backend.

## Endpoints (ground truth: `cliBridge.js`)

All responses are JSON. Errors use `{ "error": { "code": "...", "message": "..." } }`.

| Method | Path                          | Notes                                                                                          |
| ------ | ----------------------------- | ----------------------------------------------------------------------------------------------- |
| GET    | `/v1/health`                  | `{ data: { ok: true, version: 1 } }`                                                            |
| GET    | `/v1/notes/list`              | Query: `note_type`, `limit` (default 100), `folder_id`                                          |
| GET    | `/v1/notes/search`            | Query: `q` (required), `limit` (default 20)                                                     |
| GET    | `/v1/notes/:id`                | 404 if missing or soft-deleted                                                                   |
| POST   | `/v1/notes/create`            | Body: `title`, `content`, `note_type` (default `personal`), `source_file`, `audio_duration_seconds`, `folder_id`. Returns `201`. |
| PATCH  | `/v1/notes/:id`                | Body: any subset of the create fields                                                            |
| DELETE | `/v1/notes/:id`                | Soft-delete. Returns `204`.                                                                       |
| GET    | `/v1/folders/list`            |                                                                                                    |
| POST   | `/v1/folders/create`          | Body: `name` (required). Returns `201`.                                                          |
| GET    | `/v1/transcriptions/list`     | Query: `limit` (default 50)                                                                      |
| GET    | `/v1/transcriptions/:id`       | 404 if missing or soft-deleted                                                                   |
| DELETE | `/v1/transcriptions/:id`       | Returns `204`.                                                                                    |
| DELETE | `/v1/transcriptions/:id/audio` | Deletes the stored audio file for a transcription. Returns `204`.                                |

There is no `/v1/usage` endpoint and no scoped API keys — the bridge token grants full local access to whatever's running.

## Error codes

| HTTP Status | Code               | Meaning                                  |
| ----------- | ------------------- | ----------------------------------------- |
| 400         | `validation_error`  | Invalid request body or missing param    |
| 401         | `unauthorized`      | Missing/incorrect bearer token           |
| 403         | `forbidden`         | Request didn't originate from loopback   |
| 404         | `not_found`         | Resource doesn't exist or was deleted    |
| 500         | `internal_error`    | Server error                             |

## Using it from a shell

Read the bridge file to get the port and token, then call the endpoints directly:

```bash
BRIDGE=~/.ektoswhispr/cli-bridge.json
PORT=$(jq -r .port "$BRIDGE")
TOKEN=$(jq -r .token "$BRIDGE")

curl -s -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$PORT/v1/notes/list?limit=10"

curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"content": "Remember to review PR #42", "title": "TODO"}' \
  "http://127.0.0.1:$PORT/v1/notes/create"
```

If `~/.ektoswhispr/cli-bridge.json` doesn't exist or a request to its port fails, the desktop app isn't running — start it first. There is no other backend to fall back to.
