import React from 'react';
import type { Note } from '../global';

interface NotesListProps {
    notes: Note[];
    selectedNoteId: string | null;
    onSelectNote: (note: Note) => void;
}

/**
 * Notes list component - displays all notes in a scrollable list
 */
export function NotesList({ notes, selectedNoteId, onSelectNote }: NotesListProps): React.ReactElement {
    const formatDate = (dateStr: string): string => {
        const date = new Date(dateStr);
        const now = new Date();
        const diffMs = now.getTime() - date.getTime();
        const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

        if (diffDays === 0) {
            return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        } else if (diffDays === 1) {
            return 'Yesterday';
        } else if (diffDays < 7) {
            return date.toLocaleDateString([], { weekday: 'short' });
        } else {
            return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
        }
    };

    if (notes.length === 0) {
        return (
            <div className="notes-list-empty">
                <p>No notes yet</p>
                <p className="hint">Create your first note above</p>
            </div>
        );
    }

    return (
        <ul className="notes-list">
            {notes.map((note) => (
                <li
                    key={note.id}
                    className={`notes-list-item ${selectedNoteId === note.id ? 'selected' : ''}`}
                    onClick={() => onSelectNote(note)}
                >
                    <div className="notes-list-item-title">{note.title}</div>
                    <div className="notes-list-item-meta">
                        <span className="notes-list-item-id">{note.id}</span>
                        <span className="notes-list-item-date">{formatDate(note.updatedAt)}</span>
                    </div>
                    <div className="notes-list-item-preview">
                        {note.content.slice(0, 80)}
                        {note.content.length > 80 ? '...' : ''}
                    </div>
                </li>
            ))}
        </ul>
    );
}

export default NotesList;
