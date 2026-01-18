// Type declarations for World-Seed API exposed via preload

// ============================================================================
// Note Types
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
// Voice Note Types
// ============================================================================

export interface VoiceNote extends Note {
    audioPath: string;
}

// ============================================================================
// AI Provider Types
// ============================================================================

export type ProviderMode = 'local' | 'online';

export interface LocalProviderConfig {
    mode: 'local';
    baseUrl: string;
    model: string;
}

export interface OnlineProviderConfig {
    mode: 'online';
    provider: 'openai' | 'gemini';
    apiKey: string;
    model: string;
}

export type ProviderConfig = LocalProviderConfig | OnlineProviderConfig;

// Safe version for renderer (no API keys)
export type SafeProviderConfig = LocalProviderConfig | Omit<OnlineProviderConfig, 'apiKey'>;

export interface TestConnectionResult {
    success: boolean;
    message: string;
    latencyMs: number;
    model?: string;
}

// ============================================================================
// API Interfaces
// ============================================================================

export interface VaultAPI {
    selectFolder: () => Promise<string | null>;
    getPath: () => Promise<string | null>;
    saveNote: (input: NoteInput, existingId?: string) => Promise<Note>;
    loadNotes: () => Promise<Note[]>;
    getNote: (id: string) => Promise<Note | null>;
    deleteNote: (id: string) => Promise<boolean>;
    rebuildIndex: () => Promise<NoteIndex | null>;
}

export interface AIAPI {
    getConfig: () => Promise<SafeProviderConfig | null>;
    setConfig: (config: ProviderConfig) => Promise<boolean>;
    testConnection: (config: ProviderConfig) => Promise<TestConnectionResult>;
}

export interface VoiceAPI {
    saveNote: (audioData: ArrayBuffer, extension?: string) => Promise<VoiceNote>;
}

export interface AttachmentAPI {
    getUrl: (relativePath: string) => string;
}

// ============================================================================
// Window API
// ============================================================================

declare global {
    interface Window {
        api: {
            ping: () => Promise<string>;
            vault: VaultAPI;
            ai: AIAPI;
            voice: VoiceAPI;
            attachment: AttachmentAPI;
        };
    }
}

export { };
