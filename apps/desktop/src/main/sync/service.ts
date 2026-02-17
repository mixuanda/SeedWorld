import * as fs from 'node:fs';
import * as path from 'node:path';
import JSZip from 'jszip';
import {
  buildExportSnapshot,
  createDisabledSyncTransport,
  createHttpSyncTransport,
  generateEventId,
  migrateEvent,
  type BlobManifestEntry,
  type DeviceState,
  type ExportSnapshot,
  type ImportMode,
  type SyncStatus,
  type StoredEvent,
  SyncEngine,
  validateImportBundle,
} from '@seedworld/core';
import { ensureVaultStructure, saveNote } from '../vault';
import { DesktopSqliteStorageAdapter } from './sqlite-adapter';

export interface DesktopSyncBootstrap {
  vaultPath: string;
  userId: string;
  workspaceId: string;
  deviceId: string;
  serverUrl?: string;
  token?: string;
}

interface DiagnosticsSummary {
  workspaceId: string;
  deviceId: string;
  lastSuccessAtMs?: number;
  lastPulledSeq: number;
  lastAppliedSeq: number;
  pendingEvents: number;
  pendingBlobs: number;
  lastError?: {
    code: string;
    message: string;
  };
  attempts: Array<{
    timestampMs: number;
    action: string;
    result: string;
    errorCode?: string;
    message?: string;
  }>;
}

export class DesktopSyncService {
  private readonly vaultPath: string;

  private readonly adapter: DesktopSqliteStorageAdapter;

  private readonly engine: SyncEngine;

  private readonly workspaceId: string;

  private constructor(args: {
    vaultPath: string;
    workspaceId: string;
    adapter: DesktopSqliteStorageAdapter;
    engine: SyncEngine;
  }) {
    this.vaultPath = args.vaultPath;
    this.workspaceId = args.workspaceId;
    this.adapter = args.adapter;
    this.engine = args.engine;
  }

  static create(config: DesktopSyncBootstrap): DesktopSyncService {
    const stateDir = path.join(config.vaultPath, '.seedworld');
    fs.mkdirSync(stateDir, { recursive: true });
    const dbPath = path.join(stateDir, 'state.db');

    const adapter = new DesktopSqliteStorageAdapter({
      dbPath,
      workspaceId: config.workspaceId,
      userId: config.userId,
      deviceId: config.deviceId,
    });

    const transport = config.serverUrl && config.token
      ? createHttpSyncTransport({
          baseUrl: config.serverUrl,
          token: config.token,
        })
      : createDisabledSyncTransport('AUTH: Sign in required for sync');

    const engine = new SyncEngine({
      storage: adapter,
      transport,
    });

    return new DesktopSyncService({
      vaultPath: config.vaultPath,
      workspaceId: config.workspaceId,
      adapter,
      engine,
    });
  }

  async captureText(input: { title?: string; body: string }): Promise<void> {
    if (!input.body.trim()) {
      throw new Error('Capture body is required');
    }

    await this.engine.captureText({
      atomId: `atom_${generateEventId().replace(/-/g, '').slice(0, 20)}`,
      title: input.title,
      body: input.body,
    });

    await this.syncProjectionToVault();
  }

  async listInbox() {
    return this.engine.getInbox();
  }

  async getStatus(): Promise<SyncStatus> {
    return this.engine.getSyncStatus();
  }

  async syncNow(): Promise<SyncStatus> {
    const status = await this.engine.syncNow();
    await this.syncProjectionToVault();
    return status;
  }

  async rebuildProjection(): Promise<void> {
    await this.engine.rebuildProjection();
    await this.syncProjectionToVault();
  }

  async exportBundle(options: { allowMissingBlobs?: boolean } = {}): Promise<Buffer> {
    const snapshot = await buildExportSnapshot(this.adapter, {
      allowMissingBlobs: options.allowMissingBlobs,
    });

    return buildExportZip(snapshot);
  }

  async exportDiagnosticsBundle(): Promise<Buffer> {
    const status = await this.engine.getSyncStatus();
    const state = await this.adapter.getDeviceState();
    const attempts = await this.adapter.listSyncAttempts(50);

    const summary: DiagnosticsSummary = {
      workspaceId: this.workspaceId,
      deviceId: state.deviceId,
      lastSuccessAtMs: status.lastSuccessAtMs,
      lastPulledSeq: status.lastPulledSeq,
      lastAppliedSeq: status.lastAppliedSeq,
      pendingEvents: status.pendingEvents,
      pendingBlobs: status.pendingBlobs,
      lastError: status.lastError,
      attempts,
    };

    const zip = new JSZip();
    zip.file('summary.json', JSON.stringify(summary, null, 2));
    zip.file('summary.txt', this.diagnosticsSummaryText(summary));

    return zip.generateAsync({
      type: 'nodebuffer',
      compression: 'DEFLATE',
    });
  }

  async diagnosticsSummaryTextOnly(): Promise<string> {
    const status = await this.engine.getSyncStatus();
    const state = await this.adapter.getDeviceState();
    const attempts = await this.adapter.listSyncAttempts(10);

    return this.diagnosticsSummaryText({
      workspaceId: this.workspaceId,
      deviceId: state.deviceId,
      lastSuccessAtMs: status.lastSuccessAtMs,
      lastPulledSeq: status.lastPulledSeq,
      lastAppliedSeq: status.lastAppliedSeq,
      pendingEvents: status.pendingEvents,
      pendingBlobs: status.pendingBlobs,
      lastError: status.lastError,
      attempts,
    });
  }

  async importBundle(zipPath: string, mode: ImportMode): Promise<{ workspaceId: string; importedEvents: number }> {
    const bytes = fs.readFileSync(zipPath);
    const zip = await JSZip.loadAsync(bytes);

    const manifestText = await zip.file('manifest.json')?.async('string');
    if (!manifestText) {
      throw new Error('Import failed: manifest.json not found in export bundle');
    }

    const eventsText = await zip.file('events/events.jsonl')?.async('string');
    if (!eventsText) {
      throw new Error('Import failed: events/events.jsonl not found in export bundle');
    }

    const manifest = JSON.parse(manifestText);
    const events = eventsText
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line));

    await validateImportBundle({ manifest, events });

    const currentState = await this.adapter.getDeviceState();
    const existingEvents = await this.adapter.listEvents();
    if (existingEvents.length > 0) {
      throw new Error('Import requires an empty workspace metadata DB. Choose a new vault/workspace.');
    }

    const targetWorkspaceId = mode === 'clone'
      ? `workspace_${generateEventId().replace(/-/g, '').slice(0, 16)}`
      : manifest.workspaceId;

    const importedEvents: StoredEvent[] = events.map((raw) => {
      const migrated = migrateEvent(raw);
      return {
        ...migrated,
        workspaceId: targetWorkspaceId,
        syncStatus: typeof migrated.serverSeq === 'number' ? 'synced' : 'saved_local',
      };
    });

    const updatedState: DeviceState = {
      ...currentState,
      workspaceId: targetWorkspaceId,
      projectionDirty: true,
      lastPulledSeq: 0,
      lastAppliedSeq: 0,
      nextLocalSeq: 1,
      lastErrorCode: undefined,
      lastErrorMessage: undefined,
    };

    await this.adapter.saveDeviceState(updatedState);
    await this.adapter.upsertEvents(importedEvents);

    const blobFolder = path.join(this.vaultPath, 'attachments', 'blobs');
    fs.mkdirSync(blobFolder, { recursive: true });
    const blobEntries: BlobManifestEntry[] = [];

    for (const [filename, file] of Object.entries(zip.files)) {
      if (!filename.startsWith('blobs/') || filename.endsWith('/')) {
        continue;
      }

      const hash = path.basename(filename).split('.')[0];
      const destPath = path.join(blobFolder, path.basename(filename));
      const blobBytes = await file.async('nodebuffer');
      fs.writeFileSync(destPath, blobBytes);

      blobEntries.push({
        hash,
        size: blobBytes.byteLength,
        contentType: 'application/octet-stream',
        localPath: destPath,
        isPresent: true,
        syncStatus: 'synced',
        updatedAtMs: Date.now(),
      });
    }

    if (blobEntries.length > 0) {
      await this.adapter.saveBlobManifest(blobEntries);
    }

    await this.rebuildProjection();

    return {
      workspaceId: targetWorkspaceId,
      importedEvents: importedEvents.length,
    };
  }

  private diagnosticsSummaryText(summary: DiagnosticsSummary): string {
    const lines = [
      `Workspace: ${summary.workspaceId}`,
      `Device: ${summary.deviceId}`,
      `Last success: ${summary.lastSuccessAtMs ? new Date(summary.lastSuccessAtMs).toISOString() : 'never'}`,
      `Last pulled seq: ${summary.lastPulledSeq}`,
      `Last applied seq: ${summary.lastAppliedSeq}`,
      `Pending events: ${summary.pendingEvents}`,
      `Pending blobs: ${summary.pendingBlobs}`,
      `Last error: ${summary.lastError ? `${summary.lastError.code} - ${summary.lastError.message}` : 'none'}`,
      '',
      'Recent attempts:',
      ...summary.attempts.map((attempt) =>
        `- ${new Date(attempt.timestampMs).toISOString()} ${attempt.action} ${attempt.result}` +
        (attempt.errorCode ? ` (${attempt.errorCode})` : '') +
        (attempt.message ? ` ${attempt.message}` : ''),
      ),
    ];

    return lines.join('\n');
  }

  private async syncProjectionToVault(): Promise<void> {
    ensureVaultStructure(this.vaultPath);
    const projection = await this.adapter.getProjection();
    if (!projection) {
      return;
    }

    for (const atom of projection.atoms) {
      saveNote(
        this.vaultPath,
        {
          title: atom.title,
          content: atom.body,
        },
        atom.atomId,
      );
    }
  }
}

async function buildExportZip(snapshot: ExportSnapshot): Promise<Buffer> {
  const zip = new JSZip();

  zip.file('manifest.json', JSON.stringify(snapshot.manifest, null, 2));

  const eventsJsonl = snapshot.events.map((event) => JSON.stringify(event)).join('\n');
  zip.file('events/events.jsonl', eventsJsonl);

  for (const atom of snapshot.atoms) {
    const frontmatter = [
      '---',
      `atomId: ${atom.atomId}`,
      `createdAtMs: ${atom.createdAtMs}`,
      `updatedAtMs: ${atom.updatedAtMs}`,
      `needsResolution: ${atom.needsResolution}`,
      '---',
      '',
    ].join('\n');

    zip.file(`atoms/${atom.atomId}.md`, `${frontmatter}${atom.body}`);
  }

  zip.file('portable/state.json', JSON.stringify({
    atoms: snapshot.atoms,
    atomVersions: snapshot.atomVersions,
    conflicts: snapshot.conflicts,
  }, null, 2));

  for (const blob of snapshot.blobs) {
    if (!blob.isPresent || !fs.existsSync(blob.localPath)) {
      continue;
    }
    const content = fs.readFileSync(blob.localPath);
    const extension = extensionFromContentType(blob.contentType);
    zip.file(`blobs/${blob.hash}${extension}`, content);
  }

  return zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
  });
}

function extensionFromContentType(contentType: string): string {
  const normalized = contentType.toLowerCase();
  if (normalized.includes('png')) return '.png';
  if (normalized.includes('jpeg') || normalized.includes('jpg')) return '.jpg';
  if (normalized.includes('webp')) return '.webp';
  if (normalized.includes('webm')) return '.webm';
  if (normalized.includes('mp4')) return '.mp4';
  if (normalized.includes('mpeg')) return '.mp3';
  if (normalized.includes('wav')) return '.wav';
  return '.bin';
}
