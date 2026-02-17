import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { InboxItem, SyncStatus } from './preload';
import { VaultSetup } from './components/VaultSetup';

type AppState = 'loading' | 'setup' | 'ready';

interface SignInForm {
  serverUrl: string;
  userId: string;
  workspaceId: string;
}

const DEFAULT_SIGN_IN: SignInForm = {
  serverUrl: 'http://127.0.0.1:8787',
  userId: 'dev-user',
  workspaceId: 'workspace-1',
};

function formatTimestamp(value?: number): string {
  if (!value) {
    return 'Never';
  }
  return new Date(value).toLocaleString();
}

function statusLabel(status: InboxItem['syncStatus']): string {
  switch (status) {
    case 'saved_local':
      return 'Saved locally';
    case 'waiting_sync':
      return 'Waiting to sync';
    case 'syncing':
      return 'Syncing';
    case 'synced':
      return 'Synced';
    case 'synced_text_only':
      return 'Text synced';
    case 'media_downloading':
      return 'Media downloading';
    case 'sync_failed':
      return 'Sync failed';
    case 'blocked_quota_or_storage':
      return 'Blocked: quota/storage';
    case 'blocked_hash_mismatch':
      return 'Blocked: hash mismatch';
    case 'blocked_auth':
      return 'Blocked: auth';
    default:
      return status;
  }
}

export function App(): React.ReactElement {
  const [appState, setAppState] = useState<AppState>('loading');
  const [vaultPath, setVaultPath] = useState<string | null>(null);
  const [pingResult, setPingResult] = useState<string | null>(null);

  const [signIn, setSignIn] = useState<SignInForm>(DEFAULT_SIGN_IN);
  const [isSigningIn, setIsSigningIn] = useState(false);
  const [authLoaded, setAuthLoaded] = useState(false);
  const [signedIn, setSignedIn] = useState(false);

  const [inbox, setInbox] = useState<InboxItem[]>([]);
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null);

  const [captureTitle, setCaptureTitle] = useState('');
  const [captureBody, setCaptureBody] = useState('');

  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [importMode, setImportMode] = useState<'restore' | 'clone'>('restore');

  const loadInboxAndStatus = useCallback(async () => {
    const [items, status] = await Promise.all([
      window.api.inbox.list(),
      window.api.sync.getStatus(),
    ]);
    setInbox(items);
    setSyncStatus(status);
  }, []);

  useEffect(() => {
    const init = async () => {
      try {
        const pong = await window.api.ping();
        setPingResult(pong);
      } catch (initError) {
        console.error('[App] Ping failed', initError);
      }

      try {
        const existingVaultPath = await window.api.vault.getPath();
        if (!existingVaultPath) {
          setAppState('setup');
          return;
        }

        setVaultPath(existingVaultPath);
        setAppState('ready');

        const auth = await window.api.auth.getConfig();
        if (auth) {
          setSignIn({
            serverUrl: auth.serverUrl,
            userId: auth.userId,
            workspaceId: auth.workspaceId,
          });
          setSignedIn(true);
          await loadInboxAndStatus();
        }
      } catch (initError) {
        console.error('[App] Failed to initialize app', initError);
        setError(initError instanceof Error ? initError.message : 'Initialization failed');
      } finally {
        setAuthLoaded(true);
      }
    };

    init();
  }, [loadInboxAndStatus]);

  const handleVaultSelected = useCallback(async (selectedPath: string) => {
    setVaultPath(selectedPath);
    setAppState('ready');
    setMessage('Vault configured. Sign in to start sync.');
  }, []);

  const handleSignIn = useCallback(async () => {
    setError(null);
    setMessage(null);
    setIsSigningIn(true);

    try {
      await window.api.auth.devSignIn({
        serverUrl: signIn.serverUrl,
        userId: signIn.userId,
        workspaceId: signIn.workspaceId,
      });
      setSignedIn(true);
      setMessage('Signed in.');
      await loadInboxAndStatus();
    } catch (signInError) {
      console.error('[App] Sign in failed', signInError);
      setError(signInError instanceof Error ? signInError.message : 'Sign in failed');
    } finally {
      setIsSigningIn(false);
    }
  }, [loadInboxAndStatus, signIn.serverUrl, signIn.userId, signIn.workspaceId]);

  const handleSignOut = useCallback(async () => {
    await window.api.auth.signOut();
    setSignedIn(false);
    setInbox([]);
    setSyncStatus(null);
    setMessage('Signed out.');
  }, []);

  const handleCapture = useCallback(async () => {
    if (!captureBody.trim()) {
      return;
    }

    setBusy('capture');
    setError(null);
    setMessage(null);

    try {
      const items = await window.api.capture.quickText({
        title: captureTitle.trim() || undefined,
        body: captureBody.trim(),
      });
      setInbox(items);
      setCaptureBody('');
      setCaptureTitle('');
      setMessage('Saved locally.');
      setSyncStatus(await window.api.sync.getStatus());
    } catch (captureError) {
      console.error('[App] Capture failed', captureError);
      setError(captureError instanceof Error ? captureError.message : 'Capture failed');
    } finally {
      setBusy(null);
    }
  }, [captureBody, captureTitle]);

  const handleSyncNow = useCallback(async () => {
    setBusy('sync');
    setError(null);
    setMessage(null);

    try {
      const status = await window.api.sync.now();
      setSyncStatus(status);
      setInbox(await window.api.inbox.list());
      setMessage('Sync completed.');
    } catch (syncError) {
      console.error('[App] Sync failed', syncError);
      setError(syncError instanceof Error ? syncError.message : 'Sync failed');
    } finally {
      setBusy(null);
    }
  }, []);

  const handleExport = useCallback(async () => {
    setBusy('export');
    setError(null);
    setMessage(null);
    try {
      const filePath = await window.api.exportData.create();
      if (filePath) {
        setMessage(`Export saved: ${filePath}`);
      }
    } catch (exportError) {
      setError(exportError instanceof Error ? exportError.message : 'Export failed');
    } finally {
      setBusy(null);
    }
  }, []);

  const handleDiagnosticsCopy = useCallback(async () => {
    setBusy('diagnostics');
    setError(null);
    setMessage(null);

    try {
      const summary = await window.api.diagnostics.getSummary();
      await navigator.clipboard.writeText(summary);
      setMessage('Diagnostics summary copied.');
    } catch (diagError) {
      setError(diagError instanceof Error ? diagError.message : 'Failed to copy diagnostics');
    } finally {
      setBusy(null);
    }
  }, []);

  const handleDiagnosticsExport = useCallback(async () => {
    setBusy('diagnostics-export');
    setError(null);
    setMessage(null);

    try {
      const filePath = await window.api.diagnostics.export();
      if (filePath) {
        setMessage(`Diagnostics exported: ${filePath}`);
      }
    } catch (diagError) {
      setError(diagError instanceof Error ? diagError.message : 'Failed to export diagnostics');
    } finally {
      setBusy(null);
    }
  }, []);

  const handleImport = useCallback(async () => {
    setBusy('import');
    setError(null);
    setMessage(null);

    try {
      const result = await window.api.importData.fromZip({ mode: importMode });
      if (result) {
        setMessage(`Import complete (${result.importedEvents} events). Workspace: ${result.workspaceId}`);
        await loadInboxAndStatus();
      }
    } catch (importError) {
      setError(importError instanceof Error ? importError.message : 'Import failed');
    } finally {
      setBusy(null);
    }
  }, [importMode, loadInboxAndStatus]);

  const syncSummary = useMemo(() => {
    if (!syncStatus) {
      return 'No sync status yet.';
    }

    return [
      `Last success: ${formatTimestamp(syncStatus.lastSuccessAtMs)}`,
      `Pending events: ${syncStatus.pendingEvents}`,
      `Pending blobs: ${syncStatus.pendingBlobs}`,
      `Cursor: pull=${syncStatus.lastPulledSeq} applied=${syncStatus.lastAppliedSeq}`,
      syncStatus.lastError
        ? `Last error: ${syncStatus.lastError.message} (${syncStatus.lastError.code})`
        : 'Last error: none',
    ].join(' · ');
  }, [syncStatus]);

  if (appState === 'loading' || !authLoaded) {
    return (
      <div className="app-loading">
        <div className="loading-spinner" />
        <p>Loading SeedWorld...</p>
      </div>
    );
  }

  if (appState === 'setup') {
    return <VaultSetup onVaultSelected={handleVaultSelected} />;
  }

  return (
    <div className="app">
      <header className="header">
        <h1>SeedWorld Inbox</h1>
        <div className="header-right">
          {pingResult && <span className="ping-status">IPC OK</span>}
          {vaultPath && <span className="vault-status" title={vaultPath}>Vault Ready</span>}
        </div>
      </header>

      <section className="capture-section" style={{ display: 'grid', gap: 8 }}>
        <h2 style={{ margin: 0 }}>Dev Sign-in</h2>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 8 }}>
          <input
            className="note-input"
            value={signIn.serverUrl}
            onChange={(event) => setSignIn((prev) => ({ ...prev, serverUrl: event.target.value }))}
            placeholder="Server URL"
          />
          <input
            className="note-input"
            value={signIn.userId}
            onChange={(event) => setSignIn((prev) => ({ ...prev, userId: event.target.value }))}
            placeholder="User ID"
          />
          <input
            className="note-input"
            value={signIn.workspaceId}
            onChange={(event) => setSignIn((prev) => ({ ...prev, workspaceId: event.target.value }))}
            placeholder="Workspace ID"
          />
        </div>
        <div className="capture-actions">
          <button className="save-button" disabled={isSigningIn} onClick={handleSignIn}>
            {isSigningIn ? 'Signing in...' : 'Sign in'}
          </button>
          <button className="save-button" disabled={!signedIn} onClick={handleSignOut}>
            Sign out
          </button>
        </div>
      </section>

      <section className="capture-section" style={{ display: 'grid', gap: 8 }}>
        <h2 style={{ margin: 0 }}>Quick Capture</h2>
        <input
          className="note-input"
          value={captureTitle}
          onChange={(event) => setCaptureTitle(event.target.value)}
          placeholder="Title (optional)"
          disabled={!signedIn || busy === 'capture'}
        />
        <textarea
          className="note-input"
          placeholder="Capture text..."
          value={captureBody}
          onChange={(event) => setCaptureBody(event.target.value)}
          disabled={!signedIn || busy === 'capture'}
        />
        <div className="capture-actions">
          <button
            className="save-button"
            onClick={handleCapture}
            disabled={!signedIn || !captureBody.trim() || busy === 'capture'}
          >
            {busy === 'capture' ? 'Saving...' : 'Save Locally'}
          </button>
          <button className="save-button" onClick={handleSyncNow} disabled={!signedIn || busy === 'sync'}>
            {busy === 'sync' ? 'Syncing...' : 'Sync now'}
          </button>
        </div>
      </section>

      <section className="capture-section" style={{ display: 'grid', gap: 8 }}>
        <h2 style={{ margin: 0 }}>Sync Status</h2>
        <p style={{ margin: 0 }}>{syncSummary}</p>
        <div className="capture-actions">
          <button className="save-button" onClick={handleExport} disabled={!signedIn || busy === 'export'}>
            Export ZIP
          </button>
          <button className="save-button" onClick={handleDiagnosticsCopy} disabled={!signedIn || busy === 'diagnostics'}>
            Copy diagnostics summary
          </button>
          <button className="save-button" onClick={handleDiagnosticsExport} disabled={!signedIn || busy === 'diagnostics-export'}>
            Export diagnostics ZIP
          </button>
        </div>
        <div className="capture-actions">
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            Import mode
            <select
              value={importMode}
              onChange={(event) => setImportMode(event.target.value as 'restore' | 'clone')}
              disabled={!signedIn || busy === 'import'}
            >
              <option value="restore">Restore (keep workspaceId)</option>
              <option value="clone">Clone (new workspaceId)</option>
            </select>
          </label>
          <button className="save-button" onClick={handleImport} disabled={!signedIn || busy === 'import'}>
            {busy === 'import' ? 'Importing...' : 'Import/Restore ZIP'}
          </button>
        </div>
      </section>

      {(error || message) && (
        <section className="capture-section" style={{ marginTop: 8 }}>
          {message && <p style={{ margin: 0, color: '#0a7f35' }}>{message}</p>}
          {error && <p style={{ margin: 0, color: '#b00020' }}>{error}</p>}
        </section>
      )}

      <main className="main-split">
        <aside className="panel-left" style={{ width: '100%' }}>
          <h2>Inbox ({inbox.length})</h2>
          {inbox.length === 0 ? (
            <div className="notes-list-empty">
              <p>No items yet</p>
            </div>
          ) : (
            <ul className="notes-list">
              {inbox.map((item) => (
                <li key={item.id} className="notes-list-item">
                  <div className="notes-list-item-title">{item.title}</div>
                  <div className="notes-list-item-meta">
                    <span className="notes-list-item-id">{item.id}</span>
                    <span className="notes-list-item-date">{statusLabel(item.syncStatus)}</span>
                  </div>
                  <div className="notes-list-item-preview">{item.preview}</div>
                  {item.needsResolution && (
                    <div className="notes-list-item-meta">
                      <span className="notes-list-item-id">Needs resolution</span>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </aside>
      </main>
    </div>
  );
}

export default App;
