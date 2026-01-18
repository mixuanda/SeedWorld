/**
 * Whisper Add-on Manifest Handler
 * 
 * Fetches and parses remote manifest for Whisper binary downloads.
 * Caches manifest locally for offline reference.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as https from 'node:https';
import { app } from 'electron';
import { getWhisperManifestUrl } from '../store';

// ============================================================================
// Types
// ============================================================================

export interface PlatformAsset {
    url: string;
    sha256: string;
    bytes: number;
    minOS?: string;  // e.g., "10.0" for Windows 10, "12.0" for macOS Monterey
}

export interface ModelInfo {
    name: string;
    url: string;
    sha256: string;
    bytes: number;
}

export interface WhisperManifest {
    version: string;
    releaseDate: string;
    platforms: {
        'win32-x64'?: PlatformAsset;
        'darwin-arm64'?: PlatformAsset;
        'darwin-x64'?: PlatformAsset;
        'linux-x64'?: PlatformAsset;
    };
    models: {
        base: ModelInfo;
        small: ModelInfo;
        tiny?: ModelInfo;
        medium?: ModelInfo;
    };
}

// ============================================================================
// Default Manifest (fallback for development)
// ============================================================================

/**
 * Default manifest URL - can be overridden in settings
 */
export const DEFAULT_MANIFEST_URL = 'https://raw.githubusercontent.com/example/whisper-releases/main/manifest.json';

/**
 * Placeholder manifest for development
 * Replace with real URLs when hosting is set up
 */
const PLACEHOLDER_MANIFEST: WhisperManifest = {
    version: '1.0.0',
    releaseDate: '2026-01-18',
    platforms: {
        'win32-x64': {
            url: 'https://example.com/whisper-win32-x64.zip',
            sha256: 'placeholder_sha256_for_windows',
            bytes: 10_000_000, // ~10MB placeholder
            minOS: '10.0',
        },
        'darwin-arm64': {
            url: 'https://example.com/whisper-darwin-arm64.zip',
            sha256: 'placeholder_sha256_for_macos_arm',
            bytes: 8_000_000,
            minOS: '12.0',
        },
        'darwin-x64': {
            url: 'https://example.com/whisper-darwin-x64.zip',
            sha256: 'placeholder_sha256_for_macos_x64',
            bytes: 8_000_000,
            minOS: '12.0',
        },
    },
    models: {
        base: {
            name: 'ggml-base.bin',
            url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin',
            sha256: 'placeholder_sha256_for_base_model',
            bytes: 142_000_000, // ~142MB
        },
        small: {
            name: 'ggml-small.bin',
            url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin',
            sha256: 'placeholder_sha256_for_small_model',
            bytes: 488_000_000, // ~488MB
        },
    },
};

// ============================================================================
// Manifest Cache
// ============================================================================

function getManifestCachePath(): string {
    return path.join(app.getPath('userData'), 'addons', 'whisper-manifest.json');
}

function loadCachedManifest(): WhisperManifest | null {
    const cachePath = getManifestCachePath();

    try {
        if (fs.existsSync(cachePath)) {
            const content = fs.readFileSync(cachePath, 'utf-8');
            return JSON.parse(content) as WhisperManifest;
        }
    } catch (error) {
        console.error('[manifest] Failed to load cached manifest:', error);
    }

    return null;
}

function saveCachedManifest(manifest: WhisperManifest): void {
    const cachePath = getManifestCachePath();
    const cacheDir = path.dirname(cachePath);

    try {
        if (!fs.existsSync(cacheDir)) {
            fs.mkdirSync(cacheDir, { recursive: true });
        }
        fs.writeFileSync(cachePath, JSON.stringify(manifest, null, 2));
    } catch (error) {
        console.error('[manifest] Failed to cache manifest:', error);
    }
}

// ============================================================================
// Manifest Fetching
// ============================================================================

/**
 * Fetch JSON from HTTPS URL
 */
function fetchJson<T>(url: string): Promise<T> {
    return new Promise((resolve, reject) => {
        https.get(url, (res) => {
            if (res.statusCode !== 200) {
                reject(new Error(`HTTP ${res.statusCode}: ${res.statusMessage}`));
                return;
            }

            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data) as T);
                } catch (error) {
                    reject(new Error('Invalid JSON response'));
                }
            });
            res.on('error', reject);
        }).on('error', reject);
    });
}

/**
 * Fetch the Whisper manifest from remote URL
 * Falls back to cached manifest or placeholder if fetch fails
 */
export async function fetchWhisperManifest(): Promise<WhisperManifest> {
    const manifestUrl = getWhisperManifestUrl() || DEFAULT_MANIFEST_URL;

    console.log('[manifest] Fetching manifest from:', manifestUrl);

    try {
        const manifest = await fetchJson<WhisperManifest>(manifestUrl);

        // Validate manifest structure
        if (!manifest.version || !manifest.platforms || !manifest.models) {
            throw new Error('Invalid manifest structure');
        }

        // Cache the manifest
        saveCachedManifest(manifest);

        console.log('[manifest] Fetched manifest version:', manifest.version);
        return manifest;
    } catch (error) {
        console.warn('[manifest] Failed to fetch remote manifest:', error);

        // Try cached manifest
        const cached = loadCachedManifest();
        if (cached) {
            console.log('[manifest] Using cached manifest version:', cached.version);
            return cached;
        }

        // Fall back to placeholder for development
        console.log('[manifest] Using placeholder manifest');
        return PLACEHOLDER_MANIFEST;
    }
}

/**
 * Get platform key for current system
 */
export function getPlatformKey(): keyof WhisperManifest['platforms'] | null {
    const platform = process.platform;
    const arch = process.arch;

    const key = `${platform}-${arch}` as keyof WhisperManifest['platforms'];

    // Only return if it's a known platform
    if (['win32-x64', 'darwin-arm64', 'darwin-x64', 'linux-x64'].includes(key)) {
        return key;
    }

    return null;
}

/**
 * Check if current platform is supported by manifest
 */
export function isPlatformSupported(manifest: WhisperManifest): boolean {
    const key = getPlatformKey();
    if (!key) return false;

    return !!manifest.platforms[key];
}

/**
 * Get asset info for current platform
 */
export function getPlatformAsset(manifest: WhisperManifest): PlatformAsset | null {
    const key = getPlatformKey();
    if (!key) return null;

    return manifest.platforms[key] || null;
}
