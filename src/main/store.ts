/**
 * Store module for World-Seed
 * Persists app settings locally (not synced via OneDrive)
 * 
 * Security:
 * - API keys are stored locally only
 * - Never logged or sent to renderer
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { app } from 'electron';
import type { ProviderConfig } from './ai-provider';

// ============================================================================
// Types
// ============================================================================

interface StoreData {
    vaultPath: string | null;
    aiConfig: ProviderConfig | null;
}

const STORE_FILENAME = 'world-seed-settings.json';

// ============================================================================
// Store Operations
// ============================================================================

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

    return { vaultPath: null, aiConfig: null };
}

function saveStore(data: StoreData): void {
    const storePath = getStorePath();

    try {
        fs.writeFileSync(storePath, JSON.stringify(data, null, 2), 'utf-8');
    } catch (error) {
        console.error('[store] Failed to save store:', error);
    }
}

// ============================================================================
// Vault Path
// ============================================================================

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

// ============================================================================
// AI Config
// ============================================================================

export function getAIConfig(): ProviderConfig | null {
    const data = loadStore();
    return data.aiConfig;
}

export function setAIConfig(config: ProviderConfig): void {
    const data = loadStore();
    data.aiConfig = config;
    saveStore(data);
    // Log without secrets
    console.log('[store] AI config updated:', {
        mode: config.mode,
        model: config.model,
        ...(config.mode === 'local' ? { baseUrl: config.baseUrl } : { provider: config.provider }),
    });
}

export function clearAIConfig(): void {
    const data = loadStore();
    data.aiConfig = null;
    saveStore(data);
}

/**
 * Get AI config safe for renderer (no API keys)
 */
export function getAIConfigForRenderer(): Omit<ProviderConfig, 'apiKey'> | null {
    const config = getAIConfig();
    if (!config) return null;

    if (config.mode === 'local') {
        return config;
    } else {
        // Strip API key for renderer
        const { apiKey, ...safeConfig } = config;
        return safeConfig as Omit<ProviderConfig, 'apiKey'>;
    }
}
