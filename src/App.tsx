import React, { useState, useEffect } from 'react';

interface Note {
    id: string;
    content: string;
    createdAt: Date;
}

/**
 * Main World-Seed Inbox component
 * Ultra-fast atomic idea capture (in-memory for bootstrap)
 */
export function App(): React.ReactElement {
    const [noteText, setNoteText] = useState('');
    const [notes, setNotes] = useState<Note[]>([]);
    const [pingResult, setPingResult] = useState<string | null>(null);

    // Test IPC on mount
    useEffect(() => {
        window.api.ping().then((result) => {
            setPingResult(result);
            console.log(`[renderer] Ping result: ${result}`);
        });
    }, []);

    const handleSave = () => {
        if (!noteText.trim()) return;

        const newNote: Note = {
            id: `n_${Date.now().toString(36)}`,
            content: noteText.trim(),
            createdAt: new Date(),
        };

        setNotes((prev) => [newNote, ...prev]);
        setNoteText('');
        console.log(`[renderer] Saved note: ${newNote.id}`);
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        // Ctrl+Enter or Cmd+Enter to save
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
            e.preventDefault();
            handleSave();
        }
    };

    return (
        <div className="app">
            <header className="header">
                <h1>📥 Inbox</h1>
                {pingResult && (
                    <span className="ping-status" title="IPC working">
                        ✓ IPC: {pingResult}
                    </span>
                )}
            </header>

            <main className="main">
                <section className="capture-section">
                    <textarea
                        className="note-input"
                        placeholder="Capture an idea... (Ctrl+Enter to save)"
                        value={noteText}
                        onChange={(e) => setNoteText(e.target.value)}
                        onKeyDown={handleKeyDown}
                        autoFocus
                    />
                    <button
                        className="save-button"
                        onClick={handleSave}
                        disabled={!noteText.trim()}
                    >
                        Save
                    </button>
                </section>

                <section className="notes-section">
                    <h2>Notes ({notes.length})</h2>
                    {notes.length === 0 ? (
                        <p className="empty-state">No notes yet. Start capturing ideas!</p>
                    ) : (
                        <ul className="notes-list">
                            {notes.map((note) => (
                                <li key={note.id} className="note-card">
                                    <span className="note-id">{note.id}</span>
                                    <p className="note-content">{note.content}</p>
                                    <time className="note-time">
                                        {note.createdAt.toLocaleTimeString()}
                                    </time>
                                </li>
                            ))}
                        </ul>
                    )}
                </section>
            </main>
        </div>
    );
}

export default App;
