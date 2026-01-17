# /review-apply — Git-like review UI + apply engine

Goal: Review and apply ChangeSet with granular control.

Steps:
1) Build Review UI:
   - left: change list with checkboxes
   - middle: diff preview for structure edits
   - right: trace panel (original notes)
2) Implement apply engine:
   - apply adds
   - apply links
   - apply structure doc edits (patch-based)
   - record applied status + timestamp
3) Implement rollback for a single applied ChangeSet (best-effort for MVP).

Acceptance:
- User can accept/reject individual changes.
- Everything remains traceable.
