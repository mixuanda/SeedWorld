# /ai-changeset — AI ingest: Inbox -> ChangeSet (no direct writes)

Goal: Select some Inbox notes and generate a ChangeSet JSON.

Steps:
1) Define ChangeSet schema.
2) Implement "Generate ChangeSet" action:
   - sends selected notes to AI
   - receives ChangeSet JSON
   - saves it to vault/changesets/<id>.json
3) Add a minimal ChangeSet viewer (read-only):
   - groups: adds / links / merges / conflicts
   - every item shows trace noteIds

Acceptance:
- Generating a ChangeSet never edits existing notes/structures automatically.
- Saved changeset can be reopened after restart.
