/**
 * Vault service for World-Seed
 * Handles file-based note storage with YAML frontmatter
 * 
 * Features:
 * - Atomic writes (temp file + fsync + rename) to prevent corruption
 * - Full vault folder structure for all content types
 * - OneDrive-friendly (recreates missing subfolders safely)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
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
// Vault Directory Structure
// ============================================================================

/**
 * All vault subdirectories
 * These are recreated on startup if missing
 */
export const VAULT_DIRS = {
    notes: 'notes',
    attachmentsAudio: 'attachments/audio',
    transcripts: 'transcripts',
    changesets: 'changesets',
    structures: 'structures',
} as const;

/**
 * Ensure all vault subdirectories exist
 * Safe to call multiple times; creates missing folders
 */
export function ensureVaultStructure(vaultPath: string): void {
    // Create vault root if needed
    if (!fs.existsSync(vaultPath)) {
        fs.mkdirSync(vaultPath, { recursive: true });
    }

    // Create all subdirectories
    for (const subdir of Object.values(VAULT_DIRS)) {
        const fullPath = path.join(vaultPath, subdir);
        if (!fs.existsSync(fullPath)) {
            fs.mkdirSync(fullPath, { recursive: true });
            console.log(`[vault] Created directory: ${subdir}`);
        }
    }
}

/**
 * Check if vault path is valid and accessible
 */
export function isValidVault(vaultPath: string): boolean {
    try {
        // Check read/write access to vault root
        fs.accessSync(vaultPath, fs.constants.R_OK | fs.constants.W_OK);
        // Check notes directory exists (minimum requirement)
        const notesDir = path.join(vaultPath, VAULT_DIRS.notes);
        return fs.existsSync(notesDir);
    } catch {
        return false;
    }
}

// ============================================================================
// Atomic Write Helper
// ============================================================================

/**
 * Generate a temporary filename for atomic writes
 */
function getTempFilename(finalPath: string): string {
    const dir = path.dirname(finalPath);
    const ext = path.extname(finalPath);
    const base = path.basename(finalPath, ext);
    const random = crypto.randomBytes(4).toString('hex');
    return path.join(dir, `.${base}.${random}.tmp`);
}

/**
 * Atomically write content to a file
 * 
 * Strategy:
 * 1. Write to a temp file in the same directory
 * 2. fsync the file descriptor (best effort)
 * 3. Rename temp file to final filename (atomic on most filesystems)
 * 
 * This ensures that interrupted writes don't corrupt existing files.
 * The worst case is an orphaned .tmp file, not a corrupted .md file.
 * 
 * @param filePath - Final destination path
 * @param content - File content to write
 * @param encoding - File encoding (default: utf-8)
 */
export function atomicWriteFileSync(
    filePath: string,
    content: string,
    encoding: BufferEncoding = 'utf-8'
): void {
    const tempPath = getTempFilename(filePath);
    let fd: number | null = null;

    try {
        // Ensure parent directory exists
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        // Write to temp file
        fd = fs.openSync(tempPath, 'w');
        fs.writeSync(fd, content, null, encoding);

        // fsync to flush to disk (best effort - may not work on all systems)
        try {
            fs.fsyncSync(fd);
        } catch (fsyncError) {
            // fsync may fail on some systems/filesystems, continue anyway
            console.warn('[vault] fsync failed (non-fatal):', fsyncError);
        }

        fs.closeSync(fd);
        fd = null;

        // Atomic rename
        fs.renameSync(tempPath, filePath);
    } catch (error) {
        // Clean up temp file on error
        if (fd !== null) {
            try {
                fs.closeSync(fd);
            } catch {
                // Ignore close errors
            }
        }

        try {
            if (fs.existsSync(tempPath)) {
                fs.unlinkSync(tempPath);
            }
        } catch {
            // Ignore cleanup errors
        }

        throw error;
    }
}

/**
 * Atomically write JSON to a file
 */
export function atomicWriteJsonSync(filePath: string, data: unknown): void {
    const content = JSON.stringify(data, null, 2);
    atomicWriteFileSync(filePath, content, 'utf-8');
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
    return path.join(vaultPath, VAULT_DIRS.notes, `${noteId}.md`);
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
 * Save a note to the vault (using atomic write)
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

    // Use atomic write to prevent corruption
    atomicWriteFileSync(filePath, fileContent);

    return note;
}

/**
 * Load a single note by ID
 * Returns Note or VoiceNote (with audioPath) depending on frontmatter
 */
export function loadNote(vaultPath: string, noteId: string): Note | VoiceNote | null {
    const filePath = getNoteFilePath(vaultPath, noteId);

    if (!fs.existsSync(filePath)) {
        return null;
    }

    try {
        const fileContent = fs.readFileSync(filePath, 'utf-8');
        const { data, content } = matter(fileContent);

        const note: Note = {
            id: data.id || noteId,
            title: data.title || extractTitle(content),
            content: content.trim(),
            createdAt: data.createdAt || new Date().toISOString(),
            updatedAt: data.updatedAt || new Date().toISOString(),
        };

        // If audioPath exists, return as VoiceNote
        if (data.audioPath) {
            return {
                ...note,
                audioPath: data.audioPath,
            } as VoiceNote;
        }

        return note;
    } catch (error) {
        console.error(`[vault] Failed to load note ${noteId}:`, error);
        return null;
    }
}

/**
 * Load all notes from the vault
 */
export function loadAllNotes(vaultPath: string): Note[] {
    const notesDir = path.join(vaultPath, VAULT_DIRS.notes);

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
        console.error(`[vault] Failed to delete note ${noteId}:`, error);
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

// ============================================================================
// Utility Functions for Other Vault Content
// ============================================================================

/**
 * Get path to a specific vault subdirectory
 */
export function getVaultSubdir(vaultPath: string, subdir: keyof typeof VAULT_DIRS): string {
    return path.join(vaultPath, VAULT_DIRS[subdir]);
}

/**
 * Save a changeset JSON file (atomic)
 */
export function saveChangeset(vaultPath: string, changesetId: string, data: unknown): string {
    ensureVaultStructure(vaultPath);
    const filePath = path.join(vaultPath, VAULT_DIRS.changesets, `${changesetId}.json`);
    atomicWriteJsonSync(filePath, data);
    return filePath;
}

/**
 * Save a transcript file (atomic)
 */
export function saveTranscript(vaultPath: string, transcriptId: string, content: string): string {
    ensureVaultStructure(vaultPath);
    const filePath = path.join(vaultPath, VAULT_DIRS.transcripts, `${transcriptId}.md`);
    atomicWriteFileSync(filePath, content);
    return filePath;
}

/**
 * Save a structure document (atomic)
 */
export function saveStructure(vaultPath: string, structureId: string, content: string): string {
    ensureVaultStructure(vaultPath);
    const filePath = path.join(vaultPath, VAULT_DIRS.structures, `${structureId}.md`);
    atomicWriteFileSync(filePath, content);
    return filePath;
}

// ============================================================================
// Audio Operations
// ============================================================================

/**
 * Generate an audio ID
 */
export function generateAudioId(): string {
    // Format: a_<short-uuid>
    return `a_${uuidv4().split('-')[0]}`;
}

/**
 * Atomically write binary data to a file
 */
export function atomicWriteBinarySync(filePath: string, data: Buffer): void {
    const tempPath = getTempFilename(filePath);
    let fd: number | null = null;

    try {
        // Ensure parent directory exists
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        // Write to temp file
        fd = fs.openSync(tempPath, 'w');
        fs.writeSync(fd, data);

        // fsync to flush to disk (best effort)
        try {
            fs.fsyncSync(fd);
        } catch (fsyncError) {
            console.warn('[vault] fsync failed (non-fatal):', fsyncError);
        }

        fs.closeSync(fd);
        fd = null;

        // Atomic rename
        fs.renameSync(tempPath, filePath);
    } catch (error) {
        // Clean up temp file on error
        if (fd !== null) {
            try {
                fs.closeSync(fd);
            } catch {
                // Ignore close errors
            }
        }

        try {
            if (fs.existsSync(tempPath)) {
                fs.unlinkSync(tempPath);
            }
        } catch {
            // Ignore cleanup errors
        }

        throw error;
    }
}

/**
 * Save audio file to vault (atomic binary write)
 * @returns The relative path within the vault (e.g., "attachments/audio/a_abc123.webm")
 */
export function saveAudio(vaultPath: string, audioId: string, audioData: Buffer, extension: string = 'webm'): string {
    ensureVaultStructure(vaultPath);
    const relativePath = path.join(VAULT_DIRS.attachmentsAudio, `${audioId}.${extension}`);
    const fullPath = path.join(vaultPath, relativePath);
    atomicWriteBinarySync(fullPath, audioData);
    console.log(`[vault] Saved audio: ${relativePath}`);
    return relativePath;
}

/**
 * Get full path to an audio file
 */
export function getAudioPath(vaultPath: string, audioId: string, extension: string = 'webm'): string {
    return path.join(vaultPath, VAULT_DIRS.attachmentsAudio, `${audioId}.${extension}`);
}

/**
 * Check if audio file exists
 */
export function audioExists(vaultPath: string, audioId: string, extension: string = 'webm'): boolean {
    const filePath = getAudioPath(vaultPath, audioId, extension);
    return fs.existsSync(filePath);
}

// ============================================================================
// Voice Note Operations
// ============================================================================

export interface VoiceNoteInput {
    audioData: Buffer;
    audioExtension?: string;
    title?: string;
    content?: string;
}

export interface VoiceNote extends Note {
    audioPath: string;  // Relative path to audio file
}

/**
 * Save a voice note (audio + note with reference)
 * Creates both the audio file and a note linking to it
 */
export function saveVoiceNote(vaultPath: string, input: VoiceNoteInput): VoiceNote {
    ensureVaultStructure(vaultPath);

    const now = new Date().toISOString();
    const noteId = generateNoteId();
    const audioId = generateAudioId();
    const extension = input.audioExtension || 'webm';

    // Save audio file first
    const audioPath = saveAudio(vaultPath, audioId, input.audioData, extension);

    // Create note with audio reference
    const title = input.title || `Voice note ${new Date().toLocaleString()}`;
    const content = input.content || '*(Voice recording - transcription pending)*';

    const voiceNote: VoiceNote = {
        id: noteId,
        title,
        content,
        audioPath,
        createdAt: now,
        updatedAt: now,
    };

    // Create note file with audio reference in frontmatter
    const fileContent = matter.stringify(voiceNote.content, {
        id: voiceNote.id,
        title: voiceNote.title,
        audioPath: voiceNote.audioPath,
        createdAt: voiceNote.createdAt,
        updatedAt: voiceNote.updatedAt,
    });

    const notePath = path.join(vaultPath, VAULT_DIRS.notes, `${noteId}.md`);
    atomicWriteFileSync(notePath, fileContent);

    console.log(`[vault] Created voice note: ${noteId} -> ${audioPath}`);
    return voiceNote;
}

/**
 * Load a note and check if it's a voice note (has audioPath)
 */
export function loadVoiceNote(vaultPath: string, noteId: string): VoiceNote | null {
    const filePath = path.join(vaultPath, VAULT_DIRS.notes, `${noteId}.md`);

    if (!fs.existsSync(filePath)) {
        return null;
    }

    try {
        const fileContent = fs.readFileSync(filePath, 'utf-8');
        const { data, content } = matter(fileContent);

        if (!data.audioPath) {
            return null; // Not a voice note
        }

        return {
            id: data.id || noteId,
            title: data.title || 'Voice note',
            content: content.trim(),
            audioPath: data.audioPath,
            createdAt: data.createdAt || new Date().toISOString(),
            updatedAt: data.updatedAt || new Date().toISOString(),
        };
    } catch (error) {
        console.error(`[vault] Failed to load voice note ${noteId}:`, error);
        return null;
    }
}

/**
 * Clean up orphaned temp files (call on startup)
 */
export function cleanupTempFiles(vaultPath: string): number {
    let cleaned = 0;

    for (const subdir of Object.values(VAULT_DIRS)) {
        const dirPath = path.join(vaultPath, subdir);
        if (!fs.existsSync(dirPath)) continue;

        try {
            const files = fs.readdirSync(dirPath);
            for (const file of files) {
                if (file.startsWith('.') && file.endsWith('.tmp')) {
                    const filePath = path.join(dirPath, file);
                    try {
                        fs.unlinkSync(filePath);
                        cleaned++;
                        console.log(`[vault] Cleaned up orphaned temp file: ${file}`);
                    } catch {
                        // Ignore cleanup errors
                    }
                }
            }
        } catch {
            // Ignore directory read errors
        }
    }

    return cleaned;
}
