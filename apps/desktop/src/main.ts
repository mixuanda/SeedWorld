import { app, BrowserWindow, ipcMain, dialog, protocol } from 'electron';
import * as fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import started from 'electron-squirrel-startup';
import {
  getVaultPath,
  setVaultPath,
  getAIConfig,
  setAIConfig,
  getAIConfigForRenderer,
  getSyncConfig,
  setSyncConfig,
  clearSyncConfig,
  type SyncConfig,
} from './main/store';
import {
  ensureVaultStructure,
  isValidVault,
  saveNote,
  loadNote,
  loadAllNotes,
  deleteNote,
  rebuildIndex,
  cleanupTempFiles,
  saveVoiceNote,
  type Note,
  type NoteInput,
  type VoiceNote,
  type VoiceNoteInput,
} from './main/vault';
import {
  testConnection,
  validateConfig,
  getSafeConfigForLogging,
  type ProviderConfig,
  type LocalProviderConfig,
} from './main/ai-provider';
import {
  ensureWhisperInstalled,
  getWhisperStatus,
  installWhisper,
  uninstallWhisper,
  type WhisperProgress,
} from './main/addons/whisper';
import { DesktopSyncService } from './main/sync/service';

let syncService: DesktopSyncService | null = null;

// Custom protocol for serving vault files securely
const VAULT_PROTOCOL = 'seedworld';

// Register the protocol scheme as privileged (MUST be before app ready)
// This enables proper media streaming with range requests
protocol.registerSchemesAsPrivileged([
  {
    scheme: VAULT_PROTOCOL,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
]);

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (started) {
  app.quit();
}

function generateDeviceId(): string {
  return `dev_${randomBytes(8).toString('hex')}`;
}

async function getOrInitSyncService(): Promise<DesktopSyncService> {
  const vaultPath = getVaultPath();
  const syncConfig = getSyncConfig();

  if (!vaultPath) {
    throw new Error('No vault configured');
  }

  if (!syncConfig) {
    throw new Error('Not signed in to sync');
  }

  if (!syncService) {
    syncService = DesktopSyncService.create({
      vaultPath,
      serverUrl: syncConfig.serverUrl,
      userId: syncConfig.userId,
      workspaceId: syncConfig.workspaceId,
      deviceId: syncConfig.deviceId,
      token: syncConfig.token,
    });
  }

  return syncService;
}

// ============================================================================
// IPC Handlers
// ============================================================================

// Ping handler for testing IPC bridge
ipcMain.handle('ping', () => {
  console.log('[main] Received ping, sending pong');
  return 'pong';
});

// --- Vault Operations ---

// Select vault folder via native dialog
ipcMain.handle('vault:selectFolder', async () => {
  const result = await dialog.showOpenDialog({
    title: 'Choose Vault Folder',
    message: 'Select a folder to store your notes (OneDrive recommended)',
    properties: ['openDirectory', 'createDirectory'],
  });

  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }

  const selectedPath = result.filePaths[0];

  try {
    // Ensure vault structure exists
    ensureVaultStructure(selectedPath);
    // Save to local store
    setVaultPath(selectedPath);
    syncService = null;
    console.log(`[main] Vault path set to: ${selectedPath}`);
    return selectedPath;
  } catch (error) {
    console.error('[main] Failed to set vault path:', error);
    throw new Error('Failed to initialize vault folder');
  }
});

// Get current vault path (also ensures structure and cleans up on startup)
ipcMain.handle('vault:getPath', () => {
  const vaultPath = getVaultPath();
  if (vaultPath && isValidVault(vaultPath)) {
    // Ensure all subdirectories exist (safe if OneDrive removed some)
    ensureVaultStructure(vaultPath);
    // Clean up any orphaned temp files from interrupted writes
    const cleaned = cleanupTempFiles(vaultPath);
    if (cleaned > 0) {
      console.log(`[main] Cleaned up ${cleaned} orphaned temp file(s)`);
    }
    return vaultPath;
  }
  return null;
});

// Save a note
ipcMain.handle('vault:saveNote', (_event, input: NoteInput, existingId?: string): Note | null => {
  const vaultPath = getVaultPath();
  if (!vaultPath) {
    throw new Error('No vault configured');
  }

  try {
    const note = saveNote(vaultPath, input, existingId);
    console.log(`[main] Saved note: ${note.id}`);
    return note;
  } catch (error) {
    console.error('[main] Failed to save note:', error);
    throw error;
  }
});

// Load all notes
ipcMain.handle('vault:loadNotes', (): Note[] => {
  const vaultPath = getVaultPath();
  if (!vaultPath) {
    return [];
  }

  try {
    const notes = loadAllNotes(vaultPath);
    console.log(`[main] Loaded ${notes.length} notes`);
    return notes;
  } catch (error) {
    console.error('[main] Failed to load notes:', error);
    return [];
  }
});

// Get single note by ID
ipcMain.handle('vault:getNote', (_event, noteId: string): Note | null => {
  const vaultPath = getVaultPath();
  if (!vaultPath) {
    return null;
  }

  return loadNote(vaultPath, noteId);
});

// Delete a note
ipcMain.handle('vault:deleteNote', (_event, noteId: string): boolean => {
  const vaultPath = getVaultPath();
  if (!vaultPath) {
    return false;
  }

  const result = deleteNote(vaultPath, noteId);
  if (result) {
    console.log(`[main] Deleted note: ${noteId}`);
  }
  return result;
});

// Rebuild index (for debugging/recovery)
ipcMain.handle('vault:rebuildIndex', () => {
  const vaultPath = getVaultPath();
  if (!vaultPath) {
    return null;
  }

  return rebuildIndex(vaultPath);
});

// --- Sync/Auth Operations ---

ipcMain.handle('auth:getConfig', () => {
  const config = getSyncConfig();
  if (!config) {
    return null;
  }

  return {
    serverUrl: config.serverUrl,
    userId: config.userId,
    workspaceId: config.workspaceId,
    deviceId: config.deviceId,
    tokenExpiresAtMs: config.tokenExpiresAtMs,
  };
});

ipcMain.handle('auth:devSignIn', async (_event, input: {
  serverUrl: string;
  userId: string;
  workspaceId: string;
  deviceId?: string;
}) => {
  const serverUrl = input.serverUrl.trim().replace(/\/+$/, '');
  const userId = input.userId.trim();
  const workspaceId = input.workspaceId.trim();

  if (!serverUrl || !userId || !workspaceId) {
    throw new Error('serverUrl, userId, and workspaceId are required');
  }

  const response = await fetch(`${serverUrl}/auth/dev`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({ userId, workspaceId }),
  });

  if (!response.ok) {
    throw new Error(`Auth failed (${response.status})`);
  }

  const payload = await response.json() as {
    token: string;
    expiresAtMs: number;
  };

  const existing = getSyncConfig();
  const config: SyncConfig = {
    serverUrl,
    userId,
    workspaceId,
    deviceId: input.deviceId || existing?.deviceId || generateDeviceId(),
    token: payload.token,
    tokenExpiresAtMs: payload.expiresAtMs,
    importMode: existing?.importMode || 'restore',
  };

  setSyncConfig(config);
  syncService = null;

  await getOrInitSyncService();
  return {
    serverUrl: config.serverUrl,
    userId: config.userId,
    workspaceId: config.workspaceId,
    deviceId: config.deviceId,
    tokenExpiresAtMs: config.tokenExpiresAtMs,
  };
});

ipcMain.handle('auth:signOut', () => {
  clearSyncConfig();
  syncService = null;
  return true;
});

ipcMain.handle('inbox:list', async () => {
  const service = await getOrInitSyncService();
  return service.listInbox();
});

ipcMain.handle('capture:quickText', async (_event, input: { title?: string; body: string }) => {
  const service = await getOrInitSyncService();
  await service.captureText(input);
  return service.listInbox();
});

ipcMain.handle('sync:getStatus', async () => {
  const config = getSyncConfig();
  if (!config) {
    return {
      pendingEvents: 0,
      pendingBlobs: 0,
      lastPulledSeq: 0,
      lastAppliedSeq: 0,
      lastError: {
        code: 'AUTH',
        message: 'Sign in to enable sync',
      },
    };
  }

  const service = await getOrInitSyncService();
  return service.getStatus();
});

ipcMain.handle('sync:now', async () => {
  const service = await getOrInitSyncService();
  return service.syncNow();
});

ipcMain.handle('sync:rebuildProjection', async () => {
  const service = await getOrInitSyncService();
  await service.rebuildProjection();
  return true;
});

ipcMain.handle('export:create', async () => {
  const service = await getOrInitSyncService();
  const bundle = await service.exportBundle();

  const result = await dialog.showSaveDialog({
    title: 'Export SeedWorld Data',
    defaultPath: `seedworld-export-${Date.now()}.zip`,
    filters: [{ name: 'ZIP', extensions: ['zip'] }],
  });

  if (result.canceled || !result.filePath) {
    return null;
  }

  fs.writeFileSync(result.filePath, bundle);
  return result.filePath;
});

ipcMain.handle('diagnostics:getSummary', async () => {
  const service = await getOrInitSyncService();
  return service.diagnosticsSummaryTextOnly();
});

ipcMain.handle('diagnostics:export', async () => {
  const service = await getOrInitSyncService();
  const bundle = await service.exportDiagnosticsBundle();

  const result = await dialog.showSaveDialog({
    title: 'Export Diagnostics',
    defaultPath: `seedworld-diagnostics-${Date.now()}.zip`,
    filters: [{ name: 'ZIP', extensions: ['zip'] }],
  });

  if (result.canceled || !result.filePath) {
    return null;
  }

  fs.writeFileSync(result.filePath, bundle);
  return result.filePath;
});

ipcMain.handle('import:fromZip', async (_event, input: { mode: 'restore' | 'clone' }) => {
  const service = await getOrInitSyncService();
  const config = getSyncConfig();
  if (config) {
    setSyncConfig({ ...config, importMode: input.mode });
  }
  const result = await dialog.showOpenDialog({
    title: 'Import SeedWorld Export',
    properties: ['openFile'],
    filters: [{ name: 'ZIP', extensions: ['zip'] }],
  });

  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }

  return service.importBundle(result.filePaths[0], input.mode);
});

// --- AI Provider Operations ---

// Get current AI config (safe for renderer - no API keys)
ipcMain.handle('ai:getConfig', () => {
  return getAIConfigForRenderer();
});

// Set AI config (stores in main process only)
ipcMain.handle('ai:setConfig', (_event, config: ProviderConfig) => {
  const validation = validateConfig(config);
  if (!validation.valid) {
    throw new Error(validation.error);
  }

  setAIConfig(config);
  console.log('[main] AI config saved:', getSafeConfigForLogging(config));
  return true;
});

// Test AI connection
ipcMain.handle('ai:testConnection', async (_event, config: ProviderConfig) => {
  const validation = validateConfig(config);
  if (!validation.valid) {
    return {
      success: false,
      message: validation.error,
      latencyMs: 0,
    };
  }

  console.log('[main] Testing AI connection:', getSafeConfigForLogging(config));
  const result = await testConnection(config);
  console.log('[main] Test result:', result.success ? 'SUCCESS' : 'FAILED', `(${result.latencyMs}ms)`);
  return result;
});

// --- Attachment Operations ---

ipcMain.handle('attachment:getStreamUrl', async (_event, relativePath: string) => {
  return getAttachmentStreamUrl(relativePath);
});

// --- Whisper Add-on Operations ---

ipcMain.handle('whisper:getStatus', async () => {
  return getWhisperStatus();
});

ipcMain.handle('whisper:install', async (_event, modelName?: string) => {
  return installWhisper({ model: modelName }, (progress) => {
    broadcastWhisperProgress(progress);
  });
});

ipcMain.handle('whisper:uninstall', async () => {
  return uninstallWhisper();
});

ipcMain.handle('whisper:ensureInstalled', async (_event, modelName?: string) => {
  return ensureWhisperInstalled(modelName, (progress) => {
    broadcastWhisperProgress(progress);
  });
});

// --- Voice Note Operations ---

// Save a voice note (audio + note)
ipcMain.handle('voice:saveNote', (_event, audioArrayBuffer: ArrayBuffer, extension?: string): VoiceNote | null => {
  const vaultPath = getVaultPath();
  if (!vaultPath) {
    throw new Error('No vault configured');
  }

  try {
    // Convert ArrayBuffer to Buffer
    const audioData = Buffer.from(audioArrayBuffer);

    const input: VoiceNoteInput = {
      audioData,
      audioExtension: extension || 'webm',
    };

    const voiceNote = saveVoiceNote(vaultPath, input);
    console.log(`[main] Saved voice note: ${voiceNote.id} with audio at ${voiceNote.audioPath}`);
    return voiceNote;
  } catch (error) {
    console.error('[main] Failed to save voice note:', error);
    throw error;
  }
});

// ============================================================================
// Window Management
// ============================================================================

const createWindow = () => {
  // Create the browser window with secure defaults
  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    webPreferences: {
      // Keep Forge Vite template's default preload wiring
      preload: path.join(__dirname, 'preload.js'),
      // Strict security settings (per .agent/rules/20-security.md)
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  // and load the index.html of the app.
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
    );
  }

  // Open the DevTools in development
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.webContents.openDevTools();
  }
};

// ============================================================================
// Custom Protocol for Vault Files
// ============================================================================

/**
 * Validate that a relative path is safe (no path traversal)
 */
function isPathSafe(relativePath: string): boolean {
  // Normalize and check for path traversal attempts
  const normalized = path.normalize(relativePath);

  // Reject absolute paths
  if (path.isAbsolute(normalized)) {
    return false;
  }

  // Reject paths that try to escape (contain ..)
  if (normalized.startsWith('..') || normalized.includes('..\\') || normalized.includes('../')) {
    return false;
  }

  return true;
}

/**
 * Get MIME type from file extension
 */
function getMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const mimeTypes: Record<string, string> = {
    '.webm': 'audio/webm; codecs=opus',
    '.ogg': 'audio/ogg',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.m4a': 'audio/mp4',
    '.mp4': 'video/mp4',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.pdf': 'application/pdf',
  };
  return mimeTypes[ext] || 'application/octet-stream';
}

/**
 * Parse Range header
 * @returns [start, end] or null if no valid range
 */
function parseRangeHeader(rangeHeader: string | null, fileSize: number): [number, number] | null {
  if (!rangeHeader) return null;

  // Format: bytes=start-end or bytes=start-
  const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
  if (!match) return null;

  const start = parseInt(match[1], 10);
  const end = match[2] ? parseInt(match[2], 10) : fileSize - 1;

  // Validate range
  if (start >= fileSize || end >= fileSize || start > end) {
    return null;
  }

  return [start, end];
}

// ============================================================================
// Local Attachment Streaming Server (fallback)
// ============================================================================

const ATTACHMENT_SERVER_HOST = '127.0.0.1';
const ATTACHMENT_SERVER_TOKEN = randomBytes(16).toString('hex');
let attachmentServer: http.Server | null = null;
let attachmentServerPort: number | null = null;
let attachmentServerStarting: Promise<number> | null = null;

function buildAttachmentHeaders(mimeType: string, contentLength: number, extra: Record<string, string> = {}): Record<string, string> {
  return {
    'Content-Type': mimeType,
    'Content-Length': contentLength.toString(),
    'Accept-Ranges': 'bytes',
    ...extra,
  };
}

function logAttachmentResponse(status: number, headers: Record<string, string>): void {
  const contentHeaders: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const lowerKey = key.toLowerCase();
    if (lowerKey.startsWith('content-') || lowerKey === 'accept-ranges') {
      contentHeaders[key] = value;
    }
  }
  console.log('[attachment-server] Response', { status, headers: contentHeaders });
}

function logProtocolResponse(status: number, headers: Record<string, string>): void {
  const contentHeaders: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const lowerKey = key.toLowerCase();
    if (lowerKey.startsWith('content-') || lowerKey === 'accept-ranges') {
      contentHeaders[key] = value;
    }
  }
  console.log('[protocol] Response', { status, headers: contentHeaders });
}

function handleAttachmentRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
  const method = req.method || 'GET';
  if (method !== 'GET' && method !== 'HEAD') {
    const headers = { 'Content-Type': 'text/plain; charset=utf-8' };
    res.writeHead(405, headers);
    res.end('Method Not Allowed');
    logAttachmentResponse(405, headers);
    return;
  }

  const requestUrl = new URL(req.url || '/', `http://${ATTACHMENT_SERVER_HOST}`);
  const expectedPath = `/vault/${ATTACHMENT_SERVER_TOKEN}`;
  if (!requestUrl.pathname.startsWith(expectedPath)) {
    const headers = { 'Content-Type': 'text/plain; charset=utf-8' };
    res.writeHead(403, headers);
    res.end('Forbidden');
    logAttachmentResponse(403, headers);
    return;
  }

  const encodedPath = requestUrl.searchParams.get('path');
  if (!encodedPath) {
    const headers = { 'Content-Type': 'text/plain; charset=utf-8' };
    res.writeHead(400, headers);
    res.end('Missing path');
    logAttachmentResponse(400, headers);
    return;
  }

  const relativePath = decodeURIComponent(encodedPath);
  if (!isPathSafe(relativePath)) {
    const headers = { 'Content-Type': 'text/plain; charset=utf-8' };
    res.writeHead(403, headers);
    res.end('Forbidden');
    logAttachmentResponse(403, headers);
    return;
  }

  const vaultPath = getVaultPath();
  if (!vaultPath) {
    const headers = { 'Content-Type': 'text/plain; charset=utf-8' };
    res.writeHead(404, headers);
    res.end('Vault not configured');
    logAttachmentResponse(404, headers);
    return;
  }

  const fullPath = path.join(vaultPath, relativePath);
  const resolvedPath = path.resolve(fullPath);
  const resolvedVault = path.resolve(vaultPath);
  if (!resolvedPath.startsWith(resolvedVault)) {
    const headers = { 'Content-Type': 'text/plain; charset=utf-8' };
    res.writeHead(403, headers);
    res.end('Forbidden');
    logAttachmentResponse(403, headers);
    return;
  }

  if (!fs.existsSync(fullPath)) {
    const headers = { 'Content-Type': 'text/plain; charset=utf-8' };
    res.writeHead(404, headers);
    res.end('Not found');
    logAttachmentResponse(404, headers);
    return;
  }

  const stat = fs.statSync(fullPath);
  if (!stat.isFile()) {
    const headers = { 'Content-Type': 'text/plain; charset=utf-8' };
    res.writeHead(404, headers);
    res.end('Not found');
    logAttachmentResponse(404, headers);
    return;
  }

  const fileSize = stat.size;
  const mimeType = getMimeType(fullPath);
  const rangeHeaderRaw = req.headers.range;
  const rangeHeader = Array.isArray(rangeHeaderRaw) ? rangeHeaderRaw[0] : rangeHeaderRaw || null;
  const range = parseRangeHeader(rangeHeader, fileSize);

  console.log('[attachment-server] Request', {
    url: req.url,
    fullPath,
    mimeType,
    hasRange: !!rangeHeader,
  });

  if (rangeHeader && !range) {
    const headers = buildAttachmentHeaders(mimeType, fileSize, {
      'Content-Range': `bytes */${fileSize}`,
    });
    res.writeHead(416, headers);
    res.end();
    logAttachmentResponse(416, headers);
    return;
  }

  if (range) {
    const [start, end] = range;
    const chunkSize = end - start + 1;
    const headers = buildAttachmentHeaders(mimeType, chunkSize, {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
    });
    res.writeHead(206, headers);
    logAttachmentResponse(206, headers);
    if (method === 'HEAD') {
      res.end();
      return;
    }
    const stream = fs.createReadStream(fullPath, { start, end });
    stream.on('error', (error) => {
      console.error('[attachment-server] Stream error:', error);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      }
      res.end();
    });
    stream.pipe(res);
    return;
  }

  const headers = buildAttachmentHeaders(mimeType, fileSize);
  res.writeHead(200, headers);
  logAttachmentResponse(200, headers);
  if (method === 'HEAD') {
    res.end();
    return;
  }
  const stream = fs.createReadStream(fullPath);
  stream.on('error', (error) => {
    console.error('[attachment-server] Stream error:', error);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    }
    res.end();
  });
  stream.pipe(res);
}

async function ensureAttachmentServer(): Promise<number> {
  if (attachmentServerPort) return attachmentServerPort;
  if (attachmentServerStarting) return attachmentServerStarting;

  attachmentServerStarting = new Promise((resolve, reject) => {
    attachmentServer = http.createServer(handleAttachmentRequest);
    attachmentServer.on('error', (error) => {
      console.error('[attachment-server] Failed to start:', error);
      attachmentServerStarting = null;
      reject(error);
    });

    attachmentServer.listen(0, ATTACHMENT_SERVER_HOST, () => {
      const address = attachmentServer?.address();
      if (address && typeof address === 'object') {
        attachmentServerPort = address.port;
        attachmentServerStarting = null;
        console.log(`[attachment-server] Listening on http://${ATTACHMENT_SERVER_HOST}:${attachmentServerPort}`);
        resolve(attachmentServerPort);
        return;
      }
      attachmentServerStarting = null;
      reject(new Error('Failed to bind attachment server'));
    });
  });

  return attachmentServerStarting;
}

async function getAttachmentStreamUrl(relativePath: string): Promise<string> {
  const port = await ensureAttachmentServer();
  const cleanPath = relativePath.replace(/^[/\\]+/, '').replace(/\\/g, '/');
  if (!isPathSafe(cleanPath)) {
    throw new Error('Invalid attachment path');
  }
  return `http://${ATTACHMENT_SERVER_HOST}:${port}/vault/${ATTACHMENT_SERVER_TOKEN}?path=${encodeURIComponent(cleanPath)}`;
}

function broadcastWhisperProgress(progress: WhisperProgress): void {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send('whisper:progress', progress);
  }
}

/**
 * Register the seedworld:// protocol
 * Supports Range requests for audio/video seeking
 * Uses streaming to avoid loading entire file into memory
 */
function registerVaultProtocol(): void {
  protocol.handle(VAULT_PROTOCOL, async (request) => {
    try {
      // Parse the URL: seedworld://vault/<relativePath>
      const url = new URL(request.url);
      const rangeHeader = request.headers.get('Range');
      const hasRange = !!rangeHeader;

      // Expect: seedworld://vault/attachments/audio/a_xxx.webm
      if (url.hostname !== 'vault') {
        console.error('[protocol] Invalid host:', url.hostname);
        console.log('[protocol] Request', {
          url: request.url,
          fullPath: null,
          mimeType: null,
          hasRange,
        });
        logProtocolResponse(400, {});
        return new Response('Invalid host', { status: 400 });
      }

      // Get relative path from URL
      const relativePath = decodeURIComponent(url.pathname.slice(1)); // Remove leading /

      // Get vault path
      const vaultPath = getVaultPath();
      const fullPath = vaultPath ? path.join(vaultPath, relativePath) : null;
      const mimeType = fullPath ? getMimeType(fullPath) : 'application/octet-stream';

      console.log('[protocol] Request', {
        url: request.url,
        relativePath,
        fullPath,
        mimeType,
        hasRange,
      });

      // Security: validate path
      if (!isPathSafe(relativePath)) {
        console.error('[protocol] Path traversal attempt blocked:', relativePath);
        logProtocolResponse(403, {});
        return new Response('Forbidden', { status: 403 });
      }

      if (!vaultPath) {
        console.error('[protocol] No vault configured');
        logProtocolResponse(404, {});
        return new Response('Vault not configured', { status: 404 });
      }

      // Build full path
      const fullPathResolved = path.join(vaultPath, relativePath);

      // Security: verify path is still within vault (double-check after join)
      const resolvedPath = path.resolve(fullPathResolved);
      const resolvedVault = path.resolve(vaultPath);
      if (!resolvedPath.startsWith(resolvedVault)) {
        console.error('[protocol] Path escape attempt blocked:', resolvedPath);
        logProtocolResponse(403, {});
        return new Response('Forbidden', { status: 403 });
      }

      // Check file exists and get stats
      if (!fs.existsSync(fullPathResolved)) {
        console.error('[protocol] File not found:', relativePath);
        logProtocolResponse(404, {});
        return new Response('Not found', { status: 404 });
      }

      const stat = fs.statSync(fullPathResolved);
      const fileSize = stat.size;

      // Check for Range header (for seeking support)
      const range = parseRangeHeader(rangeHeader, fileSize);

      if (rangeHeader && !range) {
        const headers = {
          'Content-Type': mimeType,
          'Content-Range': `bytes */${fileSize}`,
          'Accept-Ranges': 'bytes',
        };
        logProtocolResponse(416, headers);
        return new Response('Range Not Satisfiable', { status: 416, headers });
      }

      if (range) {
        // Partial content response (206)
        const [start, end] = range;
        const chunkSize = end - start + 1;

        // Create readable stream for the range
        const stream = fs.createReadStream(fullPathResolved, { start, end });

        // Convert Node stream to Web ReadableStream
        const webStream = new ReadableStream({
          start(controller) {
            stream.on('data', (chunk: Buffer) => {
              controller.enqueue(new Uint8Array(chunk));
            });
            stream.on('end', () => {
              controller.close();
            });
            stream.on('error', (err) => {
              controller.error(err);
            });
          },
          cancel() {
            stream.destroy();
          },
        });

        const headers = {
          'Content-Type': mimeType,
          'Content-Length': chunkSize.toString(),
          'Content-Range': `bytes ${start}-${end}/${fileSize}`,
          'Accept-Ranges': 'bytes',
        };
        logProtocolResponse(206, headers);
        return new Response(webStream, {
          status: 206,
          headers,
        });
      }

      // Full file response (200)
      const stream = fs.createReadStream(fullPathResolved);

      // Convert Node stream to Web ReadableStream
      const webStream = new ReadableStream({
        start(controller) {
          stream.on('data', (chunk: Buffer) => {
            controller.enqueue(new Uint8Array(chunk));
          });
          stream.on('end', () => {
            controller.close();
          });
          stream.on('error', (err) => {
            controller.error(err);
          });
        },
        cancel() {
          stream.destroy();
        },
      });

      const headers = {
        'Content-Type': mimeType,
        'Content-Length': fileSize.toString(),
        'Accept-Ranges': 'bytes',
      };
      logProtocolResponse(200, headers);
      return new Response(webStream, {
        status: 200,
        headers,
      });
    } catch (error) {
      console.error('[protocol] Error serving file:', error);
      logProtocolResponse(500, {});
      return new Response('Internal error', { status: 500 });
    }
  });

  console.log(`[main] Registered ${VAULT_PROTOCOL}:// protocol with Range support`);
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.on('ready', () => {
  // Register custom protocol BEFORE creating window
  registerVaultProtocol();
  if (getVaultPath() && getSyncConfig()) {
    getOrInitSyncService().catch((error) => {
      console.warn('[main] Sync bootstrap skipped:', error);
    });
  }
  createWindow();
});

app.on('before-quit', () => {
  if (attachmentServer) {
    attachmentServer.close();
    attachmentServer = null;
    attachmentServerPort = null;
  }
});

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  // On OS X it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open.
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
