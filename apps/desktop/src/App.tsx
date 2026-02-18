import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import i18n, { LANGUAGE_CACHE_KEY } from './i18n';
import type {
  AppLanguage,
  AppPreferences,
  AuthConfig,
  Note,
  SyncStatus,
  ThemeMode,
  VaultSyncHealthReport,
  VoiceNote,
} from './global';
import { applyThemeMode } from './theme';
import { VaultSetup } from './components/VaultSetup';
import { NotesList } from './components/NotesList';
import { NoteViewer } from './components/NoteViewer';
import { VoiceRecorder } from './components/VoiceRecorder';
import { Settings as AISettings } from './components/Settings';

type AppState = 'loading' | 'setup' | 'ready';

type AppPage =
  | 'quick-capture'
  | 'past-notes'
  | 'organize'
  | 'voice-ai'
  | 'settings';

type SettingsTab = 'storage' | 'data' | 'appearance' | 'voice-ai' | 'experimental';

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

const DEFAULT_PREFERENCES: AppPreferences = {
  themeMode: 'system',
  language: 'en',
  experimentalFeaturesEnabled: false,
};

const SIDEBAR_ITEMS: Array<{ id: AppPage; icon: string; labelKey: string }> = [
  { id: 'quick-capture', icon: '✍︎', labelKey: 'sidebar.quickCapture' },
  { id: 'past-notes', icon: '🕘', labelKey: 'sidebar.pastNotes' },
  { id: 'organize', icon: '🗂', labelKey: 'sidebar.organize' },
  { id: 'voice-ai', icon: '⚙︎', labelKey: 'sidebar.voiceAi' },
  { id: 'settings', icon: '☰', labelKey: 'sidebar.settings' },
];

function sortNotesByUpdatedAt(notes: Note[]): Note[] {
  return [...notes].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
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

function formatTimestamp(value: number | undefined, neverLabel: string): string {
  if (!value) {
    return neverLabel;
  }
  return new Date(value).toLocaleString();
}

export function App(): React.ReactElement {
  const { t } = useTranslation();

  const [appState, setAppState] = useState<AppState>('loading');
  const [activePage, setActivePage] = useState<AppPage>('quick-capture');
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('storage');

  const [vaultPath, setVaultPath] = useState<string | null>(null);
  const [pingResult, setPingResult] = useState<string | null>(null);

  const [notes, setNotes] = useState<Note[]>([]);
  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null);
  const [pastNotesQuery, setPastNotesQuery] = useState('');
  const [organizeQuery, setOrganizeQuery] = useState('');

  const [captureTitle, setCaptureTitle] = useState('');
  const [captureBody, setCaptureBody] = useState('');

  const [authLoaded, setAuthLoaded] = useState(false);
  const [authConfig, setAuthConfig] = useState<AuthConfig | null>(null);
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null);
  const [signInForm, setSignInForm] = useState<SignInForm>(DEFAULT_SIGN_IN);

  const [preferences, setPreferences] = useState<AppPreferences>(DEFAULT_PREFERENCES);

  const [storageSyncMode, setStorageSyncMode] = useState<StorageSyncMode>('local-folder');
  const [syncHealthReport, setSyncHealthReport] = useState<VaultSyncHealthReport | null>(null);

  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [importMode, setImportMode] = useState<'restore' | 'clone'>('restore');

  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const captureTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const toastTimerRef = useRef<number | null>(null);
  const initializedRef = useRef(false);

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
        showToast(report.status === 'ok' ? t('settings.storage.healthOkToast') : t('settings.storage.healthWarningToast'));
      }
    } catch (healthError) {
      if (!silent) {
        setErrorMessage(healthError instanceof Error ? healthError.message : t('errors.syncHealthFailed'));
      }
    } finally {
      if (!silent) {
        setBusyAction(null);
      }
    }
  }, [showToast, t]);

  useEffect(() => {
    if (initializedRef.current) {
      return;
    }
    initializedRef.current = true;

    const initialize = async () => {
      try {
        const pong = await window.api.ping();
        setPingResult(pong);
      } catch (pingError) {
        console.error('[App] Ping failed', pingError);
      }

      try {
        const nextPreferences = await window.api.preferences.get();
        setPreferences(nextPreferences);
        applyThemeMode(nextPreferences.themeMode);

        await i18n.changeLanguage(nextPreferences.language);
        localStorage.setItem(LANGUAGE_CACHE_KEY, nextPreferences.language);

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
        setErrorMessage(initError instanceof Error ? initError.message : t('errors.initializationFailed'));
      } finally {
        setAuthLoaded(true);
      }
    };

    initialize();
  }, [loadNotes, refreshExperimentalSync, runSyncHealthCheck, t]);

  useEffect(() => {
    if (appState === 'ready' && activePage === 'quick-capture') {
      focusCaptureTextarea();
    }
  }, [activePage, appState, focusCaptureTextarea]);

  useEffect(() => {
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const handleChange = () => {
      if (preferences.themeMode === 'system') {
        applyThemeMode('system');
      }
    };

    mediaQuery.addEventListener('change', handleChange);
    return () => {
      mediaQuery.removeEventListener('change', handleChange);
    };
  }, [preferences.themeMode]);

  useEffect(() => {
    const handleGlobalKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'l') {
        event.preventDefault();
        setActivePage('quick-capture');
        focusCaptureTextarea();
      }
    };

    window.addEventListener('keydown', handleGlobalKeyDown);
    return () => {
      window.removeEventListener('keydown', handleGlobalKeyDown);
    };
  }, [focusCaptureTextarea]);

  useEffect(() => {
    return () => {
      if (toastTimerRef.current !== null) {
        window.clearTimeout(toastTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!preferences.experimentalFeaturesEnabled && settingsTab === 'experimental') {
      setSettingsTab('storage');
    }
  }, [preferences.experimentalFeaturesEnabled, settingsTab]);

  useEffect(() => {
    if (!preferences.experimentalFeaturesEnabled && storageSyncMode === 'self-hosted') {
      setStorageSyncMode('local-folder');
    }
  }, [preferences.experimentalFeaturesEnabled, storageSyncMode]);

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

    showToast(t('quickCapture.savedToast'));
    setActivePage('quick-capture');
    focusCaptureTextarea();
  }, [focusCaptureTextarea, loadNotes, refreshExperimentalSync, runSyncHealthCheck, showToast, t]);

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
      showToast(t('quickCapture.savedToast'));
      focusCaptureTextarea();
    } catch (saveError) {
      console.error('[App] Failed to save note', saveError);
      setErrorMessage(saveError instanceof Error ? saveError.message : t('errors.saveFailed'));
    } finally {
      setBusyAction(null);
    }
  }, [captureBody, captureTitle, focusCaptureTextarea, showToast, t]);

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
    showToast(t('quickCapture.voiceSavedToast'));
  }, [showToast, t]);

  const handleRefreshNotes = useCallback(async () => {
    setBusyAction('refresh-notes');
    setErrorMessage(null);
    try {
      const refreshed = await loadNotes();
      showToast(t('history.loadedToast', { count: refreshed.length }));
    } catch (loadError) {
      setErrorMessage(loadError instanceof Error ? loadError.message : t('errors.refreshFailed'));
    } finally {
      setBusyAction(null);
    }
  }, [loadNotes, showToast, t]);

  const handleRebuildIndex = useCallback(async () => {
    setBusyAction('rebuild-index');
    setErrorMessage(null);

    try {
      const index = await window.api.vault.rebuildIndex();
      await loadNotes();
      if (index) {
        showToast(t('history.indexRebuiltToast', { count: index.notes.length }));
      } else {
        showToast(t('history.indexRebuiltFallbackToast'));
      }
    } catch (rebuildError) {
      setErrorMessage(rebuildError instanceof Error ? rebuildError.message : t('errors.rebuildFailed'));
    } finally {
      setBusyAction(null);
    }
  }, [loadNotes, showToast, t]);

  const handleDeleteNote = useCallback((noteId: string) => {
    void (async () => {
      setBusyAction('delete-note');
      setErrorMessage(null);
      try {
        const deleted = await window.api.vault.deleteNote(noteId);
        if (!deleted) {
          throw new Error(t('errors.deleteFailed'));
        }

        const updated = notes.filter((note) => note.id !== noteId);
        setNotes(updated);
        setSelectedNoteId((current) => {
          if (current !== noteId) {
            return current;
          }
          return updated[0]?.id ?? null;
        });
        showToast(t('history.noteDeletedToast'));
      } catch (deleteError) {
        setErrorMessage(deleteError instanceof Error ? deleteError.message : t('errors.deleteFailed'));
      } finally {
        setBusyAction(null);
      }
    })();
  }, [notes, showToast, t]);

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
      showToast(t('settings.storage.reselectFolder'));
    } catch (changeError) {
      setErrorMessage(changeError instanceof Error ? changeError.message : t('errors.changeVaultFailed'));
    } finally {
      setBusyAction(null);
    }
  }, [loadNotes, refreshExperimentalSync, runSyncHealthCheck, showToast, t]);

  const handleCopyVaultPath = useCallback(async () => {
    if (!vaultPath) {
      return;
    }

    try {
      await navigator.clipboard.writeText(vaultPath);
      showToast(t('settings.storage.copyPathToast'));
    } catch (copyError) {
      setErrorMessage(copyError instanceof Error ? copyError.message : t('errors.clipboardFailed'));
    }
  }, [showToast, t, vaultPath]);

  const handleExport = useCallback(async () => {
    setBusyAction('export');
    setErrorMessage(null);

    try {
      const filePath = await window.api.exportData.create();
      if (filePath) {
        showToast(t('settings.data.exportToast', { path: filePath }));
      }
    } catch (exportError) {
      setErrorMessage(exportError instanceof Error ? exportError.message : t('errors.exportFailed'));
    } finally {
      setBusyAction(null);
    }
  }, [showToast, t]);

  const handleImport = useCallback(async () => {
    setBusyAction('import');
    setErrorMessage(null);

    try {
      const result = await window.api.importData.fromZip({ mode: importMode });
      if (result) {
        await loadNotes();
        await refreshExperimentalSync();
        showToast(t('settings.data.importToast', { count: result.importedEvents }));
      }
    } catch (importError) {
      setErrorMessage(importError instanceof Error ? importError.message : t('errors.importFailed'));
    } finally {
      setBusyAction(null);
    }
  }, [importMode, loadNotes, refreshExperimentalSync, showToast, t]);

  const handleDiagnosticsCopy = useCallback(async () => {
    setBusyAction('diagnostics-copy');
    setErrorMessage(null);

    try {
      const summary = await window.api.diagnostics.getSummary();
      await navigator.clipboard.writeText(summary);
      showToast(t('settings.data.copyDiagnosticsToast'));
    } catch (diagError) {
      setErrorMessage(diagError instanceof Error ? diagError.message : t('errors.copyDiagnosticsFailed'));
    } finally {
      setBusyAction(null);
    }
  }, [showToast, t]);

  const handleDiagnosticsExport = useCallback(async () => {
    setBusyAction('diagnostics-export');
    setErrorMessage(null);

    try {
      const filePath = await window.api.diagnostics.export();
      if (filePath) {
        showToast(t('settings.data.exportDiagnosticsToast', { path: filePath }));
      }
    } catch (diagError) {
      setErrorMessage(diagError instanceof Error ? diagError.message : t('errors.exportDiagnosticsFailed'));
    } finally {
      setBusyAction(null);
    }
  }, [showToast, t]);

  const handleDevSignIn = useCallback(async () => {
    setBusyAction('experimental-signin');
    setErrorMessage(null);

    try {
      if (!signInForm.serverUrl.trim()) {
        throw new Error(t('errors.invalidDevServer'));
      }

      await window.api.auth.devSignIn({
        serverUrl: signInForm.serverUrl,
        userId: signInForm.userId,
        workspaceId: signInForm.workspaceId,
      });
      await refreshExperimentalSync();
      showToast(t('settings.experimental.signInToast'));
    } catch (signInError) {
      setErrorMessage(signInError instanceof Error ? signInError.message : t('errors.devSignInFailed'));
    } finally {
      setBusyAction(null);
    }
  }, [refreshExperimentalSync, showToast, signInForm.serverUrl, signInForm.userId, signInForm.workspaceId, t]);

  const handleDevSignOut = useCallback(async () => {
    setBusyAction('experimental-signout');
    setErrorMessage(null);

    try {
      await window.api.auth.signOut();
      await refreshExperimentalSync();
      showToast(t('settings.experimental.signOutToast'));
    } catch (signOutError) {
      setErrorMessage(signOutError instanceof Error ? signOutError.message : t('errors.devSignOutFailed'));
    } finally {
      setBusyAction(null);
    }
  }, [refreshExperimentalSync, showToast, t]);

  const handleExperimentalSyncNow = useCallback(async () => {
    setBusyAction('experimental-sync');
    setErrorMessage(null);

    try {
      const status = await window.api.sync.now();
      setSyncStatus(status);
      showToast(t('settings.experimental.syncToast'));
    } catch (syncError) {
      setErrorMessage(syncError instanceof Error ? syncError.message : t('errors.experimentalSyncFailed'));
    } finally {
      setBusyAction(null);
    }
  }, [showToast, t]);

  const handleThemeModeChange = useCallback(async (themeMode: ThemeMode) => {
    try {
      const nextPreferences = await window.api.preferences.setThemeMode(themeMode);
      setPreferences(nextPreferences);
      applyThemeMode(nextPreferences.themeMode);
    } catch (themeError) {
      setErrorMessage(themeError instanceof Error ? themeError.message : t('errors.initializationFailed'));
    }
  }, [t]);

  const handleLanguageChange = useCallback(async (language: AppLanguage) => {
    try {
      const nextPreferences = await window.api.preferences.setLanguage(language);
      setPreferences(nextPreferences);
      await i18n.changeLanguage(nextPreferences.language);
      localStorage.setItem(LANGUAGE_CACHE_KEY, nextPreferences.language);
    } catch (languageError) {
      setErrorMessage(languageError instanceof Error ? languageError.message : t('errors.initializationFailed'));
    }
  }, [t]);

  const handleExperimentalFeaturesToggle = useCallback(async (enabled: boolean) => {
    try {
      const nextPreferences = await window.api.preferences.setExperimentalFeaturesEnabled(enabled);
      setPreferences(nextPreferences);
    } catch (toggleError) {
      setErrorMessage(toggleError instanceof Error ? toggleError.message : t('errors.initializationFailed'));
    }
  }, [t]);

  const recentNotes = useMemo(() => notes.slice(0, 5), [notes]);
  const pastNotesResults = useMemo(() => filterNotes(notes, pastNotesQuery), [notes, pastNotesQuery]);
  const organizeResults = useMemo(() => filterNotes(notes, organizeQuery), [notes, organizeQuery]);

  const selectedNote = useMemo(
    () => notes.find((note) => note.id === selectedNoteId) || null,
    [notes, selectedNoteId],
  );

  const syncSummary = useMemo(() => {
    if (!syncStatus) {
      return t('sync.noStatus');
    }

    return [
      t('sync.lastSuccess', { value: formatTimestamp(syncStatus.lastSuccessAtMs, t('common.never')) }),
      t('sync.pendingEvents', { count: syncStatus.pendingEvents }),
      t('sync.pendingBlobs', { count: syncStatus.pendingBlobs }),
      t('sync.cursor', { pulled: syncStatus.lastPulledSeq, applied: syncStatus.lastAppliedSeq }),
      syncStatus.lastError
        ? t('sync.lastError', { message: syncStatus.lastError.message, code: syncStatus.lastError.code })
        : t('sync.lastErrorNone'),
    ].join(' · ');
  }, [syncStatus, t]);

  const settingsTabs = useMemo<Array<{ id: SettingsTab; label: string }>>(() => {
    const tabs: Array<{ id: SettingsTab; label: string }> = [
      { id: 'storage', label: t('settings.tabs.storage') },
      { id: 'data', label: t('settings.tabs.data') },
      { id: 'appearance', label: t('settings.tabs.appearance') },
      { id: 'voice-ai', label: t('settings.tabs.voiceAi') },
    ];

    if (preferences.experimentalFeaturesEnabled) {
      tabs.push({ id: 'experimental', label: t('settings.tabs.experimental') });
    }

    return tabs;
  }, [preferences.experimentalFeaturesEnabled, t]);

  const syncHealthStatusLabel = useMemo(() => {
    if (!syncHealthReport) {
      return t('settings.storage.syncHealth.statusWarning');
    }
    return syncHealthReport.status === 'ok'
      ? t('settings.storage.syncHealth.statusOk')
      : t('settings.storage.syncHealth.statusWarning');
  }, [syncHealthReport, t]);

  if (appState === 'loading' || !authLoaded) {
    return (
      <div className="app-loading">
        <div className="loading-spinner" />
        <p>{t('app.loading')}</p>
      </div>
    );
  }

  if (appState === 'setup') {
    return <VaultSetup onVaultSelected={handleVaultSelected} />;
  }

  return (
    <div className="app">
      <header className="header">
        <h1>{t('app.title')}</h1>
        <div className="header-right">
          <label className="header-lang-picker">
            <select
              className="settings-input"
              value={preferences.language}
              onChange={(event) => {
                void handleLanguageChange(event.target.value as AppLanguage);
              }}
            >
              <option value="en">EN</option>
              <option value="zh-Hant">繁中</option>
            </select>
          </label>
          {pingResult && <span className="ping-status">{t('app.ipcOk')}</span>}
          {vaultPath && <span className="vault-status" title={vaultPath}>{t('app.vaultReady')}</span>}
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
              <span className="sidebar-nav-label">{t(item.labelKey)}</span>
            </button>
          ))}
        </aside>

        <main className="workspace-main">
          {activePage === 'quick-capture' && (
            <section className="capture-page">
              <header className="page-header">
                <h2>{t('quickCapture.title')}</h2>
                <p>{t('quickCapture.subtitle')}</p>
              </header>

              <div className="capture-page-card">
                <input
                  className="capture-title-input"
                  value={captureTitle}
                  onChange={(event) => setCaptureTitle(event.target.value)}
                  placeholder={t('quickCapture.optionalTitle')}
                  disabled={busyAction === 'save-capture'}
                />
                <textarea
                  ref={captureTextareaRef}
                  className="capture-textarea"
                  value={captureBody}
                  onChange={(event) => setCaptureBody(event.target.value)}
                  onKeyDown={handleCaptureKeyDown}
                  placeholder={t('quickCapture.placeholder')}
                  disabled={busyAction === 'save-capture'}
                />
                <div className="capture-toolbar">
                  <button
                    className="save-button"
                    onClick={() => { void handleSaveCapture(); }}
                    disabled={busyAction === 'save-capture' || !captureBody.trim()}
                  >
                    {busyAction === 'save-capture' ? t('quickCapture.saving') : t('quickCapture.save')}
                  </button>
                  <span className="capture-shortcut-hint">{t('quickCapture.shortcut')}</span>
                  <span className="capture-shortcut-hint">{t('quickCapture.focusShortcut')}</span>
                </div>
              </div>

              <div className="capture-voice-card">
                <h3>{t('quickCapture.voiceTitle')}</h3>
                <VoiceRecorder onRecordingComplete={handleVoiceSaved} />
              </div>

              <div className="recent-strip">
                <div className="recent-strip-header">{t('quickCapture.recent')}</div>
                {recentNotes.length === 0 ? (
                  <p className="recent-empty">{t('quickCapture.noRecent')}</p>
                ) : (
                  <div className="recent-strip-items">
                    {recentNotes.map((note) => (
                      <button
                        key={note.id}
                        className="recent-chip"
                        onClick={() => {
                          setSelectedNoteId(note.id);
                          setActivePage('past-notes');
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

          {activePage === 'past-notes' && (
            <section className="page-section">
              <header className="page-header-row">
                <h2>{t('history.title')}</h2>
                <div className="page-actions">
                  <button
                    className="save-button"
                    onClick={() => { void handleRefreshNotes(); }}
                    disabled={busyAction === 'refresh-notes'}
                  >
                    {t('common.refresh')}
                  </button>
                  <button
                    className="save-button"
                    onClick={() => { void handleRebuildIndex(); }}
                    disabled={busyAction === 'rebuild-index'}
                  >
                    {t('common.rebuildIndex')}
                  </button>
                </div>
              </header>

              <div className="page-search-row">
                <input
                  className="settings-input"
                  value={pastNotesQuery}
                  onChange={(event) => setPastNotesQuery(event.target.value)}
                  placeholder={t('history.searchPlaceholder')}
                />
              </div>

              <div className="main-split history-split">
                <aside className="panel-left">
                  <NotesList
                    notes={pastNotesResults}
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
                <h2>{t('organize.title')}</h2>
              </header>

              <div className="page-search-row">
                <input
                  className="settings-input"
                  value={organizeQuery}
                  onChange={(event) => setOrganizeQuery(event.target.value)}
                  placeholder={t('organize.searchPlaceholder')}
                />
              </div>

              <div className="organize-grid">
                <div className="organize-panel">
                  <h3>{t('organize.matchingNotes')}</h3>
                  {organizeResults.length === 0 ? (
                    <p className="recent-empty">{t('organize.noMatches')}</p>
                  ) : (
                    <ul className="organize-results-list">
                      {organizeResults.slice(0, 20).map((note) => (
                        <li key={note.id}>
                          <button
                            className="organize-result-button"
                            onClick={() => {
                              setSelectedNoteId(note.id);
                              setActivePage('past-notes');
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
                  <h3>{t('organize.suggestedActions')}</h3>
                  <ul className="organize-actions-list">
                    <li>{t('organize.action1')}</li>
                    <li>{t('organize.action2')}</li>
                    <li>{t('organize.action3')}</li>
                    <li>{t('organize.action4')}</li>
                  </ul>
                </div>
              </div>
            </section>
          )}

          {activePage === 'voice-ai' && (
            <section className="page-section">
              <header className="page-header-row">
                <h2>{t('voiceAi.title')}</h2>
              </header>
              <AISettings onClose={() => setActivePage('quick-capture')} embedded />
            </section>
          )}

          {activePage === 'settings' && (
            <section className="page-section">
              <header className="page-header-row">
                <h2>{t('settings.title')}</h2>
              </header>

              <div className="settings-tab-row" role="tablist" aria-label={t('settings.title')}>
                {settingsTabs.map((tab) => (
                  <button
                    key={tab.id}
                    className={`settings-tab-button ${settingsTab === tab.id ? 'active' : ''}`}
                    onClick={() => setSettingsTab(tab.id)}
                    role="tab"
                    aria-selected={settingsTab === tab.id}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>

              <div className="settings-stack">
                {settingsTab === 'storage' && (
                  <section className="settings-card">
                    <h3>{t('settings.storage.title')}</h3>
                    <p className="settings-card-note">{t('settings.storage.description')}</p>

                    <div className="storage-mode-chooser" role="group" aria-label={t('settings.storage.title')}>
                      <button
                        className={`storage-mode-option ${storageSyncMode === 'local-folder' ? 'active' : ''}`}
                        onClick={() => setStorageSyncMode('local-folder')}
                      >
                        <span className="storage-mode-title">{t('settings.storage.modes.local.title')}</span>
                        <span className="storage-mode-meta">{t('settings.storage.modes.local.meta')}</span>
                      </button>

                      <button className="storage-mode-option disabled" disabled title={t('settings.storage.modes.cloud.meta')}>
                        <span className="storage-mode-title">{t('settings.storage.modes.cloud.title')}</span>
                        <span className="storage-mode-meta">{t('settings.storage.modes.cloud.meta')}</span>
                      </button>

                      {preferences.experimentalFeaturesEnabled && (
                        <button
                          className={`storage-mode-option ${storageSyncMode === 'self-hosted' ? 'active' : ''}`}
                          onClick={() => setStorageSyncMode('self-hosted')}
                        >
                          <span className="storage-mode-title">{t('settings.storage.modes.selfHosted.title')}</span>
                          <span className="storage-mode-meta">{t('settings.storage.modes.selfHosted.meta')}</span>
                        </button>
                      )}
                    </div>

                    {storageSyncMode === 'local-folder' && (
                      <div className="storage-mode-panel">
                        <p className="settings-card-note">{t('settings.storage.localGuidance')}</p>

                        <div className="storage-path-row">
                          <p className="settings-card-path">{vaultPath || t('settings.storage.vaultMissing')}</p>
                          <button className="save-button" onClick={() => { void handleCopyVaultPath(); }} disabled={!vaultPath}>
                            {t('settings.storage.copyPath')}
                          </button>
                        </div>

                        <div className="settings-card-actions">
                          <button
                            className="save-button"
                            onClick={() => { void handleChangeVaultFolder(); }}
                            disabled={busyAction === 'change-vault'}
                          >
                            {t('settings.storage.reselectFolder')}
                          </button>
                          <button
                            className="save-button"
                            onClick={() => { void handleRefreshNotes(); }}
                            disabled={busyAction === 'refresh-notes'}
                          >
                            {t('common.refresh')}
                          </button>
                          <button
                            className="save-button"
                            onClick={() => { void handleRebuildIndex(); }}
                            disabled={busyAction === 'rebuild-index'}
                          >
                            {t('common.rebuildIndex')}
                          </button>
                        </div>

                        <div className="sync-health-panel">
                          <div className="sync-health-header">
                            <h4>{t('settings.storage.syncHealth.title')}</h4>
                            <span className={`sync-health-badge ${syncHealthReport?.status === 'ok' ? 'ok' : 'warning'}`}>
                              {syncHealthStatusLabel}
                            </span>
                          </div>
                          <button
                            className="save-button"
                            onClick={() => { void runSyncHealthCheck(); }}
                            disabled={busyAction === 'sync-health-check'}
                          >
                            {busyAction === 'sync-health-check' ? t('settings.storage.syncHealth.running') : t('settings.storage.syncHealth.run')}
                          </button>

                          {syncHealthReport && (
                            <div className="sync-health-details">
                              <p>
                                {syncHealthReport.looksLikeCloudFolder
                                  ? t('settings.storage.syncHealth.heuristicDetected')
                                  : t('settings.storage.syncHealth.heuristicNotDetected')}
                                {syncHealthReport.detectedProviders.length > 0 && (
                                  <> ({syncHealthReport.detectedProviders.join(', ')})</>
                                )}
                              </p>
                              <p>{t('settings.storage.syncHealth.conflictFiles', { count: syncHealthReport.conflictFiles.length })}</p>

                              {syncHealthReport.conflictFiles.length > 0 && (
                                <ul className="sync-health-conflicts">
                                  {syncHealthReport.conflictFiles.slice(0, 8).map((conflictPath) => (
                                    <li key={conflictPath}>{conflictPath}</li>
                                  ))}
                                </ul>
                              )}

                              <div>
                                <strong>{t('settings.storage.syncHealth.recommendations')}</strong>
                                <ul className="sync-health-recommendations">
                                  {syncHealthReport.recommendations.map((recommendation) => (
                                    <li key={recommendation}>{recommendation}</li>
                                  ))}
                                </ul>
                              </div>
                            </div>
                          )}
                        </div>
                      </div>
                    )}

                    {storageSyncMode === 'cloud-provider' && (
                      <p className="settings-card-note">{t('settings.storage.cloudModeHint')}</p>
                    )}

                    {storageSyncMode === 'self-hosted' && preferences.experimentalFeaturesEnabled && (
                      <p className="settings-card-note">{t('settings.storage.selfHostedHint')}</p>
                    )}
                  </section>
                )}

                {settingsTab === 'data' && (
                  <section className="settings-card">
                    <h3>{t('settings.data.title')}</h3>
                    <p className="settings-card-note">{t('settings.data.description')}</p>
                    <div className="settings-card-actions">
                      <button className="save-button" onClick={() => { void handleExport(); }} disabled={busyAction === 'export'}>
                        {t('settings.data.exportZip')}
                      </button>

                      <label className="settings-inline-label" htmlFor="import-mode-select">
                        {t('settings.data.importMode')}
                        <select
                          id="import-mode-select"
                          value={importMode}
                          onChange={(event) => setImportMode(event.target.value as 'restore' | 'clone')}
                          disabled={busyAction === 'import'}
                        >
                          <option value="restore">{t('settings.data.restoreMode')}</option>
                          <option value="clone">{t('settings.data.cloneMode')}</option>
                        </select>
                      </label>

                      <button className="save-button" onClick={() => { void handleImport(); }} disabled={busyAction === 'import'}>
                        {busyAction === 'import' ? t('settings.data.importing') : t('settings.data.importRestoreZip')}
                      </button>
                      <button className="save-button" onClick={() => { void handleDiagnosticsCopy(); }} disabled={busyAction === 'diagnostics-copy'}>
                        {t('settings.data.copyDiagnostics')}
                      </button>
                      <button className="save-button" onClick={() => { void handleDiagnosticsExport(); }} disabled={busyAction === 'diagnostics-export'}>
                        {t('settings.data.exportDiagnostics')}
                      </button>
                    </div>
                  </section>
                )}

                {settingsTab === 'appearance' && (
                  <section className="settings-card">
                    <h3>{t('settings.appearance.title')}</h3>
                    <p className="settings-card-note">{t('settings.appearance.description')}</p>

                    <div className="appearance-grid">
                      <label className="settings-label" htmlFor="theme-mode-select">
                        {t('settings.appearance.themeLabel')}
                      </label>
                      <select
                        id="theme-mode-select"
                        className="settings-input"
                        value={preferences.themeMode}
                        onChange={(event) => {
                          void handleThemeModeChange(event.target.value as ThemeMode);
                        }}
                      >
                        <option value="system">{t('settings.appearance.themeSystem')}</option>
                        <option value="dark">{t('settings.appearance.themeDark')}</option>
                        <option value="light">{t('settings.appearance.themeLight')}</option>
                      </select>

                      <label className="settings-label" htmlFor="language-select">
                        {t('settings.appearance.languageLabel')}
                      </label>
                      <select
                        id="language-select"
                        className="settings-input"
                        value={preferences.language}
                        onChange={(event) => {
                          void handleLanguageChange(event.target.value as AppLanguage);
                        }}
                      >
                        <option value="en">{t('settings.appearance.languageEnglish')}</option>
                        <option value="zh-Hant">{t('settings.appearance.languageTraditionalChinese')}</option>
                      </select>
                    </div>

                    <label className="settings-checkbox-row" htmlFor="experimental-toggle">
                      <input
                        id="experimental-toggle"
                        type="checkbox"
                        checked={preferences.experimentalFeaturesEnabled}
                        onChange={(event) => {
                          void handleExperimentalFeaturesToggle(event.target.checked);
                        }}
                      />
                      <span>{t('settings.appearance.experimentalToggle')}</span>
                    </label>
                  </section>
                )}

                {settingsTab === 'voice-ai' && (
                  <section className="settings-card">
                    <h3>{t('settings.voiceAi.title')}</h3>
                    <p className="settings-card-note">{t('settings.voiceAi.description')}</p>
                    <button
                      className="save-button"
                      onClick={() => {
                        setActivePage('voice-ai');
                      }}
                    >
                      {t('settings.voiceAi.open')}
                    </button>
                  </section>
                )}

                {settingsTab === 'experimental' && preferences.experimentalFeaturesEnabled && (
                  <section className="settings-card">
                    <h3>{t('settings.tabs.experimental')}</h3>
                    <p className="settings-card-note">{t('settings.experimental.summary')}</p>

                    <div className="experimental-grid">
                      <input
                        className="settings-input"
                        value={signInForm.serverUrl}
                        onChange={(event) => setSignInForm((previous) => ({ ...previous, serverUrl: event.target.value }))}
                        placeholder={t('settings.experimental.serverUrl')}
                      />
                      <input
                        className="settings-input"
                        value={signInForm.userId}
                        onChange={(event) => setSignInForm((previous) => ({ ...previous, userId: event.target.value }))}
                        placeholder={t('settings.experimental.userId')}
                      />
                      <input
                        className="settings-input"
                        value={signInForm.workspaceId}
                        onChange={(event) => setSignInForm((previous) => ({ ...previous, workspaceId: event.target.value }))}
                        placeholder={t('settings.experimental.workspaceId')}
                      />
                    </div>

                    <div className="settings-card-actions">
                      <button className="save-button" onClick={() => { void handleDevSignIn(); }} disabled={busyAction === 'experimental-signin'}>
                        {busyAction === 'experimental-signin' ? t('settings.experimental.signingIn') : t('settings.experimental.devSignIn')}
                      </button>
                      <button className="save-button" onClick={() => { void handleDevSignOut(); }} disabled={busyAction === 'experimental-signout' || !authConfig}>
                        {t('settings.experimental.signOut')}
                      </button>
                      <button className="save-button" onClick={() => { void handleExperimentalSyncNow(); }} disabled={busyAction === 'experimental-sync' || !authConfig}>
                        {busyAction === 'experimental-sync' ? t('settings.experimental.syncing') : t('settings.experimental.syncNow')}
                      </button>
                    </div>

                    <p className="experimental-status">{syncSummary}</p>
                  </section>
                )}
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
