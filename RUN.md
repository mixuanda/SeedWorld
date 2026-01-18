# World-Seed — Run Instructions (Windows)

## Prerequisites

- Node.js 18+ (LTS recommended)
- npm 9+

## Install

```powershell
npm install
```

## Development

```powershell
npm start
```

This starts the Electron app in development mode with hot reload.

## Test

```powershell
npm test
```

> Note: Tests are placeholder for bootstrap phase.

## Build / Package

```powershell
npm run make
```

Creates platform-specific distributables in the `out/` folder.

---

## Security Configuration

The app runs with strict Electron security settings:

| Setting | Value | Description |
|---------|-------|-------------|
| `nodeIntegration` | `false` | Node.js APIs not available in renderer |
| `contextIsolation` | `true` | Preload runs in isolated context |
| `sandbox` | `true` | Renderer is sandboxed |

All privileged operations go through the preload bridge (`window.api`).

---

## Vault Structure

The vault is a user-selected folder (recommend OneDrive) with this structure:

```
vault/
├── notes/              # Atomic notes (.md with YAML frontmatter)
├── attachments/
│   └── audio/          # Audio recordings
├── transcripts/        # Audio transcriptions
├── changesets/         # AI-generated ChangeSets (.json)
└── structures/         # Synthesized structure documents
```

**On startup**, missing subdirectories are recreated automatically.

---

## Atomic Writes

All vault writes use atomic operations to prevent corruption:

1. Write to temp file (`.n_abc123.xyz789.tmp`)
2. `fsync` the file (best effort)
3. Rename to final filename (atomic on most filesystems)

**Benefits:**
- Interrupted writes (crash, kill) don't corrupt existing files
- Worst case: orphaned `.tmp` file (cleaned up on next startup)
- OneDrive-safe: no partial syncs of incomplete files

---

## Verify IPC

Open DevTools (Ctrl+Shift+I) and run in the console:

```javascript
await window.api.ping()
// Expected: "pong"

await window.api.vault.getPath()
// Expected: "C:\\Users\\...\\OneDrive\\WorldSeed" (or null if not set)
```
