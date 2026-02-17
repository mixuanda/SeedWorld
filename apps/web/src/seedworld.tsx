import React, { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import JSZip from 'jszip';
import {
  buildExportSnapshot,
  createDisabledSyncTransport,
  createHttpSyncTransport,
  generateEventId,
  migrateEvent,
  SyncEngine,
  validateImportBundle,
  type DeviceState,
  type InboxItem,
  type StoredEvent,
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

interface LocalIdentity {
  workspaceId: string;
  deviceId: string;
  userId: string;
}

interface DiagnosticsSummary {
  workspaceId: string;
  deviceId: string;
  userId: string;
  signedIn: boolean;
  lastSuccessAtMs?: number;
  lastPulledSeq: number;
  lastAppliedSeq: number;
  pendingEvents: number;
  pendingBlobs: number;
  lastError?: SyncStatus['lastError'];
  attempts: Array<{
    timestampMs: number;
    action: string;
    result: string;
    errorCode?: string;
    message?: string;
  }>;
}

interface SeedWorldContextValue {
  auth: AuthState | null;
  isSignedIn: boolean;
  workspaceId: string;
  deviceId: string;
  localUserId: string;
  lastServerUrl: string;
  inbox: InboxItem[];
  syncStatus: SyncStatus | null;
  busy: string | null;
  error: string | null;
  message: string | null;
  setMessage: (message: string | null) => void;
  setError: (message: string | null) => void;
  captureText: (input: { title?: string; body: string }) => Promise<void>;
  syncNow: () => Promise<void>;
  signIn: (input: { serverUrl: string; userId: string; workspaceId: string }) => Promise<void>;
  signOut: () => Promise<void>;
  exportData: () => Promise<void>;
  importData: (file: File) => Promise<void>;
  copyDiagnosticsSummary: () => Promise<void>;
  exportDiagnosticsZip: () => Promise<void>;
  refresh: () => Promise<void>;
}

const AUTH_STORAGE_KEY = 'seedworld.web.auth';
const WORKSPACE_STORAGE_KEY = 'seedworld.workspaceId';
const DEVICE_STORAGE_KEY = 'seedworld.deviceId';
const LOCAL_USER_STORAGE_KEY = 'seedworld.localUserId';
const SERVER_URL_STORAGE_KEY = 'seedworld.serverUrl';

const SeedWorldContext = createContext<SeedWorldContextValue | null>(null);

function getStringFromStorage(key: string): string | null {
  try {
    const value = localStorage.getItem(key);
    return value && value.trim().length > 0 ? value : null;
  } catch {
    return null;
  }
}

function setStringToStorage(key: string, value: string): void {
  localStorage.setItem(key, value);
}

function createDefaultIdentity(): LocalIdentity {
  const storedWorkspaceId = getStringFromStorage(WORKSPACE_STORAGE_KEY);
  const storedDeviceId = getStringFromStorage(DEVICE_STORAGE_KEY);
  const storedUserId = getStringFromStorage(LOCAL_USER_STORAGE_KEY);

  const workspaceId = storedWorkspaceId || `workspace_${generateEventId().replace(/-/g, '').slice(0, 12)}`;
  const deviceId = storedDeviceId || `web_${generateEventId().replace(/-/g, '').slice(0, 12)}`;
  const userId = storedUserId || 'local-user';

  setStringToStorage(WORKSPACE_STORAGE_KEY, workspaceId);
  setStringToStorage(DEVICE_STORAGE_KEY, deviceId);
  setStringToStorage(LOCAL_USER_STORAGE_KEY, userId);

  return {
    workspaceId,
    deviceId,
    userId,
  };
}

function readAuthState(): AuthState | null {
  try {
    const raw = localStorage.getItem(AUTH_STORAGE_KEY);
    if (!raw) {
      return null;
    }
    return JSON.parse(raw) as AuthState;
  } catch {
    return null;
  }
}

function writeAuthState(auth: AuthState | null): void {
  if (!auth) {
    localStorage.removeItem(AUTH_STORAGE_KEY);
    return;
  }

  localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(auth));
}

function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function diagnosticsSummaryText(summary: DiagnosticsSummary): string {
  const lines = [
    `Workspace: ${summary.workspaceId}`,
    `Device: ${summary.deviceId}`,
    `User: ${summary.userId}`,
    `Signed in: ${summary.signedIn ? 'yes' : 'no'}`,
    `Last success: ${summary.lastSuccessAtMs ? new Date(summary.lastSuccessAtMs).toISOString() : 'never'}`,
    `Last pulled seq: ${summary.lastPulledSeq}`,
    `Last applied seq: ${summary.lastAppliedSeq}`,
    `Pending events: ${summary.pendingEvents}`,
    `Pending blobs: ${summary.pendingBlobs}`,
    `Last error: ${summary.lastError ? `${summary.lastError.code} - ${summary.lastError.message}` : 'none'}`,
    '',
    'Recent attempts:',
    ...summary.attempts.map((attempt) =>
      `- ${new Date(attempt.timestampMs).toISOString()} ${attempt.action} ${attempt.result}` +
      (attempt.errorCode ? ` (${attempt.errorCode})` : '') +
      (attempt.message ? ` ${attempt.message}` : ''),
    ),
  ];

  return lines.join('\n');
}

export function SeedWorldProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const [identity, setIdentity] = useState<LocalIdentity>(() => createDefaultIdentity());
  const [auth, setAuth] = useState<AuthState | null>(() => readAuthState());
  const [inbox, setInbox] = useState<InboxItem[]>([]);
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastServerUrl, setLastServerUrl] = useState(() => getStringFromStorage(SERVER_URL_STORAGE_KEY) || '');

  const adapterRef = useRef<IndexedDbStorageAdapter | null>(null);
  const engineRef = useRef<SyncEngine | null>(null);
  const engineKeyRef = useRef<string>('');

  const ensureEngine = useCallback(async (overrides?: { identity?: LocalIdentity; auth?: AuthState | null }): Promise<SyncEngine> => {
    const effectiveIdentity = overrides?.identity || identity;
    const effectiveAuth = overrides?.auth !== undefined ? overrides.auth : auth;
    const effectiveUserId = effectiveAuth?.userId || effectiveIdentity.userId;
    const key = [
      effectiveIdentity.workspaceId,
      effectiveIdentity.deviceId,
      effectiveUserId,
      effectiveAuth?.serverUrl || '',
      effectiveAuth?.token || '',
    ].join('|');

    if (engineRef.current && engineKeyRef.current === key) {
      return engineRef.current;
    }

    const deviceState: DeviceState = {
      workspaceId: effectiveIdentity.workspaceId,
      userId: effectiveUserId,
      deviceId: effectiveIdentity.deviceId,
      nextLocalSeq: 1,
      lastPulledSeq: 0,
      lastAppliedSeq: 0,
      projectionDirty: false,
    };

    const adapter = await IndexedDbStorageAdapter.create(deviceState);
    const transport = effectiveAuth
      ? createHttpSyncTransport({
          baseUrl: effectiveAuth.serverUrl,
          token: effectiveAuth.token,
        })
      : createDisabledSyncTransport('AUTH: Sign in required for sync');

    const engine = new SyncEngine({
      storage: adapter,
      transport,
    });

    adapterRef.current = adapter;
    engineRef.current = engine;
    engineKeyRef.current = key;

    return engine;
  }, [auth, identity]);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const engine = await ensureEngine();
      const [items, status] = await Promise.all([engine.getInbox(), engine.getSyncStatus()]);
      setInbox(items);
      setSyncStatus(status);
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : 'Failed to refresh local state');
    }
  }, [ensureEngine]);

  React.useEffect(() => {
    refresh().catch((effectError) => {
      setError(effectError instanceof Error ? effectError.message : 'Failed to load app state');
    });
  }, [refresh]);

  const captureText = useCallback(async (input: { title?: string; body: string }) => {
    if (!input.body.trim()) {
      return;
    }

    setBusy('capture');
    setError(null);
    setMessage(null);

    try {
      const engine = await ensureEngine();
      await engine.captureText({
        atomId: `atom_${generateEventId().replace(/-/g, '').slice(0, 20)}`,
        title: input.title,
        body: input.body,
      });
      await refresh();
      setMessage('Saved locally.');
    } catch (captureError) {
      setError(captureError instanceof Error ? captureError.message : 'Capture failed');
      throw captureError;
    } finally {
      setBusy(null);
    }
  }, [ensureEngine, refresh]);

  const syncNow = useCallback(async () => {
    setBusy('sync');
    setError(null);
    setMessage(null);

    try {
      const engine = await ensureEngine();
      const status = await engine.syncNow();
      setSyncStatus(status);
      await refresh();
      setMessage('Sync complete.');
    } catch (syncError) {
      setError(syncError instanceof Error ? syncError.message : 'Sync failed');
      throw syncError;
    } finally {
      setBusy(null);
    }
  }, [ensureEngine, refresh]);

  const signIn = useCallback(async (input: { serverUrl: string; userId: string; workspaceId: string }) => {
    setBusy('signin');
    setError(null);
    setMessage(null);

    try {
      const serverUrl = input.serverUrl.trim().replace(/\/+$/, '');
      const userId = input.userId.trim() || 'dev-user';
      const workspaceId = input.workspaceId.trim();

      if (!serverUrl || !workspaceId) {
        throw new Error('Server URL and workspace ID are required');
      }

      const response = await fetch(`${serverUrl}/auth/dev`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({ userId, workspaceId }),
      });

      if (!response.ok) {
        const bodyText = await response.text();
        throw new Error(bodyText || `Sign-in failed (${response.status})`);
      }

      const payload = await response.json() as { token: string; expiresAtMs: number };

      const nextIdentity: LocalIdentity = {
        workspaceId,
        deviceId: identity.deviceId,
        userId,
      };
      const nextAuth: AuthState = {
        serverUrl,
        userId,
        workspaceId,
        deviceId: identity.deviceId,
        token: payload.token,
        tokenExpiresAtMs: payload.expiresAtMs,
      };

      setStringToStorage(WORKSPACE_STORAGE_KEY, workspaceId);
      setStringToStorage(LOCAL_USER_STORAGE_KEY, userId);
      setStringToStorage(SERVER_URL_STORAGE_KEY, serverUrl);
      writeAuthState(nextAuth);

      setIdentity(nextIdentity);
      setAuth(nextAuth);
      setLastServerUrl(serverUrl);

      engineRef.current = null;
      adapterRef.current = null;
      engineKeyRef.current = '';

      const engine = await ensureEngine({ identity: nextIdentity, auth: nextAuth });
      const [items, status] = await Promise.all([engine.getInbox(), engine.getSyncStatus()]);
      setInbox(items);
      setSyncStatus(status);
      setMessage('Signed in. Sync enabled.');
    } catch (signInError) {
      setError(signInError instanceof Error ? signInError.message : 'Sign-in failed');
      throw signInError;
    } finally {
      setBusy(null);
    }
  }, [ensureEngine, identity.deviceId]);

  const signOut = useCallback(async () => {
    setBusy('signout');
    setError(null);
    setMessage(null);

    try {
      const nextIdentity: LocalIdentity = {
        workspaceId: identity.workspaceId,
        deviceId: identity.deviceId,
        userId: 'local-user',
      };

      setStringToStorage(LOCAL_USER_STORAGE_KEY, nextIdentity.userId);
      writeAuthState(null);

      setIdentity(nextIdentity);
      setAuth(null);

      engineRef.current = null;
      adapterRef.current = null;
      engineKeyRef.current = '';

      const engine = await ensureEngine({ identity: nextIdentity, auth: null });
      const [items, status] = await Promise.all([engine.getInbox(), engine.getSyncStatus()]);
      setInbox(items);
      setSyncStatus(status);
      setMessage('Signed out. Local capture remains available.');
    } finally {
      setBusy(null);
    }
  }, [ensureEngine, identity.deviceId, identity.workspaceId]);

  const exportData = useCallback(async () => {
    setBusy('export');
    setError(null);
    setMessage(null);

    try {
      await ensureEngine();
      const adapter = adapterRef.current;
      if (!adapter) {
        throw new Error('Storage adapter not ready');
      }

      const snapshot = await buildExportSnapshot(adapter);
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
      throw exportError;
    } finally {
      setBusy(null);
    }
  }, [ensureEngine]);

  const importData = useCallback(async (file: File) => {
    setBusy('import');
    setError(null);
    setMessage(null);

    try {
      const zip = await JSZip.loadAsync(await file.arrayBuffer());
      const manifestText = await zip.file('manifest.json')?.async('string');
      if (!manifestText) {
        throw new Error('Import file missing manifest.json');
      }

      const manifest = JSON.parse(manifestText);
      const eventsFile = await zip.file('events/events.jsonl')?.async('string');

      const rawEvents = eventsFile
        ? eventsFile
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line.length > 0)
          .map((line) => JSON.parse(line))
        : [];

      await validateImportBundle({ manifest, events: rawEvents });

      const migratedEvents: StoredEvent[] = rawEvents
        .map((raw) => migrateEvent(raw))
        .map((event) => ({
          ...event,
          workspaceId: identity.workspaceId,
          syncStatus: typeof event.serverSeq === 'number' ? 'synced' : 'saved_local',
        }));

      if (migratedEvents.length === 0) {
        const portableState = await zip.file('portable/state.json')?.async('string');
        if (portableState) {
          const parsed = JSON.parse(portableState) as { atoms?: Array<{ atomId: string; title?: string; body: string; createdAtMs?: number }> };
          const synthesized = (parsed.atoms || []).map((atom, index) => ({
            eventId: generateEventId(),
            eventSchemaVersion: manifest.eventSchemaVersion,
            type: 'capture.text.create' as const,
            createdAtMs: typeof atom.createdAtMs === 'number' ? atom.createdAtMs : Date.now() + index,
            deviceId: identity.deviceId,
            workspaceId: identity.workspaceId,
            localSeq: undefined,
            payload: {
              atomId: atom.atomId,
              title: atom.title,
              body: atom.body,
            },
            syncStatus: 'saved_local' as const,
          }));
          migratedEvents.push(...synthesized);
        }
      }

      if (migratedEvents.length === 0) {
        throw new Error('Import file does not contain events or portable atoms');
      }

      const engine = await ensureEngine();
      const adapter = adapterRef.current;
      if (!adapter) {
        throw new Error('Storage adapter not ready');
      }

      await adapter.upsertEvents(migratedEvents);
      await engine.rebuildProjection();
      await refresh();
      setMessage(`Imported ${migratedEvents.length} event(s).`);
    } catch (importError) {
      setError(importError instanceof Error ? importError.message : 'Import failed');
      throw importError;
    } finally {
      setBusy(null);
    }
  }, [ensureEngine, identity.deviceId, identity.workspaceId, refresh]);

  const buildDiagnosticsSummary = useCallback(async (): Promise<DiagnosticsSummary> => {
    await ensureEngine();
    const adapter = adapterRef.current;
    if (!adapter) {
      throw new Error('Storage adapter not ready');
    }

    const status = syncStatus || (await engineRef.current!.getSyncStatus());
    const attempts = await adapter.listSyncAttempts(50);

    return {
      workspaceId: identity.workspaceId,
      deviceId: identity.deviceId,
      userId: auth?.userId || identity.userId,
      signedIn: Boolean(auth),
      lastSuccessAtMs: status.lastSuccessAtMs,
      lastPulledSeq: status.lastPulledSeq,
      lastAppliedSeq: status.lastAppliedSeq,
      pendingEvents: status.pendingEvents,
      pendingBlobs: status.pendingBlobs,
      lastError: status.lastError,
      attempts: attempts.map((attempt) => ({
        timestampMs: attempt.timestampMs,
        action: attempt.action,
        result: attempt.result,
        errorCode: attempt.errorCode,
        message: attempt.message,
      })),
    };
  }, [auth, ensureEngine, identity.deviceId, identity.userId, identity.workspaceId, syncStatus]);

  const copyDiagnosticsSummary = useCallback(async () => {
    setBusy('diagnostics-copy');
    setError(null);
    setMessage(null);

    try {
      const summary = await buildDiagnosticsSummary();
      await navigator.clipboard.writeText(diagnosticsSummaryText(summary));
      setMessage('Diagnostics summary copied.');
    } catch (diagError) {
      setError(diagError instanceof Error ? diagError.message : 'Failed to copy diagnostics summary');
      throw diagError;
    } finally {
      setBusy(null);
    }
  }, [buildDiagnosticsSummary]);

  const exportDiagnosticsZip = useCallback(async () => {
    setBusy('diagnostics-export');
    setError(null);
    setMessage(null);

    try {
      const summary = await buildDiagnosticsSummary();
      const zip = new JSZip();
      zip.file('summary.txt', diagnosticsSummaryText(summary));
      zip.file('summary.json', JSON.stringify(summary, null, 2));
      const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
      downloadBlob(`seedworld-diagnostics-${Date.now()}.zip`, blob);
      setMessage('Diagnostics downloaded.');
    } catch (diagError) {
      setError(diagError instanceof Error ? diagError.message : 'Failed to export diagnostics');
      throw diagError;
    } finally {
      setBusy(null);
    }
  }, [buildDiagnosticsSummary]);

  const contextValue = useMemo<SeedWorldContextValue>(() => ({
    auth,
    isSignedIn: Boolean(auth),
    workspaceId: identity.workspaceId,
    deviceId: identity.deviceId,
    localUserId: identity.userId,
    lastServerUrl,
    inbox,
    syncStatus,
    busy,
    error,
    message,
    setMessage,
    setError,
    captureText,
    syncNow,
    signIn,
    signOut,
    exportData,
    importData,
    copyDiagnosticsSummary,
    exportDiagnosticsZip,
    refresh,
  }), [
    auth,
    busy,
    captureText,
    copyDiagnosticsSummary,
    error,
    exportData,
    exportDiagnosticsZip,
    identity.deviceId,
    identity.userId,
    identity.workspaceId,
    importData,
    inbox,
    lastServerUrl,
    message,
    refresh,
    signIn,
    signOut,
    syncNow,
    syncStatus,
  ]);

  return (
    <SeedWorldContext.Provider value={contextValue}>
      {children}
    </SeedWorldContext.Provider>
  );
}

export function useSeedWorld(): SeedWorldContextValue {
  const context = useContext(SeedWorldContext);
  if (!context) {
    throw new Error('useSeedWorld must be used within SeedWorldProvider');
  }
  return context;
}
