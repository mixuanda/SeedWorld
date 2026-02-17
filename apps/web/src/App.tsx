import React, { useCallback, useMemo, useRef, useState } from 'react';
import JSZip from 'jszip';
import {
  buildExportSnapshot,
  createHttpSyncTransport,
  generateEventId,
  migrateEvent,
  SyncEngine,
  type DeviceState,
  type InboxItem,
  type SyncStatus,
} from '@seedworld/core';
import { IndexedDbStorageAdapter } from './indexeddb-adapter';

interface AuthState {
  serverUrl: string;
  userId: string;
  workspaceId: string;
  token: string;
  tokenExpiresAtMs: number;
  deviceId: string;
}

const AUTH_STORAGE_KEY = 'seedworld.web.auth';

function getStoredAuth(): AuthState | null {
  try {
    const raw = localStorage.getItem(AUTH_STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as AuthState;
  } catch {
    return null;
  }
}

function saveAuth(auth: AuthState | null): void {
  if (!auth) {
    localStorage.removeItem(AUTH_STORAGE_KEY);
    return;
  }
  localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(auth));
}

function formatTimestamp(value?: number): string {
  if (!value) return 'Never';
  return new Date(value).toLocaleString();
}

function statusLabel(status: InboxItem['syncStatus']): string {
  return status.replace(/_/g, ' ');
}

function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export default function App(): React.ReactElement {
  const initialAuth = getStoredAuth();
  const [serverUrl, setServerUrl] = useState(initialAuth?.serverUrl || 'http://127.0.0.1:8787');
  const [userId, setUserId] = useState(initialAuth?.userId || 'dev-user');
  const [workspaceId, setWorkspaceId] = useState(initialAuth?.workspaceId || 'workspace-1');

  const [auth, setAuth] = useState<AuthState | null>(initialAuth);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const [captureTitle, setCaptureTitle] = useState('');
  const [captureBody, setCaptureBody] = useState('');

  const [inbox, setInbox] = useState<InboxItem[]>([]);
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null);

  const adapterRef = useRef<IndexedDbStorageAdapter | null>(null);
  const engineRef = useRef<SyncEngine | null>(null);

  const ensureEngine = useCallback(async (authState: AuthState): Promise<SyncEngine> => {
    if (engineRef.current) {
      return engineRef.current;
    }

    const deviceState: DeviceState = {
      workspaceId: authState.workspaceId,
      userId: authState.userId,
      deviceId: authState.deviceId,
      nextLocalSeq: 1,
      lastPulledSeq: 0,
      lastAppliedSeq: 0,
      projectionDirty: false,
    };

    const adapter = await IndexedDbStorageAdapter.create(deviceState);
    const transport = createHttpSyncTransport({
      baseUrl: authState.serverUrl,
      token: authState.token,
    });

    const engine = new SyncEngine({
      storage: adapter,
      transport,
    });

    adapterRef.current = adapter;
    engineRef.current = engine;
    return engine;
  }, []);

  const refresh = useCallback(async () => {
    if (!auth) return;
    const engine = await ensureEngine(auth);
    const [items, status] = await Promise.all([engine.getInbox(), engine.getSyncStatus()]);
    setInbox(items);
    setSyncStatus(status);
  }, [auth, ensureEngine]);

  React.useEffect(() => {
    if (!auth) return;
    refresh().catch((effectError) => {
      setError(effectError instanceof Error ? effectError.message : 'Failed to load inbox');
    });
  }, [auth, refresh]);

  const handleSignIn = useCallback(async () => {
    setBusy('signin');
    setError(null);
    setMessage(null);

    try {
      const response = await fetch(`${serverUrl.replace(/\/+$/, '')}/auth/dev`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({ userId, workspaceId }),
      });

      if (!response.ok) {
        throw new Error(`Sign-in failed (${response.status})`);
      }

      const payload = await response.json() as { token: string; expiresAtMs: number };
      const authState: AuthState = {
        serverUrl: serverUrl.replace(/\/+$/, ''),
        userId,
        workspaceId,
        token: payload.token,
        tokenExpiresAtMs: payload.expiresAtMs,
        deviceId: initialAuth?.deviceId || `web_${generateEventId().slice(0, 12)}`,
      };

      saveAuth(authState);
      setAuth(authState);
      setMessage('Signed in.');
      engineRef.current = null;
      adapterRef.current = null;
      await refresh();
    } catch (signInError) {
      setError(signInError instanceof Error ? signInError.message : 'Sign-in failed');
    } finally {
      setBusy(null);
    }
  }, [initialAuth?.deviceId, refresh, serverUrl, userId, workspaceId]);

  const handleCapture = useCallback(async () => {
    if (!auth || !captureBody.trim()) return;

    setBusy('capture');
    setError(null);
    setMessage(null);

    try {
      const engine = await ensureEngine(auth);
      await engine.captureText({
        atomId: `atom_${generateEventId().replace(/-/g, '').slice(0, 20)}`,
        title: captureTitle.trim() || undefined,
        body: captureBody.trim(),
      });
      setCaptureTitle('');
      setCaptureBody('');
      setMessage('Saved locally.');
      await refresh();
    } catch (captureError) {
      setError(captureError instanceof Error ? captureError.message : 'Capture failed');
    } finally {
      setBusy(null);
    }
  }, [auth, captureBody, captureTitle, ensureEngine, refresh]);

  const handleSyncNow = useCallback(async () => {
    if (!auth) return;

    setBusy('sync');
    setError(null);
    setMessage(null);

    try {
      const engine = await ensureEngine(auth);
      const status = await engine.syncNow();
      setSyncStatus(status);
      await refresh();
      setMessage('Sync finished.');
    } catch (syncError) {
      setError(syncError instanceof Error ? syncError.message : 'Sync failed');
    } finally {
      setBusy(null);
    }
  }, [auth, ensureEngine, refresh]);

  const handleExport = useCallback(async () => {
    if (!auth || !adapterRef.current) return;

    setBusy('export');
    setError(null);
    setMessage(null);

    try {
      const snapshot = await buildExportSnapshot(adapterRef.current);
      const zip = new JSZip();
      zip.file('manifest.json', JSON.stringify(snapshot.manifest, null, 2));
      zip.file('events/events.jsonl', snapshot.events.map((event) => JSON.stringify(event)).join('\n'));
      zip.file('portable/state.json', JSON.stringify({
        atoms: snapshot.atoms,
        atomVersions: snapshot.atomVersions,
        conflicts: snapshot.conflicts,
      }, null, 2));

      for (const atom of snapshot.atoms) {
        zip.file(`atoms/${atom.atomId}.md`, atom.body);
      }

      const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
      downloadBlob(`seedworld-export-${Date.now()}.zip`, blob);
      setMessage('Export downloaded.');
    } catch (exportError) {
      setError(exportError instanceof Error ? exportError.message : 'Export failed');
    } finally {
      setBusy(null);
    }
  }, [auth]);

  const handleImport = useCallback(async (file: File | null) => {
    if (!auth || !file) return;
    setBusy('import');
    setError(null);
    setMessage(null);

    try {
      const zip = await JSZip.loadAsync(await file.arrayBuffer());
      const eventsText = await zip.file('events/events.jsonl')?.async('string');
      if (!eventsText) {
        throw new Error('Import file missing events/events.jsonl');
      }

      const events = eventsText
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => migrateEvent(JSON.parse(line)));

      const engine = await ensureEngine(auth);
      await adapterRef.current!.upsertEvents(events.map((event) => ({
        ...event,
        syncStatus: typeof event.serverSeq === 'number' ? 'synced' : 'saved_local',
      })));
      await engine.rebuildProjection();
      await refresh();
      setMessage(`Imported ${events.length} event(s).`);
    } catch (importError) {
      setError(importError instanceof Error ? importError.message : 'Import failed');
    } finally {
      setBusy(null);
    }
  }, [auth, ensureEngine, refresh]);

  const summary = useMemo(() => {
    if (!syncStatus) return 'No sync status yet.';
    return `Last success ${formatTimestamp(syncStatus.lastSuccessAtMs)} · Pending events ${syncStatus.pendingEvents} · Pending blobs ${syncStatus.pendingBlobs} · lastPulledSeq ${syncStatus.lastPulledSeq} · lastAppliedSeq ${syncStatus.lastAppliedSeq}`;
  }, [syncStatus]);

  return (
    <div style={{ margin: '0 auto', maxWidth: 980, padding: 20, fontFamily: 'ui-sans-serif, system-ui, sans-serif' }}>
      <h1>SeedWorld Web</h1>

      <section style={{ border: '1px solid #ddd', borderRadius: 8, padding: 12, marginBottom: 12 }}>
        <h2 style={{ marginTop: 0 }}>Sign in (Dev Auth)</h2>
        <div style={{ display: 'grid', gap: 8, gridTemplateColumns: 'repeat(3, minmax(0, 1fr))' }}>
          <input value={serverUrl} onChange={(event) => setServerUrl(event.target.value)} placeholder="Server URL" />
          <input value={userId} onChange={(event) => setUserId(event.target.value)} placeholder="User ID" />
          <input value={workspaceId} onChange={(event) => setWorkspaceId(event.target.value)} placeholder="Workspace ID" />
        </div>
        <div style={{ marginTop: 8, display: 'flex', gap: 8 }}>
          <button onClick={handleSignIn} disabled={busy === 'signin'}>{busy === 'signin' ? 'Signing in...' : 'Sign in'}</button>
          <button onClick={() => { setAuth(null); saveAuth(null); setInbox([]); setSyncStatus(null); engineRef.current = null; adapterRef.current = null; }}>Sign out</button>
        </div>
      </section>

      <section style={{ border: '1px solid #ddd', borderRadius: 8, padding: 12, marginBottom: 12 }}>
        <h2 style={{ marginTop: 0 }}>Quick Capture</h2>
        <input
          style={{ width: '100%', marginBottom: 8 }}
          value={captureTitle}
          onChange={(event) => setCaptureTitle(event.target.value)}
          placeholder="Title (optional)"
          disabled={!auth}
        />
        <textarea
          style={{ width: '100%', minHeight: 90 }}
          value={captureBody}
          onChange={(event) => setCaptureBody(event.target.value)}
          placeholder="Capture text"
          disabled={!auth}
        />
        <div style={{ marginTop: 8, display: 'flex', gap: 8 }}>
          <button onClick={handleCapture} disabled={!auth || busy === 'capture' || !captureBody.trim()}>
            {busy === 'capture' ? 'Saving...' : 'Save Locally'}
          </button>
          <button onClick={handleSyncNow} disabled={!auth || busy === 'sync'}>
            {busy === 'sync' ? 'Syncing...' : 'Sync now'}
          </button>
          <button onClick={handleExport} disabled={!auth || busy === 'export'}>Download export.zip</button>
          <label>
            Import
            <input
              type="file"
              accept=".zip"
              disabled={!auth || busy === 'import'}
              onChange={(event) => {
                const [file] = Array.from(event.target.files || []);
                handleImport(file).catch((importError) => {
                  setError(importError instanceof Error ? importError.message : 'Import failed');
                });
                event.target.value = '';
              }}
            />
          </label>
        </div>
      </section>

      <section style={{ border: '1px solid #ddd', borderRadius: 8, padding: 12, marginBottom: 12 }}>
        <h2 style={{ marginTop: 0 }}>Sync Status</h2>
        <p>{summary}</p>
        {syncStatus?.lastError ? (
          <details>
            <summary>{syncStatus.lastError.message}</summary>
            <pre>{JSON.stringify(syncStatus.lastError, null, 2)}</pre>
          </details>
        ) : null}
      </section>

      {message && <p style={{ color: '#0a7f35' }}>{message}</p>}
      {error && <p style={{ color: '#b00020' }}>{error}</p>}

      <section style={{ border: '1px solid #ddd', borderRadius: 8, padding: 12 }}>
        <h2 style={{ marginTop: 0 }}>Inbox ({inbox.length})</h2>
        {inbox.length === 0 ? <p>No items yet.</p> : (
          <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'grid', gap: 8 }}>
            {inbox.map((item) => (
              <li key={item.id} style={{ border: '1px solid #eee', borderRadius: 8, padding: 8 }}>
                <strong>{item.title}</strong>
                <div style={{ fontSize: 12, color: '#666' }}>{item.id} · {statusLabel(item.syncStatus)}</div>
                <p style={{ marginBottom: 0 }}>{item.preview}</p>
                {item.needsResolution ? <span style={{ color: '#b26a00', fontSize: 12 }}>Needs resolution</span> : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
