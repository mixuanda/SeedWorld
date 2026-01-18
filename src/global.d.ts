// Type declarations for World-Seed API exposed via preload

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

declare global {
    interface Window {
        api: {
            /**
             * Test IPC connectivity - returns "pong" from main process
             */
            ping: () => Promise<string>;

            /**
             * Vault operations for note persistence
             */
            vault: VaultAPI;
        };
    }
}

export { };
