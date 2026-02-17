import * as fs from 'node:fs';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  BlobManifestEntry,
  DeviceState,
  EventServerSeqMapping,
  ProjectionSnapshot,
  StorageAdapter,
  StoredEvent,
  SyncAttempt,
  SyncError,
  SyncItemStatus,
} from '@seedworld/core';

interface AdapterConfig {
  dbPath: string;
  workspaceId: string;
  userId: string;
  deviceId: string;
}

function parseJson<T>(raw: string): T {
  return JSON.parse(raw) as T;
}

export class DesktopSqliteStorageAdapter implements StorageAdapter {
  private readonly db: DatabaseSync;

  private readonly workspaceId: string;

  constructor(config: AdapterConfig) {
    const dbDir = path.dirname(config.dbPath);
    fs.mkdirSync(dbDir, { recursive: true });

    this.db = new DatabaseSync(config.dbPath);
    this.workspaceId = config.workspaceId;

    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=NORMAL;

      CREATE TABLE IF NOT EXISTS device_state (
        workspace_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        next_local_seq INTEGER NOT NULL,
        last_pulled_seq INTEGER NOT NULL,
        last_applied_seq INTEGER NOT NULL,
        projection_dirty INTEGER NOT NULL,
        last_sync_success_at_ms INTEGER,
        last_error_code TEXT,
        last_error_message TEXT
      );

      CREATE TABLE IF NOT EXISTS events (
        workspace_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        event_schema_version INTEGER NOT NULL,
        payload_schema_version INTEGER,
        type TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        device_id TEXT NOT NULL,
        local_seq INTEGER,
        server_seq INTEGER,
        payload_json TEXT NOT NULL,
        sync_status TEXT NOT NULL,
        error_code TEXT,
        error_message TEXT,
        PRIMARY KEY (workspace_id, event_id)
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_events_workspace_event
        ON events(workspace_id, event_id);

      CREATE UNIQUE INDEX IF NOT EXISTS idx_events_workspace_server_seq
        ON events(workspace_id, server_seq)
        WHERE server_seq IS NOT NULL;

      CREATE TABLE IF NOT EXISTS atoms (
        workspace_id TEXT NOT NULL,
        atom_id TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        capture_event_id TEXT NOT NULL,
        head_version_ids_json TEXT NOT NULL,
        needs_resolution INTEGER NOT NULL,
        blob_hashes_json TEXT NOT NULL,
        PRIMARY KEY (workspace_id, atom_id)
      );

      CREATE TABLE IF NOT EXISTS atom_versions (
        workspace_id TEXT NOT NULL,
        version_id TEXT NOT NULL,
        atom_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        parent_version_id TEXT,
        body TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        server_seq INTEGER,
        local_seq INTEGER,
        PRIMARY KEY (workspace_id, version_id)
      );

      CREATE TABLE IF NOT EXISTS conflicts (
        workspace_id TEXT NOT NULL,
        conflict_id TEXT NOT NULL,
        atom_id TEXT NOT NULL,
        version_ids_json TEXT NOT NULL,
        reason TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        PRIMARY KEY (workspace_id, conflict_id)
      );

      CREATE TABLE IF NOT EXISTS inbox_items (
        workspace_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        atom_id TEXT NOT NULL,
        title TEXT NOT NULL,
        preview TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        source_event_id TEXT NOT NULL,
        sync_status TEXT NOT NULL,
        needs_resolution INTEGER NOT NULL,
        server_seq INTEGER,
        PRIMARY KEY (workspace_id, item_id)
      );

      CREATE TABLE IF NOT EXISTS projection_meta (
        workspace_id TEXT PRIMARY KEY,
        generated_at_ms INTEGER NOT NULL,
        last_applied_seq INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS blob_manifest (
        workspace_id TEXT NOT NULL,
        hash TEXT NOT NULL,
        size INTEGER NOT NULL,
        content_type TEXT NOT NULL,
        local_path TEXT NOT NULL,
        is_present INTEGER NOT NULL,
        sync_status TEXT NOT NULL,
        error_code TEXT,
        error_message TEXT,
        updated_at_ms INTEGER NOT NULL,
        PRIMARY KEY (workspace_id, hash)
      );

      CREATE TABLE IF NOT EXISTS sync_attempts (
        workspace_id TEXT NOT NULL,
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp_ms INTEGER NOT NULL,
        action TEXT NOT NULL,
        result TEXT NOT NULL,
        error_code TEXT,
        message TEXT
      );
    `);

    const existingState = this.db
      .prepare(`SELECT workspace_id FROM device_state WHERE workspace_id = ?`)
      .get(this.workspaceId) as { workspace_id: string } | undefined;

    if (!existingState) {
      this.db
        .prepare(
          `INSERT INTO device_state(
            workspace_id, user_id, device_id, next_local_seq,
            last_pulled_seq, last_applied_seq, projection_dirty
          ) VALUES (?, ?, ?, 1, 0, 0, 0)`
        )
        .run(this.workspaceId, config.userId, config.deviceId);
    }
  }

  async getDeviceState(): Promise<DeviceState> {
    const row = this.db
      .prepare(
        `SELECT
          workspace_id,
          user_id,
          device_id,
          next_local_seq,
          last_pulled_seq,
          last_applied_seq,
          projection_dirty,
          last_sync_success_at_ms,
          last_error_code,
          last_error_message
        FROM device_state
        WHERE workspace_id = ?`
      )
      .get(this.workspaceId) as {
      workspace_id: string;
      user_id: string;
      device_id: string;
      next_local_seq: number;
      last_pulled_seq: number;
      last_applied_seq: number;
      projection_dirty: number;
      last_sync_success_at_ms: number | null;
      last_error_code: DeviceState['lastErrorCode'] | null;
      last_error_message: string | null;
    };

    return {
      workspaceId: row.workspace_id,
      userId: row.user_id,
      deviceId: row.device_id,
      nextLocalSeq: row.next_local_seq,
      lastPulledSeq: row.last_pulled_seq,
      lastAppliedSeq: row.last_applied_seq,
      projectionDirty: row.projection_dirty === 1,
      lastSyncSuccessAtMs: row.last_sync_success_at_ms ?? undefined,
      lastErrorCode: row.last_error_code ?? undefined,
      lastErrorMessage: row.last_error_message ?? undefined,
    };
  }

  async saveDeviceState(state: DeviceState): Promise<void> {
    this.db
      .prepare(
        `UPDATE device_state
         SET
           user_id = ?,
           device_id = ?,
           next_local_seq = ?,
           last_pulled_seq = ?,
           last_applied_seq = ?,
           projection_dirty = ?,
           last_sync_success_at_ms = ?,
           last_error_code = ?,
           last_error_message = ?
         WHERE workspace_id = ?`
      )
      .run(
        state.userId,
        state.deviceId,
        state.nextLocalSeq,
        state.lastPulledSeq,
        state.lastAppliedSeq,
        state.projectionDirty ? 1 : 0,
        state.lastSyncSuccessAtMs ?? null,
        state.lastErrorCode ?? null,
        state.lastErrorMessage ?? null,
        this.workspaceId,
      );
  }

  async allocateLocalSeq(): Promise<number> {
    this.db.exec('BEGIN');
    try {
      const row = this.db
        .prepare(`SELECT next_local_seq FROM device_state WHERE workspace_id = ?`)
        .get(this.workspaceId) as { next_local_seq: number };
      const next = row.next_local_seq;
      this.db
        .prepare(`UPDATE device_state SET next_local_seq = ? WHERE workspace_id = ?`)
        .run(next + 1, this.workspaceId);
      this.db.exec('COMMIT');
      return next;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  async upsertEvents(events: StoredEvent[]): Promise<void> {
    const statement = this.db.prepare(
      `INSERT INTO events(
        workspace_id, event_id, event_schema_version, payload_schema_version, type,
        created_at_ms, device_id, local_seq, server_seq, payload_json,
        sync_status, error_code, error_message
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(workspace_id, event_id)
      DO UPDATE SET
        server_seq = COALESCE(excluded.server_seq, events.server_seq),
        sync_status = excluded.sync_status,
        error_code = excluded.error_code,
        error_message = excluded.error_message,
        local_seq = COALESCE(events.local_seq, excluded.local_seq)`
    );

    this.db.exec('BEGIN');
    try {
      for (const event of events) {
        statement.run(
          this.workspaceId,
          event.eventId,
          event.eventSchemaVersion,
          event.payloadSchemaVersion ?? null,
          event.type,
          event.createdAtMs,
          event.deviceId,
          event.localSeq ?? null,
          event.serverSeq ?? null,
          JSON.stringify(event.payload),
          event.syncStatus,
          event.errorCode ?? null,
          event.errorMessage ?? null,
        );
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  async listEvents(): Promise<StoredEvent[]> {
    const rows = this.db
      .prepare(
        `SELECT
          event_id,
          event_schema_version,
          payload_schema_version,
          type,
          created_at_ms,
          device_id,
          local_seq,
          server_seq,
          payload_json,
          sync_status,
          error_code,
          error_message
         FROM events
         WHERE workspace_id = ?
         ORDER BY
           CASE WHEN server_seq IS NULL THEN 1 ELSE 0 END,
           server_seq ASC,
           local_seq ASC,
           created_at_ms ASC,
           event_id ASC`
      )
      .all(this.workspaceId) as Array<{
      event_id: string;
      event_schema_version: number;
      payload_schema_version: number | null;
      type: string;
      created_at_ms: number;
      device_id: string;
      local_seq: number | null;
      server_seq: number | null;
      payload_json: string;
      sync_status: SyncItemStatus;
      error_code: StoredEvent['errorCode'] | null;
      error_message: string | null;
    }>;

    return rows.map((row) => ({
      eventId: row.event_id,
      eventSchemaVersion: row.event_schema_version,
      payloadSchemaVersion: row.payload_schema_version ?? undefined,
      type: row.type as StoredEvent['type'],
      createdAtMs: row.created_at_ms,
      deviceId: row.device_id,
      workspaceId: this.workspaceId,
      localSeq: row.local_seq ?? undefined,
      serverSeq: row.server_seq ?? undefined,
      payload: parseJson(row.payload_json),
      syncStatus: row.sync_status,
      errorCode: row.error_code ?? undefined,
      errorMessage: row.error_message ?? undefined,
    }));
  }

  async assignServerSeq(mappings: EventServerSeqMapping[]): Promise<boolean> {
    let changed = false;

    const statement = this.db.prepare(
      `UPDATE events
       SET server_seq = ?, sync_status = 'synced', error_code = NULL, error_message = NULL
       WHERE workspace_id = ? AND event_id = ? AND (server_seq IS NULL OR server_seq != ?)`
    );

    this.db.exec('BEGIN');
    try {
      for (const mapping of mappings) {
        const result = statement.run(mapping.serverSeq, this.workspaceId, mapping.eventId, mapping.serverSeq);
        if (result.changes > 0) {
          changed = true;
        }
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }

    return changed;
  }

  async listPendingEvents(limit = 200): Promise<StoredEvent[]> {
    const rows = this.db
      .prepare(
        `SELECT
          event_id,
          event_schema_version,
          payload_schema_version,
          type,
          created_at_ms,
          device_id,
          local_seq,
          server_seq,
          payload_json,
          sync_status,
          error_code,
          error_message
         FROM events
         WHERE workspace_id = ? AND server_seq IS NULL
         ORDER BY local_seq ASC, created_at_ms ASC, event_id ASC
         LIMIT ?`
      )
      .all(this.workspaceId, limit) as Array<{
      event_id: string;
      event_schema_version: number;
      payload_schema_version: number | null;
      type: string;
      created_at_ms: number;
      device_id: string;
      local_seq: number | null;
      server_seq: number | null;
      payload_json: string;
      sync_status: SyncItemStatus;
      error_code: StoredEvent['errorCode'] | null;
      error_message: string | null;
    }>;

    return rows.map((row) => ({
      eventId: row.event_id,
      eventSchemaVersion: row.event_schema_version,
      payloadSchemaVersion: row.payload_schema_version ?? undefined,
      type: row.type as StoredEvent['type'],
      createdAtMs: row.created_at_ms,
      deviceId: row.device_id,
      workspaceId: this.workspaceId,
      localSeq: row.local_seq ?? undefined,
      serverSeq: row.server_seq ?? undefined,
      payload: parseJson(row.payload_json),
      syncStatus: row.sync_status,
      errorCode: row.error_code ?? undefined,
      errorMessage: row.error_message ?? undefined,
    }));
  }

  async updateEventStatus(eventId: string, status: SyncItemStatus, error?: SyncError | null): Promise<void> {
    this.db
      .prepare(
        `UPDATE events
         SET sync_status = ?, error_code = ?, error_message = ?
         WHERE workspace_id = ? AND event_id = ?`
      )
      .run(status, error?.code ?? null, error?.message ?? null, this.workspaceId, eventId);
  }

  async saveProjection(snapshot: ProjectionSnapshot): Promise<void> {
    this.db.exec('BEGIN');
    try {
      this.db.prepare(`DELETE FROM atoms WHERE workspace_id = ?`).run(this.workspaceId);
      this.db.prepare(`DELETE FROM atom_versions WHERE workspace_id = ?`).run(this.workspaceId);
      this.db.prepare(`DELETE FROM conflicts WHERE workspace_id = ?`).run(this.workspaceId);
      this.db.prepare(`DELETE FROM inbox_items WHERE workspace_id = ?`).run(this.workspaceId);

      const atomStatement = this.db.prepare(
        `INSERT INTO atoms(
          workspace_id, atom_id, title, body, created_at_ms, updated_at_ms,
          capture_event_id, head_version_ids_json, needs_resolution, blob_hashes_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );

      for (const atom of snapshot.atoms) {
        atomStatement.run(
          this.workspaceId,
          atom.atomId,
          atom.title,
          atom.body,
          atom.createdAtMs,
          atom.updatedAtMs,
          atom.captureEventId,
          JSON.stringify(atom.headVersionIds),
          atom.needsResolution ? 1 : 0,
          JSON.stringify(atom.blobHashes),
        );
      }

      const versionStatement = this.db.prepare(
        `INSERT INTO atom_versions(
          workspace_id, version_id, atom_id, event_id, parent_version_id,
          body, created_at_ms, server_seq, local_seq
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );

      for (const version of snapshot.atomVersions) {
        versionStatement.run(
          this.workspaceId,
          version.versionId,
          version.atomId,
          version.eventId,
          version.parentVersionId ?? null,
          version.body,
          version.createdAtMs,
          version.serverSeq ?? null,
          version.localSeq ?? null,
        );
      }

      const conflictStatement = this.db.prepare(
        `INSERT INTO conflicts(
          workspace_id, conflict_id, atom_id, version_ids_json, reason,
          status, created_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      );

      for (const conflict of snapshot.conflicts) {
        conflictStatement.run(
          this.workspaceId,
          conflict.conflictId,
          conflict.atomId,
          JSON.stringify(conflict.versionIds),
          conflict.reason,
          conflict.status,
          conflict.createdAtMs,
          conflict.updatedAtMs,
        );
      }

      const inboxStatement = this.db.prepare(
        `INSERT INTO inbox_items(
          workspace_id, item_id, atom_id, title, preview, created_at_ms,
          updated_at_ms, source_event_id, sync_status, needs_resolution, server_seq
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );

      for (const item of snapshot.inbox) {
        inboxStatement.run(
          this.workspaceId,
          item.id,
          item.atomId,
          item.title,
          item.preview,
          item.createdAtMs,
          item.updatedAtMs,
          item.sourceEventId,
          item.syncStatus,
          item.needsResolution ? 1 : 0,
          item.serverSeq ?? null,
        );
      }

      this.db
        .prepare(
          `INSERT INTO projection_meta(workspace_id, generated_at_ms, last_applied_seq)
           VALUES (?, ?, ?)
           ON CONFLICT(workspace_id)
           DO UPDATE SET generated_at_ms = excluded.generated_at_ms, last_applied_seq = excluded.last_applied_seq`
        )
        .run(this.workspaceId, snapshot.generatedAtMs, snapshot.lastAppliedSeq);

      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  async getProjection(): Promise<ProjectionSnapshot | null> {
    const meta = this.db
      .prepare(`SELECT generated_at_ms, last_applied_seq FROM projection_meta WHERE workspace_id = ?`)
      .get(this.workspaceId) as { generated_at_ms: number; last_applied_seq: number } | undefined;

    if (!meta) {
      return null;
    }

    const atoms = this.db
      .prepare(
        `SELECT atom_id, title, body, created_at_ms, updated_at_ms, capture_event_id, head_version_ids_json, needs_resolution, blob_hashes_json
         FROM atoms
         WHERE workspace_id = ?`
      )
      .all(this.workspaceId) as Array<{
      atom_id: string;
      title: string;
      body: string;
      created_at_ms: number;
      updated_at_ms: number;
      capture_event_id: string;
      head_version_ids_json: string;
      needs_resolution: number;
      blob_hashes_json: string;
    }>;

    const versions = this.db
      .prepare(
        `SELECT atom_id, version_id, event_id, parent_version_id, body, created_at_ms, server_seq, local_seq
         FROM atom_versions
         WHERE workspace_id = ?`
      )
      .all(this.workspaceId) as Array<{
      atom_id: string;
      version_id: string;
      event_id: string;
      parent_version_id: string | null;
      body: string;
      created_at_ms: number;
      server_seq: number | null;
      local_seq: number | null;
    }>;

    const conflicts = this.db
      .prepare(
        `SELECT conflict_id, atom_id, version_ids_json, reason, status, created_at_ms, updated_at_ms
         FROM conflicts
         WHERE workspace_id = ?`
      )
      .all(this.workspaceId) as Array<{
      conflict_id: string;
      atom_id: string;
      version_ids_json: string;
      reason: 'concurrent_update';
      status: 'open' | 'resolved';
      created_at_ms: number;
      updated_at_ms: number;
    }>;

    const inbox = this.db
      .prepare(
        `SELECT item_id, atom_id, title, preview, created_at_ms, updated_at_ms, source_event_id, sync_status, needs_resolution, server_seq
         FROM inbox_items
         WHERE workspace_id = ?
         ORDER BY created_at_ms DESC, item_id ASC`
      )
      .all(this.workspaceId) as Array<{
      item_id: string;
      atom_id: string;
      title: string;
      preview: string;
      created_at_ms: number;
      updated_at_ms: number;
      source_event_id: string;
      sync_status: SyncItemStatus;
      needs_resolution: number;
      server_seq: number | null;
    }>;

    return {
      generatedAtMs: meta.generated_at_ms,
      lastAppliedSeq: meta.last_applied_seq,
      atoms: atoms.map((atom) => ({
        atomId: atom.atom_id,
        title: atom.title,
        body: atom.body,
        createdAtMs: atom.created_at_ms,
        updatedAtMs: atom.updated_at_ms,
        captureEventId: atom.capture_event_id,
        headVersionIds: parseJson<string[]>(atom.head_version_ids_json),
        needsResolution: atom.needs_resolution === 1,
        blobHashes: parseJson<string[]>(atom.blob_hashes_json),
      })),
      atomVersions: versions.map((version) => ({
        atomId: version.atom_id,
        versionId: version.version_id,
        eventId: version.event_id,
        parentVersionId: version.parent_version_id ?? undefined,
        body: version.body,
        createdAtMs: version.created_at_ms,
        serverSeq: version.server_seq ?? undefined,
        localSeq: version.local_seq ?? undefined,
      })),
      conflicts: conflicts.map((conflict) => ({
        conflictId: conflict.conflict_id,
        atomId: conflict.atom_id,
        versionIds: parseJson<string[]>(conflict.version_ids_json),
        reason: conflict.reason,
        status: conflict.status,
        createdAtMs: conflict.created_at_ms,
        updatedAtMs: conflict.updated_at_ms,
      })),
      inbox: inbox.map((item) => ({
        id: item.item_id,
        atomId: item.atom_id,
        title: item.title,
        preview: item.preview,
        createdAtMs: item.created_at_ms,
        updatedAtMs: item.updated_at_ms,
        sourceEventId: item.source_event_id,
        syncStatus: item.sync_status,
        needsResolution: item.needs_resolution === 1,
        serverSeq: item.server_seq ?? undefined,
      })),
      referencedBlobs: Array.from(
        new Set(
          atoms.flatMap((atom) => parseJson<string[]>(atom.blob_hashes_json)),
        ),
      ).sort(),
    };
  }

  async saveBlobManifest(entries: BlobManifestEntry[]): Promise<void> {
    const statement = this.db.prepare(
      `INSERT INTO blob_manifest(
        workspace_id, hash, size, content_type, local_path, is_present,
        sync_status, error_code, error_message, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(workspace_id, hash)
      DO UPDATE SET
        size = excluded.size,
        content_type = excluded.content_type,
        local_path = excluded.local_path,
        is_present = excluded.is_present,
        sync_status = excluded.sync_status,
        error_code = excluded.error_code,
        error_message = excluded.error_message,
        updated_at_ms = excluded.updated_at_ms`
    );

    this.db.exec('BEGIN');
    try {
      for (const entry of entries) {
        statement.run(
          this.workspaceId,
          entry.hash,
          entry.size,
          entry.contentType,
          entry.localPath,
          entry.isPresent ? 1 : 0,
          entry.syncStatus,
          entry.errorCode ?? null,
          entry.errorMessage ?? null,
          entry.updatedAtMs,
        );
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  async listBlobManifest(): Promise<BlobManifestEntry[]> {
    const rows = this.db
      .prepare(
        `SELECT hash, size, content_type, local_path, is_present, sync_status, error_code, error_message, updated_at_ms
         FROM blob_manifest
         WHERE workspace_id = ?`
      )
      .all(this.workspaceId) as Array<{
      hash: string;
      size: number;
      content_type: string;
      local_path: string;
      is_present: number;
      sync_status: SyncItemStatus;
      error_code: BlobManifestEntry['errorCode'] | null;
      error_message: string | null;
      updated_at_ms: number;
    }>;

    return rows.map((row) => ({
      hash: row.hash,
      size: row.size,
      contentType: row.content_type,
      localPath: row.local_path,
      isPresent: row.is_present === 1,
      syncStatus: row.sync_status,
      errorCode: row.error_code ?? undefined,
      errorMessage: row.error_message ?? undefined,
      updatedAtMs: row.updated_at_ms,
    }));
  }

  async saveSyncAttempt(attempt: SyncAttempt): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO sync_attempts(workspace_id, timestamp_ms, action, result, error_code, message)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        this.workspaceId,
        attempt.timestampMs,
        attempt.action,
        attempt.result,
        attempt.errorCode ?? null,
        attempt.message ?? null,
      );
  }

  async listSyncAttempts(limit: number): Promise<SyncAttempt[]> {
    const rows = this.db
      .prepare(
        `SELECT timestamp_ms, action, result, error_code, message
         FROM sync_attempts
         WHERE workspace_id = ?
         ORDER BY id DESC
         LIMIT ?`
      )
      .all(this.workspaceId, limit) as Array<{
      timestamp_ms: number;
      action: string;
      result: 'success' | 'error';
      error_code: SyncAttempt['errorCode'] | null;
      message: string | null;
    }>;

    return rows.map((row) => ({
      timestampMs: row.timestamp_ms,
      action: row.action,
      result: row.result,
      errorCode: row.error_code ?? undefined,
      message: row.message ?? undefined,
    }));
  }
}
