# World-Seed — Product Definition (MVP)

## One-line
A cross-device idea inbox for worldbuilding (or any “main project”), with AI-assisted classification, linking, conflict detection, and traceable synthesis.

## Must-have (MVP)
- Inbox: ultra-fast capture of atomic cards (notes).
- Vault: user-chosen folder (preferably inside OneDrive) that stores notes as files.
- AI integration (desktop only is fine):
  - classify notes into dimensions (culture/politics/economy/characters/history/rules/law…)
  - propose links between concepts
  - detect contradictions and group conflicts
  - output a ChangeSet JSON (NEVER writes directly)
- Review UI (git-like):
  - user can inspect, edit, accept/reject each change
  - all synthesized content must link back to original notes (traceability)

## Non-goals (for MVP)
- Full native mobile app (iOS). Phase 2: PWA.
- Real-time collaboration.
- Perfect ontology. Start simple; evolve.

## Key terms
- Atomic Note: a single idea card with a stable noteId.
- Structure Doc: synthesized doc (e.g., “Economy System”, “Civil Code”).
- Link: (sourceId, targetId, relationType, confidence, evidenceNoteIds).
- ChangeSet: AI output describing proposed adds/edits/links/merges/conflicts with traceability.
