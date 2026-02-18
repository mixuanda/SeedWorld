/**
 * Whisper Add-on Manager
 *
 * Downloads whispercpp add-on and model into userData, verifies checksums,
 * installs atomically, and performs a health check.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as http from 'node:http';
import * as https from 'node:https';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { app, dialog } from 'electron';
import extractZip from 'extract-zip';
import {
    DEFAULT_WHISPER_MODELS,
    getPlatformKey,
    isPlatformSupported,
    listWhisperModels,
    resolveWhisperManifest,
    resolveWhisperModel,
    resolveWhisperPackage,
    type ResolvedWhisperPackage,
    type WhisperManifest,
} from './manifest';

const ADDON_ID = 'whispercpp';
const INSTALL_METADATA = 'installed.json';
const DOWNLOADS_DIR = 'downloads';
const MODELS_DIR = 'models';
const MAX_REDIRECTS = 8;

export type WhisperInstallState = 'unsupported' | 'not_installed' | 'installed' | 'broken';

export interface WhisperHealthCheck {
    ok: boolean;
    exitCode: number | null;
    stderr: string | null;
}

export interface WhisperStatus {
    platformKey: string;
    supported: boolean;
    installed: boolean;
    state: WhisperInstallState;
    version: string | null;
    model: string | null;
    availableModels: string[];
    sizeBytes: number | null;
    message: string | null;
    health?: WhisperHealthCheck;
}

export type WhisperProgressStage = 'downloading' | 'verifying' | 'extracting' | 'installing';

export interface WhisperProgress {
    stage: WhisperProgressStage;
    percent: number | null;
    transferredBytes: number;
    totalBytes: number | null;
    message: string;
}

export interface WhisperInstallOptions {
    model?: string;
}

interface InstallMetadata {
    version: string;
    installedAt: string;
    platformKey: string;
    installedPath: string;
    binaryPath: string;
    model?: string;
    modelPath?: string;
    sourceUrls: {
        manifestUrl?: string;
        packageUrl: string;
        modelUrl?: string;
    };
    health: WhisperHealthCheck;
}

interface DownloadResult {
    filePath: string;
    bytes: number;
    sha256: string;
    totalBytes: number | null;
}

function getInstallRoot(): string {
    return path.join(app.getPath('userData'), 'addons', ADDON_ID);
}

function getInstallMetadataPath(): string {
    return path.join(getInstallRoot(), INSTALL_METADATA);
}

function ensureDir(dirPath: string): void {
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }
}

function removeDir(dirPath: string): void {
    if (fs.existsSync(dirPath)) {
        fs.rmSync(dirPath, { recursive: true, force: true });
    }
}

function safeUnlink(filePath: string): void {
    try {
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }
    } catch (error) {
        console.warn('[whisper] Failed to remove temp file:', error);
    }
}

function loadInstallMetadata(): InstallMetadata | null {
    const metadataPath = getInstallMetadataPath();
    if (!fs.existsSync(metadataPath)) return null;

    try {
        const raw = fs.readFileSync(metadataPath, 'utf-8');
        return JSON.parse(raw) as InstallMetadata;
    } catch (error) {
        console.warn('[whisper] Failed to read install metadata:', error);
        return null;
    }
}

function saveInstallMetadata(metadata: InstallMetadata): void {
    const metadataPath = getInstallMetadataPath();
    ensureDir(path.dirname(metadataPath));
    fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2), 'utf-8');
}

function sanitizeVersion(version: string | undefined | null): string {
    const cleaned = (version || '').trim().replace(/[<>:"/\\|?*]+/g, '');
    return cleaned || 'unknown';
}

function deriveVersion(manifest: WhisperManifest | null, packageUrl: string): string {
    if (manifest?.version) return manifest.version;
    const match = packageUrl.match(/v?(\d+\.\d+\.\d+)/i);
    return match?.[1] || 'unknown';
}

function getDirectorySize(dirPath: string): number {
    let total = 0;
    try {
        const entries = fs.readdirSync(dirPath, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(dirPath, entry.name);
            if (entry.isFile()) {
                total += fs.statSync(fullPath).size;
            } else if (entry.isDirectory()) {
                total += getDirectorySize(fullPath);
            }
        }
    } catch (error) {
        console.warn('[whisper] Failed to read directory size:', error);
    }
    return total;
}

function isPathInside(root: string, target: string): boolean {
    const resolvedRoot = path.resolve(root);
    const resolvedTarget = path.resolve(target);
    const rootPrefix = resolvedRoot.endsWith(path.sep) ? resolvedRoot : `${resolvedRoot}${path.sep}`;
    if (process.platform === 'win32') {
        return resolvedTarget.toLowerCase().startsWith(rootPrefix.toLowerCase());
    }
    return resolvedTarget.startsWith(rootPrefix);
}

function buildCandidateList(binCandidates?: string[]): string[] {
    const defaults = process.platform === 'win32'
        ? ['whisper-cli.exe', 'main.exe', 'whisper.exe']
        : ['whisper-cli', 'whisper', 'main'];
    const combined = [...(binCandidates ?? []), ...defaults];
    const seen = new Set<string>();
    const unique: string[] = [];
    for (const item of combined) {
        const key = item.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        unique.push(item);
    }
    return unique;
}

function resolveBinaryPath(installDir: string, binCandidates?: string[]): string | null {
    const candidates = buildCandidateList(binCandidates);

    for (const candidate of candidates) {
        const candidatePath = path.isAbsolute(candidate)
            ? candidate
            : path.join(installDir, candidate);
        if (!isPathInside(installDir, candidatePath)) continue;
        if (fs.existsSync(candidatePath) && fs.statSync(candidatePath).isFile()) {
            return candidatePath;
        }
    }

    return findBinaryRecursive(installDir, candidates);
}

function findBinaryRecursive(dirPath: string, candidates: string[]): string | null {
    const candidateSet = new Set(candidates.map((name) => path.basename(name).toLowerCase()));

    try {
        const entries = fs.readdirSync(dirPath, { withFileTypes: true });

        for (const entry of entries) {
            if (!entry.isFile()) continue;
            if (candidateSet.has(entry.name.toLowerCase())) {
                return path.join(dirPath, entry.name);
            }
        }

        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            const found = findBinaryRecursive(path.join(dirPath, entry.name), candidates);
            if (found) return found;
        }
    } catch (error) {
        console.warn('[whisper] Failed to scan for binary:', error);
    }

    return null;
}

function truncateText(text: string, maxLength: number): string {
    if (text.length <= maxLength) return text;
    return `${text.slice(0, maxLength)}...`;
}

function runHealthCheck(binaryPath: string): Promise<WhisperHealthCheck> {
    return new Promise((resolve) => {
        let stderr = '';
        let stdout = '';
        let settled = false;

        const child = spawn(binaryPath, ['--help'], {
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
        });

        child.stdout.on('data', (chunk: Buffer) => {
            if (stdout.length < 2000) {
                stdout += chunk.toString('utf-8');
            }
        });

        child.stderr.on('data', (chunk: Buffer) => {
            if (stderr.length < 2000) {
                stderr += chunk.toString('utf-8');
            }
        });

        child.on('error', (error) => {
            if (settled) return;
            settled = true;
            resolve({
                ok: false,
                exitCode: null,
                stderr: error.message,
            });
        });

        child.on('close', (code) => {
            if (settled) return;
            settled = true;
            const combined = stderr.trim() || stdout.trim();
            resolve({
                ok: code === 0,
                exitCode: code ?? null,
                stderr: combined || null,
            });
        });
    });
}

function emitProgress(callback: ((progress: WhisperProgress) => void) | undefined, progress: WhisperProgress): void {
    if (callback) {
        callback(progress);
    }
}

async function downloadToFile(
    url: string,
    destinationPath: string,
    onProgress?: (progress: WhisperProgress) => void,
    options?: { message?: string; totalBytes?: number | null },
    redirectCount = 0,
): Promise<DownloadResult> {
    return new Promise((resolve, reject) => {
        const parsed = new URL(url);
        const getter = parsed.protocol === 'http:' ? http.get : https.get;
        const progressMessage = options?.message ?? 'Downloading file';

        const request = getter(url, (res) => {
            if (res.statusCode && [301, 302, 307, 308].includes(res.statusCode)) {
                const location = res.headers.location;
                if (location && redirectCount < MAX_REDIRECTS) {
                    res.resume();
                    const nextUrl = new URL(location, url).toString();
                    downloadToFile(nextUrl, destinationPath, onProgress, options, redirectCount + 1)
                        .then(resolve)
                        .catch(reject);
                    return;
                }
            }

            if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
                res.resume();
                reject(new Error(`HTTP ${res.statusCode ?? '??'}: ${res.statusMessage ?? 'Unknown error'}`));
                return;
            }

            const headerLength = res.headers['content-length']
                ? parseInt(res.headers['content-length'] as string, 10)
                : null;
            const totalBytes = headerLength || options?.totalBytes || null;
            let downloaded = 0;
            const hash = createHash('sha256');

            ensureDir(path.dirname(destinationPath));
            const fileStream = fs.createWriteStream(destinationPath);

            res.on('data', (chunk: Buffer) => {
                downloaded += chunk.length;
                hash.update(chunk);
                const percent = totalBytes ? Math.round((downloaded / totalBytes) * 100) : null;
                emitProgress(onProgress, {
                    stage: 'downloading',
                    percent,
                    transferredBytes: downloaded,
                    totalBytes,
                    message: progressMessage,
                });
            });

            res.on('error', (error) => {
                fileStream.destroy();
                safeUnlink(destinationPath);
                reject(error);
            });

            fileStream.on('error', (error) => {
                fileStream.destroy();
                safeUnlink(destinationPath);
                reject(error);
            });

            fileStream.on('finish', () => {
                resolve({
                    filePath: destinationPath,
                    bytes: downloaded,
                    sha256: hash.digest('hex'),
                    totalBytes,
                });
            });

            res.pipe(fileStream);
        });

        request.on('error', (error) => {
            safeUnlink(destinationPath);
            reject(error);
        });
    });
}

function requireSha256(expected: string | undefined, label: string): string {
    if (!expected) {
        throw new Error(`Missing SHA256 for ${label} in manifest.`);
    }
    return expected;
}

function getHealthMessage(health: WhisperHealthCheck): string {
    if (health.ok) return 'Healthy';
    const exitCode = health.exitCode === null ? 'unknown' : health.exitCode.toString();
    const stderr = health.stderr ? truncateText(health.stderr, 1000) : 'No stderr output';
    return `Health check failed (exitCode=${exitCode}). ${stderr}`;
}

function resolveDefaultModel(manifest: WhisperManifest | null, availableModels: string[]): string {
    if (manifest?.defaultModel && availableModels.includes(manifest.defaultModel)) {
        return manifest.defaultModel;
    }
    if (availableModels.includes('base')) {
        return 'base';
    }
    return availableModels[0] ?? 'base';
}

function resolveSelectedModel(
    requestedModel: string | undefined,
    manifest: WhisperManifest | null,
    availableModels: string[],
): string {
    if (requestedModel && availableModels.includes(requestedModel)) {
        return requestedModel;
    }
    return resolveDefaultModel(manifest, availableModels);
}

async function showInstallError(message: string, detail: string): Promise<void> {
    await dialog.showMessageBox({
        type: 'error',
        title: 'Whisper Add-on',
        message,
        detail,
    });
}

export async function getWhisperStatus(): Promise<WhisperStatus> {
    const platformKey = getPlatformKey();
    const platformSupported = isPlatformSupported(platformKey);
    let manifest: WhisperManifest | null = null;
    let manifestError: string | null = null;
    let packageInfo: ResolvedWhisperPackage | null = null;
    let availableModels: string[] = [...DEFAULT_WHISPER_MODELS];
    let manifestVersion: string | null = null;

    if (platformSupported) {
        try {
            const resolved = await resolveWhisperManifest();
            manifest = resolved.manifest;
            availableModels = listWhisperModels(manifest);
            packageInfo = resolveWhisperPackage(manifest, platformKey);
            if (packageInfo) {
                manifestVersion = deriveVersion(manifest, packageInfo.package.url);
            }
        } catch (error) {
            manifestError = error instanceof Error ? error.message : 'Failed to load manifest.';
        }
    }

    if (!platformSupported) {
        return {
            platformKey,
            supported: false,
            installed: false,
            state: 'unsupported',
            version: null,
            model: null,
            availableModels,
            sizeBytes: null,
            message: `Platform ${platformKey} is not supported.`,
        };
    }

    if (manifest && !packageInfo) {
        return {
            platformKey,
            supported: false,
            installed: false,
            state: 'unsupported',
            version: manifestVersion,
            model: resolveDefaultModel(manifest, availableModels),
            availableModels,
            sizeBytes: null,
            message: `No Whisper package listed for platform ${platformKey}.`,
        };
    }

    const metadata = loadInstallMetadata();
    const installedPath = metadata?.installedPath && fs.existsSync(metadata.installedPath)
        ? metadata.installedPath
        : null;

    if (!installedPath || !metadata) {
        return {
            platformKey,
            supported: true,
            installed: false,
            state: 'not_installed',
            version: manifestVersion,
            model: resolveDefaultModel(manifest, availableModels),
            availableModels,
            sizeBytes: null,
            message: manifestError,
        };
    }

    const binaryPath = metadata.binaryPath && fs.existsSync(metadata.binaryPath) ? metadata.binaryPath : null;
    const modelPath = metadata.modelPath && fs.existsSync(metadata.modelPath) ? metadata.modelPath : null;
    const health = metadata.health || {
        ok: false,
        exitCode: null,
        stderr: 'Health check metadata missing.',
    };
    let brokenMessage: string | null = null;

    if (metadata.platformKey && metadata.platformKey !== platformKey) {
        brokenMessage = `Installed add-on is for ${metadata.platformKey}, but detected ${platformKey}.`;
    } else if (!binaryPath) {
        brokenMessage = 'Whisper binary is missing.';
    } else if (metadata.model && !modelPath) {
        brokenMessage = `Whisper model "${metadata.model}" is missing.`;
    } else if (!health.ok) {
        brokenMessage = getHealthMessage(health);
    }

    const broken = !!brokenMessage;

    return {
        platformKey,
        supported: true,
        installed: true,
        state: broken ? 'broken' : 'installed',
        version: metadata.version || manifestVersion,
        model: metadata.model || resolveDefaultModel(manifest, availableModels),
        availableModels,
        sizeBytes: getDirectorySize(installedPath),
        message: broken ? brokenMessage : manifestError,
        health,
    };
}

export async function installWhisper(
    options: WhisperInstallOptions = {},
    onProgress?: (progress: WhisperProgress) => void,
): Promise<WhisperStatus> {
    const platformKey = getPlatformKey();
    if (!isPlatformSupported(platformKey)) {
        throw new Error(`Platform ${platformKey} is not supported.`);
    }

    const { manifest, manifestUrl } = await resolveWhisperManifest();
    const packageInfo = resolveWhisperPackage(manifest, platformKey);
    if (!packageInfo) {
        throw new Error(`No Whisper package available for platform ${platformKey}.`);
    }

    const availableModels = listWhisperModels(manifest);
    const selectedModel = resolveSelectedModel(options.model, manifest, availableModels);
    const modelEntry = resolveWhisperModel(manifest, selectedModel);
    if (!modelEntry) {
        throw new Error(`No Whisper model entry found for "${selectedModel}".`);
    }

    const version = sanitizeVersion(deriveVersion(manifest, packageInfo.package.url));
    const installRoot = getInstallRoot();
    const finalInstallPath = path.join(installRoot, version);
    const stagingPath = path.join(installRoot, `.staging-${Date.now()}`);
    const downloadsRoot = path.join(installRoot, DOWNLOADS_DIR);

    ensureDir(installRoot);

    emitProgress(onProgress, {
        stage: 'installing',
        percent: null,
        transferredBytes: 0,
        totalBytes: null,
        message: 'Preparing install',
    });

    const downloadedFiles: string[] = [];
    let zipPath = '';
    let modelTempPath: string | null = null;

    try {
        const expectedPackageSha = requireSha256(packageInfo.package.sha256, 'package');
        const packageFileName = `whispercpp-${platformKey}-${version}.zip`;
        const packageDestination = path.join(downloadsRoot, packageFileName);
        const packageDownload = await downloadToFile(
            packageInfo.package.url,
            packageDestination,
            onProgress,
            { message: 'Downloading Whisper package', totalBytes: packageInfo.package.bytes ?? null },
        );
        downloadedFiles.push(packageDownload.filePath);
        emitProgress(onProgress, {
            stage: 'verifying',
            percent: null,
            transferredBytes: packageDownload.bytes,
            totalBytes: packageDownload.totalBytes,
            message: 'Verifying Whisper package',
        });
        if (packageDownload.sha256.toLowerCase() !== expectedPackageSha.toLowerCase()) {
            throw new Error(`SHA256 mismatch for package. Expected ${expectedPackageSha}, got ${packageDownload.sha256}.`);
        }
        zipPath = packageDownload.filePath;

        removeDir(stagingPath);
        ensureDir(stagingPath);

        emitProgress(onProgress, {
            stage: 'extracting',
            percent: null,
            transferredBytes: 0,
            totalBytes: null,
            message: 'Extracting Whisper package',
        });

        await extractZip(zipPath, { dir: stagingPath });

        const modelFileName = `${selectedModel}.bin`;
        modelTempPath = path.join(downloadsRoot, `model-${selectedModel}-${Date.now()}.bin`);
        const modelDownload = await downloadToFile(
            modelEntry.url,
            modelTempPath,
            onProgress,
            { message: `Downloading Whisper model (${selectedModel})`, totalBytes: modelEntry.bytes ?? null },
        );
        downloadedFiles.push(modelDownload.filePath);
        const expectedModelSha = requireSha256(modelEntry.sha256, `model ${selectedModel}`);
        emitProgress(onProgress, {
            stage: 'verifying',
            percent: null,
            transferredBytes: modelDownload.bytes,
            totalBytes: modelDownload.totalBytes,
            message: `Verifying Whisper model (${selectedModel})`,
        });
        if (modelDownload.sha256.toLowerCase() !== expectedModelSha.toLowerCase()) {
            throw new Error(`SHA256 mismatch for model ${selectedModel}. Expected ${expectedModelSha}, got ${modelDownload.sha256}.`);
        }

        const modelDir = path.join(stagingPath, MODELS_DIR);
        ensureDir(modelDir);
        const stagedModelPath = path.join(modelDir, modelFileName);
        fs.renameSync(modelDownload.filePath, stagedModelPath);

        const binaryPath = resolveBinaryPath(stagingPath, packageInfo.binCandidates);
        const health = binaryPath
            ? await runHealthCheck(binaryPath)
            : { ok: false, exitCode: null, stderr: 'Whisper binary not found after install.' };

        if (!health.ok) {
            await dialog.showMessageBox({
                type: 'error',
                title: 'Whisper Add-on',
                message: 'Whisper add-on failed the health check.',
                detail: getHealthMessage(health),
            });
        }

        const backupPath = path.join(installRoot, `.backup-${Date.now()}`);
        try {
            if (fs.existsSync(finalInstallPath)) {
                fs.renameSync(finalInstallPath, backupPath);
            }
            fs.renameSync(stagingPath, finalInstallPath);
            removeDir(backupPath);
        } catch (error) {
            removeDir(stagingPath);
            if (fs.existsSync(backupPath)) {
                fs.renameSync(backupPath, finalInstallPath);
            }
            throw error;
        }

        const resolvedBinaryPath = binaryPath
            ? path.join(finalInstallPath, path.relative(stagingPath, binaryPath))
            : '';
        const resolvedModelPath = path.join(finalInstallPath, MODELS_DIR, modelFileName);

        saveInstallMetadata({
            version,
            installedAt: new Date().toISOString(),
            platformKey,
            installedPath: finalInstallPath,
            binaryPath: resolvedBinaryPath,
            model: selectedModel,
            modelPath: resolvedModelPath,
            sourceUrls: {
                manifestUrl,
                packageUrl: packageInfo.package.url,
                modelUrl: modelEntry.url,
            },
            health,
        });
    } catch (error) {
        removeDir(stagingPath);
        for (const filePath of downloadedFiles) {
            safeUnlink(filePath);
        }
        const message = error instanceof Error ? error.message : 'Install failed.';
        await showInstallError('Failed to install Whisper add-on.', message);
        throw error;
    } finally {
        if (zipPath) safeUnlink(zipPath);
        if (modelTempPath) safeUnlink(modelTempPath);
    }

    return getWhisperStatus();
}

export async function uninstallWhisper(): Promise<WhisperStatus> {
    const installRoot = getInstallRoot();
    removeDir(installRoot);

    return getWhisperStatus();
}

export async function ensureWhisperInstalled(
    modelName?: string,
    onProgress?: (progress: WhisperProgress) => void,
): Promise<WhisperStatus> {
    const status = await getWhisperStatus();
    if (status.state === 'installed' || status.state === 'broken' || status.state === 'unsupported') {
        return status;
    }

    const response = await dialog.showMessageBox({
        type: 'question',
        title: 'Whisper Add-on',
        message: 'Whisper is required to transcribe audio. Download and install now?',
        buttons: ['Download & Install', 'Cancel'],
        defaultId: 0,
        cancelId: 1,
    });

    if (response.response === 0) {
        return installWhisper({ model: modelName }, onProgress);
    }

    return status;
}
