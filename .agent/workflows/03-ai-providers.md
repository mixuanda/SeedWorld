# /ai-providers — Add provider abstraction (online + local)

Goal: Create an AIProvider layer WITHOUT touching UI complexity.

Steps:
1) Implement provider interface in main process.
2) Add config UI:
   - Mode: Online / Local
   - Online: provider type + apiKey + model
   - Local: baseUrl + model
3) For Local mode, support OpenAI-compatible baseUrl (e.g. http://localhost:1234/v1).
4) Implement a "Test Connection" button.

Acceptance:
- Can send a trivial chat request and show response in a UI logs panel.
- No keys ever reach renderer (only IPC calls).
