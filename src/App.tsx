import React, { useState, useEffect, useCallback } from 'react';
import type { Note, NoteInput } from './global';
import { VaultSetup } from './components/VaultSetup';
import { NotesList } from './components/NotesList';
import { NoteViewer } from './components/NoteViewer';
import { Settings } from './components/Settings';

type AppState = 'loading' | 'setup' | 'ready';

/**
 * Main World-Seed App component
 * Handles vault setup, note capture, and display
 */
export function App(): React.ReactElement {
    // App state
    const [appState, setAppState] = useState<AppState>('loading');
    const [vaultPath, setVaultPath] = useState<string | null>(null);
    const [showSettings, setShowSettings] = useState(false);

    // Notes state
    const [notes, setNotes] = useState<Note[]>([]);
    const [selectedNote, setSelectedNote] = useState<Note | null>(null);

    // Input state
    const [noteText, setNoteText] = useState('');
    const [isSaving, setIsSaving] = useState(false);

    // IPC status
    const [pingResult, setPingResult] = useState<string | null>(null);

    // ============================================================================
    // Initialization
    // ============================================================================

    useEffect(() => {
        const init = async () => {
            // Test IPC
            try {
                const result = await window.api.ping();
                setPingResult(result);
            } catch (err) {
                console.error('[App] Ping failed:', err);
            }

            // Check for existing vault
            try {
                const path = await window.api.vault.getPath();
                if (path) {
                    setVaultPath(path);
                    setAppState('ready');
                    // Load notes
                    const loadedNotes = await window.api.vault.loadNotes();
                    setNotes(loadedNotes);
                } else {
                    setAppState('setup');
                }
            } catch (err) {
                console.error('[App] Failed to check vault:', err);
                setAppState('setup');
            }
        };

        init();
    }, []);

    // ============================================================================
    // Handlers
    // ============================================================================

    const handleVaultSelected = useCallback(async (path: string) => {
        setVaultPath(path);
        setAppState('ready');
        // Load any existing notes
        const loadedNotes = await window.api.vault.loadNotes();
        setNotes(loadedNotes);
    }, []);

    const handleSave = useCallback(async () => {
        if (!noteText.trim() || isSaving) return;

        setIsSaving(true);
        try {
            const input: NoteInput = { content: noteText.trim() };
            const savedNote = await window.api.vault.saveNote(input);

            // Add to notes list (at the beginning)
            setNotes(prev => [savedNote, ...prev.filter(n => n.id !== savedNote.id)]);
            setNoteText('');
            setSelectedNote(savedNote);

            console.log(`[App] Saved note: ${savedNote.id}`);
        } catch (err) {
            console.error('[App] Failed to save note:', err);
            alert('Failed to save note. Please try again.');
        } finally {
            setIsSaving(false);
        }
    }, [noteText, isSaving]);

    const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        // Ctrl+Enter or Cmd+Enter to save
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
            e.preventDefault();
            handleSave();
        }
    }, [handleSave]);

    const handleSelectNote = useCallback((note: Note) => {
        setSelectedNote(note);
    }, []);

    const handleDeleteNote = useCallback(async (noteId: string) => {
        try {
            const result = await window.api.vault.deleteNote(noteId);
            if (result) {
                setNotes(prev => prev.filter(n => n.id !== noteId));
                if (selectedNote?.id === noteId) {
                    setSelectedNote(null);
                }
            }
        } catch (err) {
            console.error('[App] Failed to delete note:', err);
            alert('Failed to delete note. Please try again.');
        }
    }, [selectedNote]);

    // ============================================================================
    // Render
    // ============================================================================

    // Loading state
    if (appState === 'loading') {
        return (
            <div className="app-loading">
                <div className="loading-spinner" />
                <p>Loading...</p>
            </div>
        );
    }

    // Setup state - show vault folder selection
    if (appState === 'setup') {
        return <VaultSetup onVaultSelected={handleVaultSelected} />;
    }

    // Ready state - show main UI
    return (
        <div className="app">
            {/* Settings Modal */}
            {showSettings && (
                <Settings onClose={() => setShowSettings(false)} />
            )}

            {/* Header */}
            <header className="header">
                <h1>📥 Inbox</h1>
                <div className="header-right">
                    {pingResult && (
                        <span className="ping-status" title="IPC working">
                            ✓ IPC
                        </span>
                    )}
                    {vaultPath && (
                        <span className="vault-status" title={vaultPath}>
                            📁 Vault
                        </span>
                    )}
                    <button
                        className="settings-button"
                        onClick={() => setShowSettings(true)}
                        title="Settings"
                    >
                        ⚙️
                    </button>
                </div>
            </header>

            {/* Capture Section */}
            <section className="capture-section">
                <textarea
                    className="note-input"
                    placeholder="Capture an idea... (Ctrl+Enter to save)"
                    value={noteText}
                    onChange={(e) => setNoteText(e.target.value)}
                    onKeyDown={handleKeyDown}
                    disabled={isSaving}
                />
                <button
                    className="save-button"
                    onClick={handleSave}
                    disabled={!noteText.trim() || isSaving}
                >
                    {isSaving ? 'Saving...' : 'Save'}
                </button>
            </section>

            {/* Main Content - Split Layout */}
            <main className="main-split">
                {/* Left Panel - Notes List */}
                <aside className="panel-left">
                    <h2>Notes ({notes.length})</h2>
                    <NotesList
                        notes={notes}
                        selectedNoteId={selectedNote?.id ?? null}
                        onSelectNote={handleSelectNote}
                    />
                </aside>

                {/* Right Panel - Note Viewer */}
                <section className="panel-right">
                    <NoteViewer
                        note={selectedNote}
                        onDelete={handleDeleteNote}
                    />
                </section>
            </main>
        </div>
    );
}

export default App;
