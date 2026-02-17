/**
 * Whisper Add-on Manifest Resolver
 *
 * Resolves whispercpp manifest from the registry index with optional override.
 */

import * as http from 'node:http';
import * as https from 'node:https';
import { getWhisperManifestUrl } from '../store';

const WHISPER_ADDON_ID = 'whispercpp';
const REGISTRY_INDEX_URL = 'https://raw.githubusercontent.com/mixuanda/seedworld-addons/main/manifests/index.json';
const REGISTRY_BASE_URL = 'https://raw.githubusercontent.com/mixuanda/seedworld-addons/main/manifests/';
const MAX_REDIRECTS = 5;

export const DEFAULT_WHISPER_MODELS = ['tiny', 'base', 'small'] as const;

export const SUPPORTED_PLATFORMS = ['win32-x64', 'darwin-arm64', 'darwin-x64'] as const;

export type SupportedPlatform = typeof SUPPORTED_PLATFORMS[number];

export interface WhisperRegistryIndex {
    version: number;
    manifests: Array<{ addonId: string; path: string }>;
}

export interface WhisperPackage {
    url: string;
    sha256?: string;
    bytes?: number;
}

export interface WhisperPackageSet {
    default?: WhisperPackage;
    blas?: WhisperPackage;
    binCandidates?: string[];
}

export type WhisperModelEntry = string | { url: string; sha256?: string; bytes?: number };

export interface WhisperManifest {
    addonId: string;
    name: string;
    description?: string;
    version?: string;
    defaultModel?: string;
    packages?: Record<string, Record<string, WhisperPackageSet>>;
    models?: Record<string, WhisperModelEntry>;
}

export interface ResolvedWhisperManifest {
    manifest: WhisperManifest;
    manifestUrl: string;
}

export interface ResolvedWhisperPackage {
    platformKey: string;
    osKey: string;
    arch: string;
    variant: 'default' | 'blas';
    package: WhisperPackage;
    binCandidates: string[];
}

function fetchJson<T>(url: string, redirectCount = 0): Promise<T> {
    return new Promise((resolve, reject) => {
        const parsed = new URL(url);
        const getter = parsed.protocol === 'http:' ? http.get : https.get;

        const request = getter(url, (res) => {
            if (res.statusCode && [301, 302, 307, 308].includes(res.statusCode)) {
                const location = res.headers.location;
                if (location && redirectCount < MAX_REDIRECTS) {
                    res.resume();
                    const nextUrl = new URL(location, url).toString();
                    fetchJson<T>(nextUrl, redirectCount + 1).then(resolve).catch(reject);
                    return;
                }
            }

            if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
                res.resume();
                reject(new Error(`HTTP ${res.statusCode ?? '??'}: ${res.statusMessage ?? 'Unknown error'}`));
                return;
            }

            let data = '';
            res.setEncoding('utf-8');
            res.on('data', (chunk) => {
                data += chunk;
            });
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data) as T);
                } catch {
                    reject(new Error('Invalid JSON response'));
                }
            });
            res.on('error', reject);
        });

        request.on('error', reject);
    });
}

function validateManifest(manifest: WhisperManifest): void {
    if (!manifest.addonId) {
        throw new Error('Manifest missing addonId.');
    }
    if (!manifest.packages && !manifest.models) {
        throw new Error('Manifest is missing packages and models.');
    }
}

function getPlatformAliases(platform: string): string[] {
    switch (platform) {
        case 'win32':
            return ['windows', 'win32'];
        case 'darwin':
            return ['darwin', 'macos', 'osx'];
        default:
            return [platform];
    }
}

export function getPlatformKey(): string {
    return `${process.platform}-${process.arch}`;
}

export function isPlatformSupported(platformKey: string = getPlatformKey()): boolean {
    return SUPPORTED_PLATFORMS.includes(platformKey as SupportedPlatform);
}

export function listWhisperModels(manifest: WhisperManifest | null): string[] {
    if (!manifest?.models) {
        return [...DEFAULT_WHISPER_MODELS];
    }
    const names = Object.keys(manifest.models);
    return names.length > 0 ? names : [...DEFAULT_WHISPER_MODELS];
}

export function resolveWhisperModel(
    manifest: WhisperManifest,
    modelName: string,
): { name: string; url: string; sha256?: string; bytes?: number } | null {
    if (!manifest.models) return null;
    const entry = manifest.models[modelName];
    if (!entry) return null;
    if (typeof entry === 'string') {
        return { name: modelName, url: entry };
    }
    return {
        name: modelName,
        url: entry.url,
        sha256: entry.sha256,
        bytes: entry.bytes,
    };
}

export function resolveWhisperPackage(
    manifest: WhisperManifest,
    platformKey: string,
    variant: 'default' | 'blas' = 'default',
): ResolvedWhisperPackage | null {
    const packages = manifest.packages;
    if (!packages) return null;

    const [platform, arch] = platformKey.split('-');
    if (!platform || !arch) return null;

    const osKeys = getPlatformAliases(platform);
    for (const osKey of osKeys) {
        const byArch = packages[osKey];
        if (!byArch) continue;
        const archSet = byArch[arch];
        if (!archSet) continue;

        const selected = variant === 'blas' ? archSet.blas ?? archSet.default : archSet.default;
        if (!selected?.url) {
            continue;
        }

        return {
            platformKey,
            osKey,
            arch,
            variant: selected === archSet.blas ? 'blas' : 'default',
            package: selected,
            binCandidates: archSet.binCandidates ?? [],
        };
    }

    return null;
}

export async function resolveWhisperManifest(): Promise<ResolvedWhisperManifest> {
    const overrideUrl = getWhisperManifestUrl();

    if (overrideUrl) {
        const manifest = await fetchJson<WhisperManifest>(overrideUrl);
        validateManifest(manifest);
        return { manifest, manifestUrl: overrideUrl };
    }

    const index = await fetchJson<WhisperRegistryIndex>(REGISTRY_INDEX_URL);
    const entry = index.manifests?.find((item) => item.addonId === WHISPER_ADDON_ID);
    if (!entry) {
        throw new Error(`Registry index missing ${WHISPER_ADDON_ID} manifest.`);
    }

    const manifestUrl = new URL(entry.path, REGISTRY_BASE_URL).toString();
    const manifest = await fetchJson<WhisperManifest>(manifestUrl);
    validateManifest(manifest);
    return { manifest, manifestUrl };
}
