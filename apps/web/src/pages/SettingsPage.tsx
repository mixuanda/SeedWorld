import React, { useEffect, useMemo, useState } from 'react';
import { useSeedWorld } from '../seedworld';

function formatTimestamp(value?: number): string {
  if (!value) {
    return 'Never';
  }
  return new Date(value).toLocaleString();
}

export function SettingsPage(): React.ReactElement {
  const seedworld = useSeedWorld();

  const [serverUrl, setServerUrl] = useState('');
  const [userId, setUserId] = useState(seedworld.localUserId || 'dev-user');
  const [workspaceId, setWorkspaceId] = useState(seedworld.workspaceId);

  useEffect(() => {
    setServerUrl(seedworld.auth?.serverUrl || seedworld.lastServerUrl || '');
    setUserId(seedworld.auth?.userId || seedworld.localUserId || 'dev-user');
    setWorkspaceId(seedworld.auth?.workspaceId || seedworld.workspaceId);
  }, [seedworld.auth, seedworld.lastServerUrl, seedworld.localUserId, seedworld.workspaceId]);

  const syncSummary = useMemo(() => {
    if (!seedworld.syncStatus) {
      return 'No sync status yet.';
    }

    return [
      `Last success: ${formatTimestamp(seedworld.syncStatus.lastSuccessAtMs)}`,
      `Pending events: ${seedworld.syncStatus.pendingEvents}`,
      `Pending blobs: ${seedworld.syncStatus.pendingBlobs}`,
      `Cursor: pull=${seedworld.syncStatus.lastPulledSeq} applied=${seedworld.syncStatus.lastAppliedSeq}`,
      seedworld.syncStatus.lastError
        ? `Last error: ${seedworld.syncStatus.lastError.message} (${seedworld.syncStatus.lastError.code})`
        : 'Last error: none',
    ].join(' · ');
  }, [seedworld.syncStatus]);

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <section style={{ border: '1px solid #ddd', borderRadius: 8, padding: 12, display: 'grid', gap: 8 }}>
        <h2 style={{ margin: 0 }}>Account & Sync (Dev Auth)</h2>
        <input
          value={serverUrl}
          onChange={(event) => setServerUrl(event.target.value)}
          placeholder="http://<LAN-IP>:8787"
        />
        <input
          value={userId}
          onChange={(event) => setUserId(event.target.value)}
          placeholder="User ID"
        />
        <input
          value={workspaceId}
          onChange={(event) => setWorkspaceId(event.target.value)}
          placeholder="Workspace ID"
        />
        <p style={{ margin: 0, fontSize: 12 }}>
          Phone testing: use your computer LAN IP, not 127.0.0.1.
        </p>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button
            onClick={async () => {
              await seedworld.signIn({ serverUrl, userId, workspaceId });
            }}
            disabled={seedworld.busy === 'signin'}
          >
            {seedworld.busy === 'signin' ? 'Signing in...' : 'Dev Sign In'}
          </button>
          <button onClick={seedworld.signOut} disabled={!seedworld.isSignedIn || seedworld.busy === 'signout'}>
            Sign out
          </button>
          <button onClick={seedworld.syncNow} disabled={!seedworld.isSignedIn || seedworld.busy === 'sync'}>
            {seedworld.busy === 'sync' ? 'Syncing...' : 'Sync now'}
          </button>
        </div>
        <p style={{ margin: 0 }}>{syncSummary}</p>
      </section>

      <section style={{ border: '1px solid #ddd', borderRadius: 8, padding: 12, display: 'grid', gap: 8 }}>
        <h2 style={{ margin: 0 }}>Import / Export</h2>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <button onClick={seedworld.exportData} disabled={seedworld.busy === 'export'}>
            {seedworld.busy === 'export' ? 'Exporting...' : 'Download export.zip'}
          </button>
          <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
            Import ZIP
            <input
              type="file"
              accept=".zip"
              disabled={seedworld.busy === 'import'}
              onChange={(event) => {
                const [file] = Array.from(event.target.files || []);
                if (file) {
                  seedworld.importData(file).catch(() => {
                    // Hook already sets user-facing error state.
                  });
                }
                event.target.value = '';
              }}
            />
          </label>
        </div>
      </section>

      <section style={{ border: '1px solid #ddd', borderRadius: 8, padding: 12, display: 'grid', gap: 8 }}>
        <h2 style={{ margin: 0 }}>Diagnostics</h2>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button onClick={seedworld.copyDiagnosticsSummary} disabled={seedworld.busy === 'diagnostics-copy'}>
            Copy diagnostics summary
          </button>
          <button onClick={seedworld.exportDiagnosticsZip} disabled={seedworld.busy === 'diagnostics-export'}>
            Export diagnostics.zip
          </button>
        </div>
        {seedworld.syncStatus?.lastError ? (
          <details>
            <summary>{seedworld.syncStatus.lastError.message}</summary>
            <pre style={{ margin: 0 }}>{JSON.stringify(seedworld.syncStatus.lastError, null, 2)}</pre>
          </details>
        ) : null}
      </section>

      {seedworld.message && <p style={{ color: '#0a7f35', margin: 0 }}>{seedworld.message}</p>}
      {seedworld.error && <p style={{ color: '#b00020', margin: 0 }}>{seedworld.error}</p>}
    </div>
  );
}
