// Preload script for World-Seed
// Exposes a minimal, typed IPC bridge via contextBridge
// See: https://www.electronjs.org/docs/latest/tutorial/process-model#preload-scripts

import { contextBridge, ipcRenderer } from 'electron';

// Type definitions for the exposed API
export interface WorldSeedAPI {
    ping: () => Promise<string>;
}

// Expose typed API to renderer via contextBridge
contextBridge.exposeInMainWorld('api', {
    /**
     * Test IPC connectivity - returns "pong" from main process
     */
    ping: (): Promise<string> => ipcRenderer.invoke('ping'),
} satisfies WorldSeedAPI);
