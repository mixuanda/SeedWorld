# SeedWorld — Run Instructions (Desktop 0.2.1-alpha.1)

## Prerequisites

- Node.js 24+
- npm 11+

## Install

```bash
npm ci
```

## Development Commands

```bash
npm run dev:desktop
npm run dev:web
npm run dev:mobile
npm run dev:server
```

## Desktop Packaging

Generate platform icons first, then package:

```bash
npm run icons:generate --workspace @seedworld/desktop
npm run make --workspace @seedworld/desktop
```

## Local Folder Vault (Default Storage Mode)

SeedWorld desktop defaults to a local vault folder (plain files).  
For multi-device sync, place the vault inside OneDrive, Dropbox, iCloud Drive, Syncthing, or another cloud-folder client.

## Experimental Self-hosted Sync

The custom sync-server flow is still in the codebase but hidden by default in `Settings -> Experimental`.

Run locally when needed:

```bash
HOST=0.0.0.0 PORT=8787 npm run dev:server
```

## Tag Release Workflow

Push a tag such as:

```bash
git tag v0.2.1-alpha.1
git push origin v0.2.1-alpha.1
```

GitHub Actions (`.github/workflows/release-desktop.yml`) builds and publishes:

- macOS `.dmg`
- Windows portable `.zip`
- `SHA256SUMS.txt`

## Phone-friendly Acceptance Checklist

- [ ] First launch shows onboarding CTA to select/create a vault folder.
- [ ] App lands on **Quick Capture** with focused input.
- [ ] `Cmd/Ctrl + Enter` saves instantly; input clears and refocuses.
- [ ] **Past Notes** shows the newly saved note.
- [ ] Theme (`System/Dark/Light`) persists after restart.
- [ ] Language (`en` / `zh-Hant`) persists after restart.
- [ ] Moving the vault folder into OneDrive/Dropbox/iCloud syncs externally.
- [ ] Running **Rebuild Index** fixes stale listing after external folder changes.
- [ ] Release artifacts (DMG + Windows ZIP + checksums) are downloadable from GitHub Release.
