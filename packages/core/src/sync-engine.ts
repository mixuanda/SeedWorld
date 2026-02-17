import { createEvent, withStoredMetadata } from './events.js';
import { migrateEvent } from './migrations.js';
import { buildProjection } from './projection.js';
import {
  type DeviceState,
  type Event,
  type EventDraft,
  type PullResponse,
  type StorageAdapter,
  type StoredEvent,
  type SyncError,
  type SyncErrorCode,
  type SyncStatus,
  type SyncTransport,
} from './types.js';

function mapErrorCode(error: unknown): SyncErrorCode {
  if (!(error instanceof Error)) {
    return 'SERVER_ERROR';
  }
  const message = error.message.toLowerCase();
  if (message.includes('auth') || message.includes('401') || message.includes('403')) {
    return 'AUTH';
  }
  if (message.includes('hash')) {
    return 'HASH_MISMATCH';
  }
  if (message.includes('quota')) {
    return 'QUOTA';
  }
  if (message.includes('disk') || message.includes('enospc')) {
    return 'DISK_FULL';
  }
  if (message.includes('network') || message.includes('fetch')) {
    return 'NETWORK';
  }
  return 'SERVER_ERROR';
}

function toSyncError(error: unknown): SyncError {
  if (error instanceof Error) {
    return {
      code: mapErrorCode(error),
      message: error.message,
    };
  }

  return {
    code: 'SERVER_ERROR',
    message: 'Unknown sync failure',
  };
}

export interface SyncEngineOptions {
  storage: StorageAdapter;
  transport: SyncTransport;
}

export class SyncEngine {
  private readonly storage: StorageAdapter;

  private readonly transport: SyncTransport;

  constructor(options: SyncEngineOptions) {
    this.storage = options.storage;
    this.transport = options.transport;
  }

  async appendLocalEvent<TType extends Event['type']>(draft: EventDraft<TType>): Promise<StoredEvent> {
    const state = await this.storage.getDeviceState();
    const localSeq = await this.storage.allocateLocalSeq();
    state.nextLocalSeq = Math.max(state.nextLocalSeq, localSeq + 1);

    const event = createEvent({
      draft,
      deviceId: state.deviceId,
      workspaceId: state.workspaceId,
      localSeq,
    });

    const storedEvent = withStoredMetadata(event);
    await this.storage.upsertEvents([storedEvent]);

    state.projectionDirty = true;
    await this.storage.saveDeviceState(state);
    await this.rebuildProjection();

    return storedEvent;
  }

  async captureText(input: { atomId: string; body: string; title?: string }): Promise<StoredEvent> {
    return this.appendLocalEvent({
      type: 'capture.text.create',
      payload: {
        atomId: input.atomId,
        body: input.body,
        title: input.title,
      },
    });
  }

  async rebuildProjection(): Promise<void> {
    const state = await this.storage.getDeviceState();
    const events = await this.storage.listEvents();
    const projection = buildProjection(events);

    await this.storage.saveProjection(projection);
    state.lastAppliedSeq = projection.lastAppliedSeq;
    state.projectionDirty = false;
    await this.storage.saveDeviceState(state);
  }

  async getInbox() {
    const projection = await this.storage.getProjection();
    if (projection) {
      return projection.inbox;
    }

    await this.rebuildProjection();
    return (await this.storage.getProjection())?.inbox ?? [];
  }

  async getSyncStatus(): Promise<SyncStatus> {
    const state = await this.storage.getDeviceState();
    const pendingEvents = await this.storage.listPendingEvents();
    const blobs = await this.storage.listBlobManifest();
    const pendingBlobs = blobs.filter((blob) => !blob.isPresent || blob.syncStatus !== 'synced').length;

    return {
      lastSuccessAtMs: state.lastSyncSuccessAtMs,
      pendingEvents: pendingEvents.length,
      pendingBlobs,
      lastError:
        state.lastErrorCode && state.lastErrorMessage
          ? {
              code: state.lastErrorCode,
              message: state.lastErrorMessage,
            }
          : undefined,
      lastPulledSeq: state.lastPulledSeq,
      lastAppliedSeq: state.lastAppliedSeq,
    };
  }

  async syncNow(): Promise<SyncStatus> {
    let state = await this.storage.getDeviceState();
    let projectionDirty = state.projectionDirty;
    const pullCursor = state.lastPulledSeq;
    let cursorAfterPush = state.lastPulledSeq;

    try {
      const pending = await this.storage.listPendingEvents();

      if (pending.length > 0) {
        for (const event of pending) {
          await this.storage.updateEventStatus(event.eventId, 'syncing');
        }

        const response = await this.transport.push({
          workspaceId: state.workspaceId,
          userId: state.userId,
          deviceId: state.deviceId,
          clientCursor: state.lastPulledSeq,
          events: pending.map(stripStoredMetadata),
        });

        if (response.accepted.length > 0) {
          const changed = await this.storage.assignServerSeq(response.accepted);
          projectionDirty ||= changed;

          for (const mapping of response.accepted) {
            await this.storage.updateEventStatus(mapping.eventId, 'synced');
          }
        }

        cursorAfterPush = Math.max(cursorAfterPush, response.cursor);
      }

      const pullResponse = await this.transport.pull({
        workspaceId: state.workspaceId,
        userId: state.userId,
        deviceId: state.deviceId,
        cursor: pullCursor,
      });

      const pullChanged = await this.ingestPullEvents(pullResponse);
      projectionDirty = projectionDirty || pullChanged;

      state.lastPulledSeq = Math.max(cursorAfterPush, pullResponse.cursor, state.lastPulledSeq);

      if (projectionDirty) {
        state.projectionDirty = true;
        await this.storage.saveDeviceState(state);
        await this.rebuildProjection();
        state = await this.storage.getDeviceState();
        state.lastPulledSeq = Math.max(state.lastPulledSeq, cursorAfterPush, pullResponse.cursor);
      } else {
        state.projectionDirty = false;
      }

      state.lastSyncSuccessAtMs = Date.now();
      state.lastErrorCode = undefined;
      state.lastErrorMessage = undefined;
      await this.storage.saveDeviceState(state);
      await this.storage.saveSyncAttempt({
        timestampMs: Date.now(),
        action: 'sync',
        result: 'success',
      });

      return this.getSyncStatus();
    } catch (error) {
      const syncError = toSyncError(error);
      state.lastErrorCode = syncError.code;
      state.lastErrorMessage = syncError.message;
      await this.storage.saveDeviceState(state);
      await this.storage.saveSyncAttempt({
        timestampMs: Date.now(),
        action: 'sync',
        result: 'error',
        errorCode: syncError.code,
        message: syncError.message,
      });
      throw error;
    }
  }

  private async ingestPullEvents(response: PullResponse): Promise<boolean> {
    if (response.events.length === 0) {
      return false;
    }

    const migrated = response.events.map((event) => migrateEvent(event));
    const stored: StoredEvent[] = migrated.map((event) => ({
      ...event,
      syncStatus: 'synced',
    }));

    await this.storage.upsertEvents(stored);

    const mappings = migrated
      .filter((event): event is Event & { serverSeq: number } => typeof event.serverSeq === 'number')
      .map((event) => ({ eventId: event.eventId, serverSeq: event.serverSeq }));

    if (mappings.length === 0) {
      return true;
    }

    const changed = await this.storage.assignServerSeq(mappings);
    return changed || response.events.length > 0;
  }
}

function stripStoredMetadata(event: StoredEvent): Event {
  const {
    syncStatus: _syncStatus,
    errorCode: _errorCode,
    errorMessage: _errorMessage,
    ...immutable
  } = event;

  return immutable;
}
