/**
 * Store module for World-Seed
 * Persists app settings locally (not synced via OneDrive)
 * 
 * Note: Using a simple JSON file approach for compatibility
 * electron-store v11+ is ESM-only which can cause issues with Vite
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { app } from 'electron';

interface StoreData {
    vaultPath: string | null;
}

const STORE_FILENAME = 'world-seed-settings.json';

function getStorePath(): string {
    return path.join(app.getPath('userData'), STORE_FILENAME);
}

function loadStore(): StoreData {
    const storePath = getStorePath();

    try {
        if (fs.existsSync(storePath)) {
            const data = fs.readFileSync(storePath, 'utf-8');
            return JSON.parse(data) as StoreData;
        }
    } catch (error) {
        console.error('[store] Failed to load store:', error);
    }

    return { vaultPath: null };
}

function saveStore(data: StoreData): void {
    const storePath = getStorePath();

    try {
        fs.writeFileSync(storePath, JSON.stringify(data, null, 2), 'utf-8');
    } catch (error) {
        console.error('[store] Failed to save store:', error);
    }
}

export function getVaultPath(): string | null {
    const data = loadStore();
    return data.vaultPath;
}

export function setVaultPath(vaultPath: string): void {
    const data = loadStore();
    data.vaultPath = vaultPath;
    saveStore(data);
}

export function clearVaultPath(): void {
    const data = loadStore();
    data.vaultPath = null;
    saveStore(data);
}
