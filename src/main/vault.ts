/**
 * Vault service for World-Seed
 * Handles file-based note storage with YAML frontmatter
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import matter from 'gray-matter';
import { v4 as uuidv4 } from 'uuid';

// ============================================================================
// Types
// ============================================================================

export interface Note {
    id: string;
    title: string;
    content: string;
    createdAt: string;
    updatedAt: string;
}

export interface NoteInput {
    title?: string;
    content: string;
}

export interface NoteIndex {
    notes: NoteIndexEntry[];
    lastRebuilt: string;
}

export interface NoteIndexEntry {
    id: string;
    title: string;
    createdAt: string;
    updatedAt: string;
}

// ============================================================================
// Vault Structure
// ============================================================================

const NOTES_DIR = 'notes';

/**
 * Ensure vault directory structure exists
 */
export function ensureVaultStructure(vaultPath: string): void {
    const notesDir = path.join(vaultPath, NOTES_DIR);

    if (!fs.existsSync(vaultPath)) {
        fs.mkdirSync(vaultPath, { recursive: true });
    }

    if (!fs.existsSync(notesDir)) {
        fs.mkdirSync(notesDir, { recursive: true });
    }
}

/**
 * Check if vault path is valid and accessible
 */
export function isValidVault(vaultPath: string): boolean {
    try {
        const notesDir = path.join(vaultPath, NOTES_DIR);
        // Check if we can access the directory
        fs.accessSync(vaultPath, fs.constants.R_OK | fs.constants.W_OK);
        return fs.existsSync(notesDir);
    } catch {
        return false;
    }
}

// ============================================================================
// Note Operations
// ============================================================================

/**
 * Generate a new note ID
 */
export function generateNoteId(): string {
    // Format: n_<short-uuid>
    return `n_${uuidv4().split('-')[0]}`;
}

/**
 * Get the file path for a note
 */
function getNoteFilePath(vaultPath: string, noteId: string): string {
    return path.join(vaultPath, NOTES_DIR, `${noteId}.md`);
}

/**
 * Extract title from content (first line or first N chars)
 */
function extractTitle(content: string): string {
    const firstLine = content.split('\n')[0].trim();
    if (firstLine.length > 0) {
        // Remove markdown heading prefix if present
        const cleaned = firstLine.replace(/^#+\s*/, '');
        return cleaned.slice(0, 100);
    }
    return content.slice(0, 50).trim() || 'Untitled';
}

/**
 * Save a note to the vault
 */
export function saveNote(vaultPath: string, input: NoteInput, existingId?: string): Note {
    ensureVaultStructure(vaultPath);

    const now = new Date().toISOString();
    const id = existingId || generateNoteId();
    const title = input.title || extractTitle(input.content);

    // Check if note exists (for update)
    const filePath = getNoteFilePath(vaultPath, id);
    let createdAt = now;

    if (fs.existsSync(filePath)) {
        // Preserve original createdAt
        const existing = loadNote(vaultPath, id);
        if (existing) {
            createdAt = existing.createdAt;
        }
    }

    const note: Note = {
        id,
        title,
        content: input.content,
        createdAt,
        updatedAt: now,
    };

    // Create file with YAML frontmatter
    const fileContent = matter.stringify(note.content, {
        id: note.id,
        title: note.title,
        createdAt: note.createdAt,
        updatedAt: note.updatedAt,
    });

    fs.writeFileSync(filePath, fileContent, 'utf-8');

    return note;
}

/**
 * Load a single note by ID
 */
export function loadNote(vaultPath: string, noteId: string): Note | null {
    const filePath = getNoteFilePath(vaultPath, noteId);

    if (!fs.existsSync(filePath)) {
        return null;
    }

    try {
        const fileContent = fs.readFileSync(filePath, 'utf-8');
        const { data, content } = matter(fileContent);

        return {
            id: data.id || noteId,
            title: data.title || extractTitle(content),
            content: content.trim(),
            createdAt: data.createdAt || new Date().toISOString(),
            updatedAt: data.updatedAt || new Date().toISOString(),
        };
    } catch (error) {
        console.error(`Failed to load note ${noteId}:`, error);
        return null;
    }
}

/**
 * Load all notes from the vault
 */
export function loadAllNotes(vaultPath: string): Note[] {
    const notesDir = path.join(vaultPath, NOTES_DIR);

    if (!fs.existsSync(notesDir)) {
        return [];
    }

    const files = fs.readdirSync(notesDir).filter(f => f.endsWith('.md'));
    const notes: Note[] = [];

    for (const file of files) {
        const noteId = file.replace('.md', '');
        const note = loadNote(vaultPath, noteId);
        if (note) {
            notes.push(note);
        }
    }

    // Sort by updatedAt descending (newest first)
    notes.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

    return notes;
}

/**
 * Delete a note from the vault
 */
export function deleteNote(vaultPath: string, noteId: string): boolean {
    const filePath = getNoteFilePath(vaultPath, noteId);

    if (!fs.existsSync(filePath)) {
        return false;
    }

    try {
        fs.unlinkSync(filePath);
        return true;
    } catch (error) {
        console.error(`Failed to delete note ${noteId}:`, error);
        return false;
    }
}

// ============================================================================
// Index Operations (Rebuildable)
// ============================================================================

/**
 * Rebuild the local index from filesystem
 * This is stored locally and can be regenerated anytime
 */
export function rebuildIndex(vaultPath: string): NoteIndex {
    const notes = loadAllNotes(vaultPath);

    const index: NoteIndex = {
        notes: notes.map(n => ({
            id: n.id,
            title: n.title,
            createdAt: n.createdAt,
            updatedAt: n.updatedAt,
        })),
        lastRebuilt: new Date().toISOString(),
    };

    return index;
}
