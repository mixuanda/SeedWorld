import React, { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { type InboxItem } from '@seedworld/core';
import { useSeedWorld } from '../seedworld';

function statusLabel(status: InboxItem['syncStatus']): string {
  return status.replace(/_/g, ' ');
}

function formatTimestamp(value?: number): string {
  if (!value) {
    return 'Never';
  }
  return new Date(value).toLocaleString();
}

export function InboxPage(): React.ReactElement {
  const seedworld = useSeedWorld();
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');

  const syncSummary = useMemo(() => {
    if (!seedworld.syncStatus) {
      return 'No sync status yet.';
    }

    return [
      `Last success ${formatTimestamp(seedworld.syncStatus.lastSuccessAtMs)}`,
      `${seedworld.syncStatus.pendingEvents} pending event(s)`,
      `${seedworld.syncStatus.pendingBlobs} pending blob(s)`,
      seedworld.syncStatus.lastError ? `Error ${seedworld.syncStatus.lastError.code}` : 'No errors',
    ].join(' · ');
  }, [seedworld.syncStatus]);

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <section style={{ border: '1px solid #ddd', borderRadius: 8, padding: 12, display: 'grid', gap: 8 }}>
        <h2 style={{ margin: 0 }}>Quick Capture</h2>
        <input
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="Title (optional)"
          disabled={seedworld.busy === 'capture'}
        />
        <textarea
          value={body}
          onChange={(event) => setBody(event.target.value)}
          placeholder="Capture text"
          style={{ minHeight: 96 }}
          disabled={seedworld.busy === 'capture'}
        />
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            onClick={async () => {
              if (!body.trim()) {
                return;
              }
              await seedworld.captureText({ title: title.trim() || undefined, body: body.trim() });
              setTitle('');
              setBody('');
            }}
            disabled={!body.trim() || seedworld.busy === 'capture'}
          >
            {seedworld.busy === 'capture' ? 'Saving...' : 'Save Locally'}
          </button>
        </div>
      </section>

      <section style={{ border: '1px solid #ddd', borderRadius: 8, padding: 12, display: 'grid', gap: 8 }}>
        <h2 style={{ margin: 0 }}>Sync</h2>
        <p style={{ margin: 0 }}>{syncSummary}</p>
        {!seedworld.isSignedIn && (
          <p style={{ margin: 0 }}>Sync is off (sign in from Settings).</p>
        )}
        <div style={{ display: 'flex', gap: 8 }}>
          <Link to="/settings">
            <button>Open Settings</button>
          </Link>
        </div>
      </section>

      {seedworld.message && <p style={{ color: '#0a7f35', margin: 0 }}>{seedworld.message}</p>}
      {seedworld.error && <p style={{ color: '#b00020', margin: 0 }}>{seedworld.error}</p>}

      <section style={{ border: '1px solid #ddd', borderRadius: 8, padding: 12 }}>
        <h2 style={{ marginTop: 0 }}>Inbox ({seedworld.inbox.length})</h2>
        {seedworld.inbox.length === 0 ? (
          <p>No items yet.</p>
        ) : (
          <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'grid', gap: 8 }}>
            {seedworld.inbox.map((item) => (
              <li key={item.id} style={{ border: '1px solid #eee', borderRadius: 8, padding: 8 }}>
                <strong>{item.title}</strong>
                <div style={{ fontSize: 12, color: '#666' }}>
                  {item.id} · {statusLabel(item.syncStatus)}
                </div>
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
