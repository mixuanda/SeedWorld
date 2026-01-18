import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import path from 'node:path';
import started from 'electron-squirrel-startup';
import { getVaultPath, setVaultPath, getAIConfig, setAIConfig, getAIConfigForRenderer } from './main/store';
import {
  ensureVaultStructure,
  isValidVault,
  saveNote,
  loadNote,
  loadAllNotes,
  deleteNote,
  rebuildIndex,
  cleanupTempFiles,
  type Note,
  type NoteInput,
} from './main/vault';
import {
  testConnection,
  validateConfig,
  getSafeConfigForLogging,
  type ProviderConfig,
  type LocalProviderConfig,
} from './main/ai-provider';

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (started) {
  app.quit();
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
  mainWindow.webContents.openDevTools();
};

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.on('ready', createWindow);

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
