// Preload script for World-Seed
// Exposes a minimal, typed IPC bridge via contextBridge
// See: https://www.electronjs.org/docs/latest/tutorial/process-model#preload-scripts

import { contextBridge, ipcRenderer } from 'electron';

// ============================================================================
// Type Definitions
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

export interface VaultAPI {
    selectFolder: () => Promise<string | null>;
    getPath: () => Promise<string | null>;
    saveNote: (input: NoteInput, existingId?: string) => Promise<Note>;
    loadNotes: () => Promise<Note[]>;
    getNote: (id: string) => Promise<Note | null>;
    deleteNote: (id: string) => Promise<boolean>;
    rebuildIndex: () => Promise<NoteIndex | null>;
}

export interface WorldSeedAPI {
    ping: () => Promise<string>;
    vault: VaultAPI;
}

// ============================================================================
// Exposed API
// ============================================================================

contextBridge.exposeInMainWorld('api', {
    /**
     * Test IPC connectivity - returns "pong" from main process
     */
    ping: (): Promise<string> => ipcRenderer.invoke('ping'),

    /**
     * Vault operations for note persistence
     */
    vault: {
        selectFolder: (): Promise<string | null> =>
            ipcRenderer.invoke('vault:selectFolder'),

        getPath: (): Promise<string | null> =>
            ipcRenderer.invoke('vault:getPath'),

        saveNote: (input: NoteInput, existingId?: string): Promise<Note> =>
            ipcRenderer.invoke('vault:saveNote', input, existingId),

        loadNotes: (): Promise<Note[]> =>
            ipcRenderer.invoke('vault:loadNotes'),

        getNote: (id: string): Promise<Note | null> =>
            ipcRenderer.invoke('vault:getNote', id),

        deleteNote: (id: string): Promise<boolean> =>
            ipcRenderer.invoke('vault:deleteNote', id),

        rebuildIndex: (): Promise<NoteIndex | null> =>
            ipcRenderer.invoke('vault:rebuildIndex'),
    },
} satisfies WorldSeedAPI);
