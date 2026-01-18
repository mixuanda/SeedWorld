import React from 'react';
import type { Note } from '../global';

interface NoteViewerProps {
    note: Note | null;
    onDelete?: (noteId: string) => void;
}

/**
 * Note viewer component - displays a single note's content and metadata
 */
export function NoteViewer({ note, onDelete }: NoteViewerProps): React.ReactElement {
    const [isDeleting, setIsDeleting] = React.useState(false);

    if (!note) {
        return (
            <div className="note-viewer-empty">
                <div className="note-viewer-empty-icon">📝</div>
                <p>Select a note to view</p>
                <p className="hint">Or create a new one above</p>
            </div>
        );
    }

    const handleDelete = async () => {
        if (!onDelete) return;

        const confirmed = window.confirm(`Delete "${note.title}"?`);
        if (!confirmed) return;

        setIsDeleting(true);
        try {
            onDelete(note.id);
        } finally {
            setIsDeleting(false);
        }
    };

    const formatDateTime = (dateStr: string): string => {
        return new Date(dateStr).toLocaleString();
    };

    return (
        <div className="note-viewer">
            <header className="note-viewer-header">
                <h2 className="note-viewer-title">{note.title}</h2>
                {onDelete && (
                    <button
                        className="note-viewer-delete"
                        onClick={handleDelete}
                        disabled={isDeleting}
                        title="Delete note"
                    >
                        🗑️
                    </button>
                )}
            </header>

            <div className="note-viewer-meta">
                <span className="note-viewer-id">{note.id}</span>
                <span className="note-viewer-dates">
                    Created: {formatDateTime(note.createdAt)}
                    {note.updatedAt !== note.createdAt && (
                        <> · Updated: {formatDateTime(note.updatedAt)}</>
                    )}
                </span>
            </div>

            <div className="note-viewer-content">
                {note.content}
            </div>
        </div>
    );
}

export default NoteViewer;
