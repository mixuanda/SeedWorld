# Electron Security Rules (non-negotiable)

- BrowserWindow:
  - nodeIntegration: false
  - contextIsolation: true
  - sandbox: true (when feasible)
- All privileged APIs go through preload via contextBridge.
- Never expose API keys to renderer.
- Treat all note content as untrusted input (prompt-injection aware).
- Any external link must use shell.openExternal and show the domain clearly.
