# SeedWorld

SeedWorld is an **offline-first quick-capture** app that helps you capture fleeting ideas instantly and organize them later—without forcing you into a heavy workflow.

**Current stage:** pre-release (alpha)  
**Primary focus:** Desktop UX (Quick Capture → Past Notes → Organize), with a local “vault folder” you own.

---

## Philosophy: Storage & Sync (Current Stage)

SeedWorld stores data in a **local vault folder**.  
For **multi-device sync**, place the vault folder inside a cloud-synced directory (OneDrive / iCloud Drive / Dropbox / Syncthing / NAS, etc.). SeedWorld does not manage cloud authentication or syncing—your provider does.

> Built-in self-hosted sync exists as an *experimental* direction, but it is **not the default** in the current stage.

---

## Features

### ✅ Core
- **Quick Capture-first**: open → type → save instantly
- **Past Notes**: browse what you captured
- **Local Vault**: human-readable files under a folder you choose

### 🧪 Evolving / WIP
- **Voice capture** + pipeline for transcription
- **AI analysis** hooks (workflow and UX are still evolving)
- **i18n + Themes**: Dark / Light / System and language switching

---

## Downloads

Go to **GitHub → Releases** and download:
- **macOS**: `.dmg`
- **Windows (portable)**: `.zip` (no installer)

Each release also provides **`SHA256SUMS.txt`** for verification.

---

## Keyboard Shortcuts

- **Cmd/Ctrl + Enter** — Save capture instantly
- **Cmd/Ctrl + L** — Focus the capture input

(Shortcuts may expand over time.)

---

## Project Structure (Monorepo)

This repo uses **npm workspaces**:

- `apps/desktop` — Electron desktop app (main user-facing app today)
- `packages/core` — shared logic (where applicable)
- `services/*` — experimental / future services

---

## Development

### Prerequisites
- **Node.js 22+ recommended** (some builds depend on Node built-ins such as `node:sqlite`)
- npm

### Install
```bash
git clone https://github.com/mixuanda/SeedWorld.git
cd SeedWorld
npm ci
```

### Run Desktop (Dev)
```bash
npm run dev:desktop
```

### Lint / Test
```bash
npm run lint
npm run test
```

### Package Desktop (Local)
```bash
npm run make --workspace @seedworld/desktop
```

Build artifacts typically appear under:
- `apps/desktop/out/`

---

## Release: Tags → Auto-publish GitHub Release

This repo can auto-build and publish a GitHub Release **when you push a version tag**.

### 1) Commit & push changes
```bash
git add -A
git commit -m "feat: ..."
git push
```

### 2) Create and push a tag
Example:
```bash
git tag -a v0.2.1-alpha.5 -m "SeedWorld v0.2.1-alpha.5"
git push origin v0.2.1-alpha.5
```

GitHub Actions will:
- Build macOS `.dmg`
- Build Windows portable `.zip`
- Generate `SHA256SUMS.txt`
- Create a GitHub Release and upload assets

> **Important:** Do not reuse tags. Use a new tag for each release.

### If you tagged the wrong version
Prefer creating a new tag (cleaner).  
If you must delete a tag:

```bash
git tag -d v0.2.1-alpha.5
git push origin :refs/tags/v0.2.1-alpha.5
```

You may also need to delete the corresponding GitHub Release in the GitHub UI.

---

## Acceptance Checklist (Quick)

- [ ] First launch shows onboarding CTA to select/create a vault folder
- [ ] App lands on **Quick Capture** with focused input
- [ ] `Cmd/Ctrl + Enter` saves instantly; input clears and refocuses
- [ ] **Past Notes** shows the newly saved note
- [ ] Theme (System/Dark/Light) persists after restart
- [ ] Language selection persists after restart
- [ ] Vault placed in OneDrive/Dropbox syncs externally (provider-managed)

---

## Troubleshooting

### “electron-forge: command not found”
Run:
```bash
npm ci
```
If still failing, ensure the desktop workspace includes the Electron Forge CLI dev dependency and scripts resolve local binaries.

### Release assets show an older version number in filenames
Artifact filenames come from the **app/package version at build time**, not the Git tag name shown on GitHub.  
If you want filenames to match the tag, ensure the release workflow derives the version from the tag **before** `make`.

### “Pattern does not match any files” during release upload
Often harmless if a platform doesn’t produce that file type (e.g., mac job won’t produce `.exe`).  
Best practice is: build per OS, upload workflow artifacts, then publish the release once in a final job.

---

## Roadmap (High-level)

- Even faster capture surface (ultra-minimal mode)
- Better organization (tags, structures, review flows)
- Voice → Transcript → Note workflow polish
- Optional built-in sync as an experimental feature

---

## License

TBD (add a LICENSE file when ready).
