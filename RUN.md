# SeedWorld — Run Instructions (MVP Foundations v2.4)

## Prerequisites

- Node.js 24+
- npm 11+

## Install

```bash
npm install
```

## Development Commands

```bash
npm run dev:server
npm run dev:desktop
npm run dev:web
npm run dev:mobile
```

## Desktop Packaging

```bash
npm run make
```

## Architecture Snapshot

- `apps/desktop`: Electron desktop app (main owns filesystem/secrets/sync).
- `apps/web`: Vite + React shell.
- `apps/mobile`: Expo shell.
- `packages/core`: Shared event model, migrations, projection and sync engine.
- `services/sync-server`: Self-hosted sync server.

## Sync Server Notes

Default server URL: `http://localhost:8787`

For LAN/phone testing, start with:

```bash
HOST=0.0.0.0 PORT=8787 npm run dev:server
```

The server stores:

- SQLite metadata (`data/sync.db`, WAL mode)
- Blob bytes in filesystem (`data/blobs/<hash>`)

## Local Multi-Device Sync Test

1. Start server for LAN testing:
   - `HOST=0.0.0.0 PORT=8787 npm run dev:server`
2. Launch desktop and web (or mobile):
   - `npm run dev:desktop`
   - `npm run dev:web`
   - `npm run dev:mobile`
3. On phone (same LAN as dev machine):
   - open `http://<your-computer-LAN-IP>:5260`
   - in Web Settings, set `serverUrl` to `http://<your-computer-LAN-IP>:8787`
4. In each client sign in with:
   - same `workspaceId`
   - different `deviceId` (desktop auto-generated; web/mobile independent)
5. Capture while signed out to confirm local-only mode (capture must still succeed).
6. Create additional captures offline on each client.
7. Reconnect network and press **Sync now**.
8. Verify all clients converge to the same Inbox count with no duplicates.

## Import/Restore

Desktop import supports:

- `Restore`: keep source `workspaceId`
- `Clone`: generate new `workspaceId` and rewrite imported event workspace references

Web/mobile MVP import supports portable state + atoms (blobs may be pulled later by hash).

## Export Contents

`export.zip` includes:

- `atoms/`
- `events/events.jsonl`
- `blobs/` (available local blob bytes)
- `portable/state.json`
- `manifest.json` with:
  - `eventSchemaVersion`
  - `minSupportedEventSchemaVersion`
  - `referencedBlobs`

## Diagnostics

Diagnostics include:

- last sync success
- pending events/blobs
- last error with code
- last N sync attempts timeline
- replication cursors (`lastPulledSeq`, `lastAppliedSeq`)

Desktop provides:

- **Copy diagnostics summary**
- **Export diagnostics ZIP**

## Acceptance Checklist (Phone-friendly)

- [ ] Capture in Web/Mobile shows immediately as saved locally.
- [ ] Capture works while signed out (local mode), with no auth prompt blocking capture.
- [ ] Turn on airplane mode (or disable network), capture still succeeds.
- [ ] Re-enable network and press **Sync now**; capture appears on Desktop.
- [ ] Run concurrent edits on one atom from two clients; conflict is preserved as needs-resolution.
- [ ] Export ZIP succeeds and includes required folders/files.
- [ ] Import restore/clone works with clear mode selection and resulting workspace behavior.
