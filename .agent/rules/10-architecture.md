# Architecture Rules

## Processes
- Main process owns: filesystem, AI calls, secrets, indexing, sync monitoring.
- Renderer owns: UI only.
- Preload exposes a minimal, typed IPC bridge.

## Storage
- Vault is file-based (OneDrive-friendly):
  - vault/notes/<noteId>.md
  - vault/structures/*.md
  - vault/links/*.json
  - vault/changesets/*.json
- Local (non-synced) cache/index is rebuildable.

## Traceability
- Any synthesized paragraph must reference source noteIds.
- UI shows citations on-demand (collapsed by default).

## AI writes NOTHING directly
- AI outputs ChangeSet JSON only.
- User review/apply step is mandatory.
