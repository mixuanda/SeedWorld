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

## Verify IPC

Open DevTools (Ctrl+Shift+I) and run in the console:

```javascript
await window.api.ping()
// Expected: "pong"
```
