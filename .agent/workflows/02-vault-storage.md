# /vault — Implement OneDrive-friendly vault storage

Goal: Persist atomic notes as files in a user-selected vault folder.

Steps:
1) Add "Choose Vault Folder" in settings (persist path locally).
2) Implement note write/read:
   - create noteId (uuid)
   - save to vault/notes/<noteId>.md with YAML frontmatter
3) Add basic list view:
   - left: notes list (title/time)
   - right: note viewer
4) Add minimal rebuildable local index (can be JSON first).
5) Add error handling:
   - vault missing
   - permission denied

Acceptance:
- Restart app -> notes still exist
- Vault folder can be placed inside OneDrive and works offline
