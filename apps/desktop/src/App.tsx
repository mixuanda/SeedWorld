import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AuthConfig, Note, SyncStatus, VaultSyncHealthReport, VoiceNote } from './global';
import { VaultSetup } from './components/VaultSetup';
import { NotesList } from './components/NotesList';
import { NoteViewer } from './components/NoteViewer';
import { VoiceRecorder } from './components/VoiceRecorder';
import { Settings as AISettings } from './components/Settings';

type AppState = 'loading' | 'setup' | 'ready';

type AppPage =
  | 'quick-capture'
  | 'history'
  | 'organize'
  | 'ai-whisper'
  | 'settings';

type StorageSyncMode = 'local-folder' | 'cloud-provider' | 'self-hosted';

interface SignInForm {
  serverUrl: string;
  userId: string;
  workspaceId: string;
}

const DEFAULT_SIGN_IN: SignInForm = {
  serverUrl: '',
  userId: 'local-user',
  workspaceId: '',
};

const SIDEBAR_ITEMS: Array<{ id: AppPage; label: string; icon: string }> = [
  { id: 'quick-capture', label: 'Quick Capture', icon: '✍︎' },
  { id: 'history', label: 'History', icon: '🕘' },
  { id: 'organize', label: 'Organize', icon: '🗂' },
  { id: 'ai-whisper', label: 'AI & Whisper', icon: '⚙︎' },
  { id: 'settings', label: 'Settings', icon: '☰' },
];

function sortNotesByUpdatedAt(notes: Note[]): Note[] {
  return [...notes].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
}

function formatTimestamp(value?: number): string {
  if (!value) {
    return 'Never';
  }
  return new Date(value).toLocaleString();
}

function filterNotes(notes: Note[], query: string): Note[] {
  const keyword = query.trim().toLowerCase();
  if (!keyword) {
    return notes;
  }

  return notes.filter((note) => (
    note.title.toLowerCase().includes(keyword) || note.content.toLowerCase().includes(keyword)
  ));
}

export function App(): React.ReactElement {
  const [appState, setAppState] = useState<AppState>('loading');
  const [activePage, setActivePage] = useState<AppPage>('quick-capture');

  const [vaultPath, setVaultPath] = useState<string | null>(null);
  const [pingResult, setPingResult] = useState<string | null>(null);

  const [notes, setNotes] = useState<Note[]>([]);
  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null);
  const [historyQuery, setHistoryQuery] = useState('');
  const [organizeQuery, setOrganizeQuery] = useState('');

  const [captureTitle, setCaptureTitle] = useState('');
  const [captureBody, setCaptureBody] = useState('');

  const [authLoaded, setAuthLoaded] = useState(false);
  const [authConfig, setAuthConfig] = useState<AuthConfig | null>(null);
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null);
  const [signInForm, setSignInForm] = useState<SignInForm>(DEFAULT_SIGN_IN);
  const [storageSyncMode, setStorageSyncMode] = useState<StorageSyncMode>('local-folder');
  const [syncHealthReport, setSyncHealthReport] = useState<VaultSyncHealthReport | null>(null);

  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [importMode, setImportMode] = useState<'restore' | 'clone'>('restore');

  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const captureTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const toastTimerRef = useRef<number | null>(null);

  const showToast = useCallback((message: string) => {
    setToastMessage(message);
    if (toastTimerRef.current !== null) {
      window.clearTimeout(toastTimerRef.current);
    }
    toastTimerRef.current = window.setTimeout(() => {
      setToastMessage(null);
      toastTimerRef.current = null;
    }, 2500);
  }, []);

  const focusCaptureTextarea = useCallback(() => {
    window.setTimeout(() => {
      captureTextareaRef.current?.focus();
    }, 0);
  }, []);

  const loadNotes = useCallback(async (): Promise<Note[]> => {
    const loadedNotes = await window.api.vault.loadNotes();
    const sorted = sortNotesByUpdatedAt(loadedNotes);
    setNotes(sorted);
    setSelectedNoteId((current) => {
      if (current && sorted.some((note) => note.id === current)) {
        return current;
      }
      return sorted[0]?.id ?? null;
    });
    return sorted;
  }, []);

  const refreshExperimentalSync = useCallback(async () => {
    const [localWorkspace, auth] = await Promise.all([
      window.api.auth.getLocalWorkspace(),
      window.api.auth.getConfig(),
    ]);

    setAuthConfig(auth);
    setSignInForm((previous) => ({
      serverUrl: auth?.serverUrl || previous.serverUrl,
      userId: auth?.userId || localWorkspace.userId,
      workspaceId: auth?.workspaceId || localWorkspace.workspaceId,
    }));

    try {
      const status = await window.api.sync.getStatus();
      setSyncStatus(status);
    } catch (statusError) {
      console.warn('[App] Failed to load sync status', statusError);
      setSyncStatus(null);
    }
  }, []);

  const runSyncHealthCheck = useCallback(async (options?: { silent?: boolean }) => {
    const silent = options?.silent === true;
    if (!silent) {
      setBusyAction('sync-health-check');
      setErrorMessage(null);
    }

    try {
      const report = await window.api.vault.syncHealthCheck();
      setSyncHealthReport(report);

      if (!silent) {
        showToast(
          report.status === 'ok'
            ? 'Sync health check: OK.'
            : 'Sync health check: warnings found.',
        );
      }
    } catch (healthError) {
      if (!silent) {
        setErrorMessage(healthError instanceof Error ? healthError.message : 'Sync health check failed');
      }
    } finally {
      if (!silent) {
        setBusyAction(null);
      }
    }
  }, [showToast]);

  useEffect(() => {
    const initialize = async () => {
      try {
        const pong = await window.api.ping();
        setPingResult(pong);
      } catch (pingError) {
        console.error('[App] Ping failed', pingError);
      }

      try {
        const existingVaultPath = await window.api.vault.getPath();
        if (!existingVaultPath) {
          setAppState('setup');
          return;
        }

        setVaultPath(existingVaultPath);
        setAppState('ready');
        await Promise.all([
          loadNotes(),
          refreshExperimentalSync(),
          runSyncHealthCheck({ silent: true }),
        ]);
      } catch (initError) {
        console.error('[App] Failed to initialize app', initError);
        setErrorMessage(initError instanceof Error ? initError.message : 'Initialization failed');
      } finally {
        setAuthLoaded(true);
      }
    };

    initialize();
  }, [loadNotes, refreshExperimentalSync, runSyncHealthCheck]);

  useEffect(() => {
    if (appState === 'ready' && activePage === 'quick-capture') {
      focusCaptureTextarea();
    }
  }, [activePage, appState, focusCaptureTextarea]);

  useEffect(() => {
    return () => {
      if (toastTimerRef.current !== null) {
        window.clearTimeout(toastTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (appState === 'ready' && activePage === 'settings' && !syncHealthReport) {
      void runSyncHealthCheck({ silent: true });
    }
  }, [activePage, appState, runSyncHealthCheck, syncHealthReport]);

  const handleVaultSelected = useCallback(async (selectedPath: string) => {
    setVaultPath(selectedPath);
    setAppState('ready');
    setErrorMessage(null);

    await Promise.all([
      loadNotes(),
      refreshExperimentalSync(),
      runSyncHealthCheck({ silent: true }),
    ]);

    showToast('Vault configured. Quick Capture is ready.');
    setActivePage('quick-capture');
    focusCaptureTextarea();
  }, [focusCaptureTextarea, loadNotes, refreshExperimentalSync, runSyncHealthCheck, showToast]);

  const handleSaveCapture = useCallback(async () => {
    const content = captureBody.trim();
    if (!content) {
      return;
    }

    setBusyAction('save-capture');
    setErrorMessage(null);

    try {
      const savedNote = await window.api.vault.saveNote({
        title: captureTitle.trim() || undefined,
        content,
      });

      setNotes((previous) => sortNotesByUpdatedAt([savedNote, ...previous.filter((note) => note.id !== savedNote.id)]));
      setCaptureTitle('');
      setCaptureBody('');
      showToast('Saved. Ready for the next capture.');
      focusCaptureTextarea();
    } catch (saveError) {
      console.error('[App] Failed to save note', saveError);
      setErrorMessage(saveError instanceof Error ? saveError.message : 'Failed to save note');
    } finally {
      setBusyAction(null);
    }
  }, [captureBody, captureTitle, focusCaptureTextarea, showToast]);

  const handleCaptureKeyDown = useCallback((event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void handleSaveCapture();
    }
  }, [handleSaveCapture]);

  const handleVoiceSaved = useCallback((voiceNote: VoiceNote) => {
    setNotes((previous) => sortNotesByUpdatedAt([
      voiceNote,
      ...previous.filter((note) => note.id !== voiceNote.id),
    ]));
    showToast('Voice note saved.');
  }, [showToast]);

  const handleRefreshNotes = useCallback(async () => {
    setBusyAction('refresh-notes');
    setErrorMessage(null);
    try {
      const refreshed = await loadNotes();
      showToast(`Loaded ${refreshed.length} notes.`);
    } catch (loadError) {
      setErrorMessage(loadError instanceof Error ? loadError.message : 'Failed to refresh notes');
    } finally {
      setBusyAction(null);
    }
  }, [loadNotes, showToast]);

  const handleRebuildIndex = useCallback(async () => {
    setBusyAction('rebuild-index');
    setErrorMessage(null);

    try {
      const index = await window.api.vault.rebuildIndex();
      await loadNotes();
      if (index) {
        showToast(`Index rebuilt (${index.notes.length} notes).`);
      } else {
        showToast('Index rebuilt.');
      }
    } catch (rebuildError) {
      setErrorMessage(rebuildError instanceof Error ? rebuildError.message : 'Failed to rebuild index');
    } finally {
      setBusyAction(null);
    }
  }, [loadNotes, showToast]);

  const handleDeleteNote = useCallback((noteId: string) => {
    void (async () => {
      setBusyAction('delete-note');
      setErrorMessage(null);
      try {
        const deleted = await window.api.vault.deleteNote(noteId);
        if (!deleted) {
          throw new Error('Note was not deleted.');
        }

        const updated = notes.filter((note) => note.id !== noteId);
        setNotes(updated);
        setSelectedNoteId((current) => {
          if (current !== noteId) {
            return current;
          }
          return updated[0]?.id ?? null;
        });
        showToast('Note deleted.');
      } catch (deleteError) {
        setErrorMessage(deleteError instanceof Error ? deleteError.message : 'Failed to delete note');
      } finally {
        setBusyAction(null);
      }
    })();
  }, [notes, showToast]);

  const handleChangeVaultFolder = useCallback(async () => {
    setBusyAction('change-vault');
    setErrorMessage(null);

    try {
      const selectedPath = await window.api.vault.selectFolder();
      if (!selectedPath) {
        return;
      }

      setVaultPath(selectedPath);
      await Promise.all([
        loadNotes(),
        refreshExperimentalSync(),
        runSyncHealthCheck({ silent: true }),
      ]);
      showToast('Vault folder updated.');
    } catch (changeError) {
      setErrorMessage(changeError instanceof Error ? changeError.message : 'Failed to change vault folder');
    } finally {
      setBusyAction(null);
    }
  }, [loadNotes, refreshExperimentalSync, runSyncHealthCheck, showToast]);

  const handleCopyVaultPath = useCallback(async () => {
    if (!vaultPath) {
      return;
    }

    setErrorMessage(null);
    try {
      await navigator.clipboard.writeText(vaultPath);
      showToast('Vault path copied.');
    } catch (copyError) {
      setErrorMessage(copyError instanceof Error ? copyError.message : 'Failed to copy vault path');
    }
  }, [showToast, vaultPath]);

  const handleExport = useCallback(async () => {
    setBusyAction('export');
    setErrorMessage(null);

    try {
      const filePath = await window.api.exportData.create();
      if (filePath) {
        showToast(`Export saved: ${filePath}`);
      }
    } catch (exportError) {
      setErrorMessage(exportError instanceof Error ? exportError.message : 'Export failed');
    } finally {
      setBusyAction(null);
    }
  }, [showToast]);

  const handleImport = useCallback(async () => {
    setBusyAction('import');
    setErrorMessage(null);

    try {
      const result = await window.api.importData.fromZip({ mode: importMode });
      if (result) {
        await loadNotes();
        await refreshExperimentalSync();
        showToast(`Import complete (${result.importedEvents} events).`);
      }
    } catch (importError) {
      setErrorMessage(importError instanceof Error ? importError.message : 'Import failed');
    } finally {
      setBusyAction(null);
    }
  }, [importMode, loadNotes, refreshExperimentalSync, showToast]);

  const handleDiagnosticsCopy = useCallback(async () => {
    setBusyAction('diagnostics-copy');
    setErrorMessage(null);

    try {
      const summary = await window.api.diagnostics.getSummary();
      await navigator.clipboard.writeText(summary);
      showToast('Diagnostics summary copied.');
    } catch (diagError) {
      setErrorMessage(diagError instanceof Error ? diagError.message : 'Failed to copy diagnostics summary');
    } finally {
      setBusyAction(null);
    }
  }, [showToast]);

  const handleDiagnosticsExport = useCallback(async () => {
    setBusyAction('diagnostics-export');
    setErrorMessage(null);

    try {
      const filePath = await window.api.diagnostics.export();
      if (filePath) {
        showToast(`Diagnostics exported: ${filePath}`);
      }
    } catch (diagError) {
      setErrorMessage(diagError instanceof Error ? diagError.message : 'Failed to export diagnostics');
    } finally {
      setBusyAction(null);
    }
  }, [showToast]);

  const handleDevSignIn = useCallback(async () => {
    setBusyAction('experimental-signin');
    setErrorMessage(null);

    try {
      if (!signInForm.serverUrl.trim()) {
        throw new Error('Server URL is required for dev auth.');
      }

      await window.api.auth.devSignIn({
        serverUrl: signInForm.serverUrl,
        userId: signInForm.userId,
        workspaceId: signInForm.workspaceId,
      });
      await refreshExperimentalSync();
      showToast('Experimental sync sign-in successful.');
    } catch (signInError) {
      setErrorMessage(signInError instanceof Error ? signInError.message : 'Dev sign-in failed');
    } finally {
      setBusyAction(null);
    }
  }, [refreshExperimentalSync, showToast, signInForm.serverUrl, signInForm.userId, signInForm.workspaceId]);

  const handleDevSignOut = useCallback(async () => {
    setBusyAction('experimental-signout');
    setErrorMessage(null);

    try {
      await window.api.auth.signOut();
      await refreshExperimentalSync();
      showToast('Experimental sync signed out.');
    } catch (signOutError) {
      setErrorMessage(signOutError instanceof Error ? signOutError.message : 'Sign out failed');
    } finally {
      setBusyAction(null);
    }
  }, [refreshExperimentalSync, showToast]);

  const handleExperimentalSyncNow = useCallback(async () => {
    setBusyAction('experimental-sync');
    setErrorMessage(null);

    try {
      const status = await window.api.sync.now();
      setSyncStatus(status);
      showToast('Experimental sync completed.');
    } catch (syncError) {
      setErrorMessage(syncError instanceof Error ? syncError.message : 'Sync failed');
    } finally {
      setBusyAction(null);
    }
  }, [showToast]);

  const recentNotes = useMemo(() => notes.slice(0, 5), [notes]);
  const historyResults = useMemo(() => filterNotes(notes, historyQuery), [historyQuery, notes]);
  const organizeResults = useMemo(() => filterNotes(notes, organizeQuery), [notes, organizeQuery]);

  const selectedNote = useMemo(
    () => notes.find((note) => note.id === selectedNoteId) || null,
    [notes, selectedNoteId],
  );

  const syncSummary = useMemo(() => {
    if (!syncStatus) {
      return 'No sync status available yet.';
    }

    return [
      `Last success: ${formatTimestamp(syncStatus.lastSuccessAtMs)}`,
      `Pending events: ${syncStatus.pendingEvents}`,
      `Pending blobs: ${syncStatus.pendingBlobs}`,
      `Cursor: pull=${syncStatus.lastPulledSeq} applied=${syncStatus.lastAppliedSeq}`,
      syncStatus.lastError ? `Last error: ${syncStatus.lastError.message} (${syncStatus.lastError.code})` : 'Last error: none',
    ].join(' · ');
  }, [syncStatus]);

  const syncHealthStatusLabel = useMemo(() => {
    if (!syncHealthReport) {
      return 'Unknown';
    }
    return syncHealthReport.status === 'ok' ? 'OK' : 'Warning';
  }, [syncHealthReport]);

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
        <h1>SeedWorld</h1>
        <div className="header-right">
          {pingResult && <span className="ping-status">IPC OK</span>}
          {vaultPath && <span className="vault-status" title={vaultPath}>Vault Ready</span>}
        </div>
      </header>

      <div className="workspace-layout">
        <aside className="sidebar-nav" aria-label="Primary navigation">
          {SIDEBAR_ITEMS.map((item) => (
            <button
              key={item.id}
              className={`sidebar-nav-item ${activePage === item.id ? 'active' : ''}`}
              onClick={() => setActivePage(item.id)}
            >
              <span className="sidebar-nav-icon" aria-hidden="true">{item.icon}</span>
              <span className="sidebar-nav-label">{item.label}</span>
            </button>
          ))}
        </aside>

        <main className="workspace-main">
          {activePage === 'quick-capture' && (
            <section className="capture-page">
              <header className="page-header">
                <h2>Quick Capture</h2>
                <p>Capture fast, keep flow. Nothing blocks local save.</p>
              </header>

              <div className="capture-page-card">
                <input
                  className="capture-title-input"
                  value={captureTitle}
                  onChange={(event) => setCaptureTitle(event.target.value)}
                  placeholder="Optional title"
                  disabled={busyAction === 'save-capture'}
                />
                <textarea
                  ref={captureTextareaRef}
                  className="capture-textarea"
                  value={captureBody}
                  onChange={(event) => setCaptureBody(event.target.value)}
                  onKeyDown={handleCaptureKeyDown}
                  placeholder="Write your capture..."
                  disabled={busyAction === 'save-capture'}
                />
                <div className="capture-toolbar">
                  <button
                    className="save-button"
                    onClick={() => {
                      void handleSaveCapture();
                    }}
                    disabled={busyAction === 'save-capture' || !captureBody.trim()}
                  >
                    {busyAction === 'save-capture' ? 'Saving...' : 'Save'}
                  </button>
                  <span className="capture-shortcut-hint">Cmd/Ctrl + Enter to save</span>
                </div>
              </div>

              <div className="capture-voice-card">
                <h3>Hold ideas by voice</h3>
                <VoiceRecorder onRecordingComplete={handleVoiceSaved} />
              </div>

              <div className="recent-strip">
                <div className="recent-strip-header">Recent</div>
                {recentNotes.length === 0 ? (
                  <p className="recent-empty">No notes yet.</p>
                ) : (
                  <div className="recent-strip-items">
                    {recentNotes.map((note) => (
                      <button
                        key={note.id}
                        className="recent-chip"
                        onClick={() => {
                          setSelectedNoteId(note.id);
                          setActivePage('history');
                        }}
                      >
                        {note.title}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </section>
          )}

          {activePage === 'history' && (
            <section className="page-section">
              <header className="page-header-row">
                <h2>History</h2>
                <div className="page-actions">
                  <button
                    className="save-button"
                    onClick={() => {
                      void handleRefreshNotes();
                    }}
                    disabled={busyAction === 'refresh-notes'}
                  >
                    Refresh
                  </button>
                  <button
                    className="save-button"
                    onClick={() => {
                      void handleRebuildIndex();
                    }}
                    disabled={busyAction === 'rebuild-index'}
                  >
                    Rebuild index
                  </button>
                </div>
              </header>

              <div className="page-search-row">
                <input
                  className="settings-input"
                  value={historyQuery}
                  onChange={(event) => setHistoryQuery(event.target.value)}
                  placeholder="Search title or content"
                />
              </div>

              <div className="main-split history-split">
                <aside className="panel-left">
                  <NotesList
                    notes={historyResults}
                    selectedNoteId={selectedNoteId}
                    onSelectNote={(note) => setSelectedNoteId(note.id)}
                  />
                </aside>
                <section className="panel-right">
                  <NoteViewer note={selectedNote} onDelete={handleDeleteNote} />
                </section>
              </div>
            </section>
          )}

          {activePage === 'organize' && (
            <section className="page-section">
              <header className="page-header-row">
                <h2>Organize (Coming Soon)</h2>
              </header>

              <div className="page-search-row">
                <input
                  className="settings-input"
                  value={organizeQuery}
                  onChange={(event) => setOrganizeQuery(event.target.value)}
                  placeholder="Search across notes"
                />
              </div>

              <div className="organize-grid">
                <div className="organize-panel">
                  <h3>Matching notes</h3>
                  {organizeResults.length === 0 ? (
                    <p className="recent-empty">No matching notes.</p>
                  ) : (
                    <ul className="organize-results-list">
                      {organizeResults.slice(0, 20).map((note) => (
                        <li key={note.id}>
                          <button
                            className="organize-result-button"
                            onClick={() => {
                              setSelectedNoteId(note.id);
                              setActivePage('history');
                            }}
                          >
                            <strong>{note.title}</strong>
                            <span>{note.content.slice(0, 110)}{note.content.length > 110 ? '...' : ''}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>

                <div className="organize-panel">
                  <h3>Suggested next actions</h3>
                  <ul className="organize-actions-list">
                    <li>Tag captures by project and timeframe.</li>
                    <li>Link related notes before weekly review.</li>
                    <li>Promote recurring ideas into standing docs.</li>
                    <li>Create a Friday inbox-to-structure routine.</li>
                  </ul>
                </div>
              </div>
            </section>
          )}

          {activePage === 'ai-whisper' && (
            <section className="page-section">
              <header className="page-header-row">
                <h2>AI & Whisper</h2>
              </header>
              <AISettings onClose={() => setActivePage('quick-capture')} embedded />
            </section>
          )}

          {activePage === 'settings' && (
            <section className="page-section">
              <header className="page-header-row">
                <h2>Settings</h2>
              </header>

              <div className="settings-stack">
                <section className="settings-card">
                  <h3>Storage & Sync</h3>
                  <p className="settings-card-note">
                    SeedWorld stores everything in a local vault folder. Cloud sync is managed by your folder provider.
                  </p>

                  <div className="storage-mode-chooser" role="group" aria-label="Storage and sync mode">
                    <button
                      className={`storage-mode-option ${storageSyncMode === 'local-folder' ? 'active' : ''}`}
                      onClick={() => setStorageSyncMode('local-folder')}
                    >
                      <span className="storage-mode-title">Local Folder</span>
                      <span className="storage-mode-meta">Available · Recommended</span>
                    </button>

                    <button
                      className="storage-mode-option disabled"
                      disabled
                      title="Coming soon"
                    >
                      <span className="storage-mode-title">Cloud Provider Sync</span>
                      <span className="storage-mode-meta">Coming soon</span>
                    </button>

                    <button
                      className={`storage-mode-option ${storageSyncMode === 'self-hosted' ? 'active' : ''}`}
                      onClick={() => setStorageSyncMode('self-hosted')}
                    >
                      <span className="storage-mode-title">Self-hosted Sync Server</span>
                      <span className="storage-mode-meta">Experimental</span>
                    </button>
                  </div>

                  {storageSyncMode === 'local-folder' && (
                    <div className="storage-mode-panel">
                      <p className="settings-card-note">
                        Put this vault inside your OneDrive, iCloud, Dropbox, or Syncthing folder to sync across devices.
                      </p>

                      <div className="storage-path-row">
                        <p className="settings-card-path">{vaultPath || 'No vault configured'}</p>
                        <button
                          className="save-button"
                          onClick={() => { void handleCopyVaultPath(); }}
                          disabled={!vaultPath}
                        >
                          Copy path
                        </button>
                      </div>

                      <div className="settings-card-actions">
                        <button
                          className="save-button"
                          onClick={() => { void handleChangeVaultFolder(); }}
                          disabled={busyAction === 'change-vault'}
                        >
                          Reselect folder
                        </button>
                        <button
                          className="save-button"
                          onClick={() => { void handleRefreshNotes(); }}
                          disabled={busyAction === 'refresh-notes'}
                        >
                          Refresh
                        </button>
                        <button
                          className="save-button"
                          onClick={() => { void handleRebuildIndex(); }}
                          disabled={busyAction === 'rebuild-index'}
                        >
                          Rebuild Index
                        </button>
                      </div>

                      <div className="sync-health-panel">
                        <div className="sync-health-header">
                          <h4>Sync Health Check</h4>
                          <span className={`sync-health-badge ${syncHealthReport?.status === 'ok' ? 'ok' : 'warning'}`}>
                            {syncHealthStatusLabel}
                          </span>
                        </div>
                        <button
                          className="save-button"
                          onClick={() => { void runSyncHealthCheck(); }}
                          disabled={busyAction === 'sync-health-check'}
                        >
                          {busyAction === 'sync-health-check' ? 'Checking...' : 'Run health check'}
                        </button>

                        {syncHealthReport && (
                          <div className="sync-health-details">
                            <p>
                              Cloud-folder heuristic: {syncHealthReport.looksLikeCloudFolder ? 'Detected' : 'Not detected'}
                              {syncHealthReport.detectedProviders.length > 0 && (
                                <> ({syncHealthReport.detectedProviders.join(', ')})</>
                              )}
                            </p>
                            <p>Conflict-copy files found: {syncHealthReport.conflictFiles.length}</p>
                            {syncHealthReport.conflictFiles.length > 0 && (
                              <ul className="sync-health-conflicts">
                                {syncHealthReport.conflictFiles.slice(0, 8).map((conflictPath) => (
                                  <li key={conflictPath}>{conflictPath}</li>
                                ))}
                              </ul>
                            )}
                            <ul className="sync-health-recommendations">
                              {syncHealthReport.recommendations.map((recommendation) => (
                                <li key={recommendation}>{recommendation}</li>
                              ))}
                            </ul>
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  {storageSyncMode === 'cloud-provider' && (
                    <p className="settings-card-note">
                      Built-in provider integrations are coming later. For now use Local Folder mode and your provider client.
                    </p>
                  )}

                  {storageSyncMode === 'self-hosted' && (
                    <p className="settings-card-note">
                      Self-hosted sync is optional and experimental. Use the collapsed Experimental section below if needed.
                    </p>
                  )}
                </section>

                <section className="settings-card">
                  <h3>Import / Export / Diagnostics</h3>
                  <div className="settings-card-actions">
                    <button className="save-button" onClick={() => { void handleExport(); }} disabled={busyAction === 'export'}>
                      Export ZIP
                    </button>
                    <label className="settings-inline-label" htmlFor="import-mode-select">
                      Import mode
                      <select
                        id="import-mode-select"
                        value={importMode}
                        onChange={(event) => setImportMode(event.target.value as 'restore' | 'clone')}
                        disabled={busyAction === 'import'}
                      >
                        <option value="restore">Restore (keep workspaceId)</option>
                        <option value="clone">Clone (new workspaceId)</option>
                      </select>
                    </label>
                    <button className="save-button" onClick={() => { void handleImport(); }} disabled={busyAction === 'import'}>
                      {busyAction === 'import' ? 'Importing...' : 'Import/Restore ZIP'}
                    </button>
                    <button className="save-button" onClick={() => { void handleDiagnosticsCopy(); }} disabled={busyAction === 'diagnostics-copy'}>
                      Copy diagnostics summary
                    </button>
                    <button className="save-button" onClick={() => { void handleDiagnosticsExport(); }} disabled={busyAction === 'diagnostics-export'}>
                      Export diagnostics ZIP
                    </button>
                  </div>
                </section>

                <section className="settings-card">
                  <details className="experimental-details">
                    <summary>Experimental: Custom sync-server controls (not required for normal use)</summary>
                    <div className="experimental-content">
                      <div className="experimental-grid">
                        <input
                          className="settings-input"
                          value={signInForm.serverUrl}
                          onChange={(event) => setSignInForm((previous) => ({ ...previous, serverUrl: event.target.value }))}
                          placeholder="http://<LAN-IP>:8787"
                        />
                        <input
                          className="settings-input"
                          value={signInForm.userId}
                          onChange={(event) => setSignInForm((previous) => ({ ...previous, userId: event.target.value }))}
                          placeholder="User ID"
                        />
                        <input
                          className="settings-input"
                          value={signInForm.workspaceId}
                          onChange={(event) => setSignInForm((previous) => ({ ...previous, workspaceId: event.target.value }))}
                          placeholder="Workspace ID"
                        />
                      </div>

                      <div className="settings-card-actions">
                        <button className="save-button" onClick={() => { void handleDevSignIn(); }} disabled={busyAction === 'experimental-signin'}>
                          {busyAction === 'experimental-signin' ? 'Signing in...' : 'Dev Sign In'}
                        </button>
                        <button className="save-button" onClick={() => { void handleDevSignOut(); }} disabled={busyAction === 'experimental-signout' || !authConfig}>
                          Sign out
                        </button>
                        <button className="save-button" onClick={() => { void handleExperimentalSyncNow(); }} disabled={busyAction === 'experimental-sync' || !authConfig}>
                          {busyAction === 'experimental-sync' ? 'Syncing...' : 'Sync now'}
                        </button>
                      </div>

                      <p className="experimental-status">{syncSummary}</p>
                    </div>
                  </details>
                </section>
              </div>
            </section>
          )}
        </main>
      </div>

      {toastMessage && <div className="app-toast">{toastMessage}</div>}
      {errorMessage && <div className="app-error-banner">{errorMessage}</div>}
    </div>
  );
}

export default App;
