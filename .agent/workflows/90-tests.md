# /tests — Add test harness (unit + e2e)

Goal: Add reliable tests for a growing Electron app.

Steps:
1) Unit tests for core pure functions (ChangeSet schema validation, patch apply).
2) E2E: Use Playwright to launch Electron and assert the main window loads.

Acceptance:
- `npm test` runs unit tests
- `npm run e2e` launches Electron via Playwright and passes
