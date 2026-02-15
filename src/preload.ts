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

// --- AI Provider Types ---

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

// --- API Interfaces ---

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

// Voice note with audio reference
export interface VoiceNote extends Note {
    audioPath: string;
}

export interface VoiceAPI {
    saveNote: (audioData: ArrayBuffer, extension?: string) => Promise<VoiceNote>;
}

// Attachment URL helper (using seedworld:// protocol)
export interface AttachmentAPI {
    getUrl: (relativePath: string) => string;
    getStreamUrl: (relativePath: string) => Promise<string>;
}

// Whisper Add-on status
export interface WhisperStatus {
    platformKey: string;
    supported: boolean;
    installed: boolean;
    state: 'unsupported' | 'not_installed' | 'installed' | 'broken';
    version: string | null;
    model: string | null;
    availableModels: string[];
    sizeBytes: number | null;
    message: string | null;
    health?: {
        ok: boolean;
        exitCode: number | null;
        stderr: string | null;
    };
}

export interface WhisperProgress {
    stage: 'downloading' | 'verifying' | 'extracting' | 'installing';
    percent: number | null;
    transferredBytes: number;
    totalBytes: number | null;
    message: string;
}

export interface WhisperAPI {
    getStatus: () => Promise<WhisperStatus>;
    install: (model?: string) => Promise<WhisperStatus>;
    uninstall: () => Promise<WhisperStatus>;
    ensureInstalled: (model?: string) => Promise<WhisperStatus>;
    onProgress: (callback: (progress: WhisperProgress) => void) => () => void;
}

export interface WorldSeedAPI {
    ping: () => Promise<string>;
    vault: VaultAPI;
    ai: AIAPI;
    voice: VoiceAPI;
    attachment: AttachmentAPI;
    whisper: WhisperAPI;
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

    /**
     * AI provider operations
     * Note: API keys are never exposed to renderer
     */
    ai: {
        getConfig: (): Promise<SafeProviderConfig | null> =>
            ipcRenderer.invoke('ai:getConfig'),

        setConfig: (config: ProviderConfig): Promise<boolean> =>
            ipcRenderer.invoke('ai:setConfig', config),

        testConnection: (config: ProviderConfig): Promise<TestConnectionResult> =>
            ipcRenderer.invoke('ai:testConnection', config),
    },

    /**
     * Voice recording operations
     */
    voice: {
        saveNote: (audioData: ArrayBuffer, extension?: string): Promise<VoiceNote> =>
            ipcRenderer.invoke('voice:saveNote', audioData, extension),
    },

    /**
     * Attachment URL helper
     * Converts relative vault paths to seedworld:// URLs
     */
    attachment: {
        getUrl: (relativePath: string): string => {
            // Clean up the path (remove leading slashes, normalize)
            const cleanPath = relativePath.replace(/^[/\\]+/, '').replace(/\\/g, '/');
            return `seedworld://vault/${encodeURIComponent(cleanPath)}`;
        },
        getStreamUrl: (relativePath: string): Promise<string> => {
            return ipcRenderer.invoke('attachment:getStreamUrl', relativePath);
        },
    },

    /**
     * Whisper add-on operations
     */
    whisper: {
        getStatus: (): Promise<WhisperStatus> =>
            ipcRenderer.invoke('whisper:getStatus'),

        install: (model?: string): Promise<WhisperStatus> =>
            ipcRenderer.invoke('whisper:install', model),

        uninstall: (): Promise<WhisperStatus> =>
            ipcRenderer.invoke('whisper:uninstall'),

        ensureInstalled: (model?: string): Promise<WhisperStatus> =>
            ipcRenderer.invoke('whisper:ensureInstalled', model),

        onProgress: (callback: (progress: WhisperProgress) => void): (() => void) => {
            const handler = (_event: Electron.IpcRendererEvent, progress: WhisperProgress) => {
                callback(progress);
            };
            ipcRenderer.on('whisper:progress', handler);
            return () => {
                ipcRenderer.removeListener('whisper:progress', handler);
            };
        },
    },
} satisfies WorldSeedAPI);
