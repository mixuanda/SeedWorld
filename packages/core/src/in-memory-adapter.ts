import {
  type BlobManifestEntry,
  type DeviceState,
  type EventServerSeqMapping,
  type ProjectionSnapshot,
  type StorageAdapter,
  type StoredEvent,
  type SyncAttempt,
  type SyncError,
  type SyncItemStatus,
} from './types.js';

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export class InMemoryStorageAdapter implements StorageAdapter {
  private state: DeviceState;

  private readonly events = new Map<string, StoredEvent>();

  private projection: ProjectionSnapshot | null = null;

  private blobManifest = new Map<string, BlobManifestEntry>();

  private attempts: SyncAttempt[] = [];

  constructor(state: DeviceState) {
    this.state = { ...state };
  }

  async getDeviceState(): Promise<DeviceState> {
    return clone(this.state);
  }

  async saveDeviceState(state: DeviceState): Promise<void> {
    this.state = clone(state);
  }

  async allocateLocalSeq(): Promise<number> {
    const next = this.state.nextLocalSeq;
    this.state.nextLocalSeq += 1;
    return next;
  }

  async upsertEvents(events: StoredEvent[]): Promise<void> {
    for (const event of events) {
      const existing = this.events.get(event.eventId);
      if (!existing) {
        this.events.set(event.eventId, clone(event));
        continue;
      }

      const merged: StoredEvent = {
        ...existing,
        ...event,
        serverSeq:
          typeof event.serverSeq === 'number'
            ? event.serverSeq
            : typeof existing.serverSeq === 'number'
              ? existing.serverSeq
              : undefined,
        syncStatus: event.syncStatus || existing.syncStatus,
      };

      this.events.set(event.eventId, merged);
    }
  }

  async listEvents(): Promise<StoredEvent[]> {
    return Array.from(this.events.values()).map((event) => clone(event));
  }

  async assignServerSeq(mappings: EventServerSeqMapping[]): Promise<boolean> {
    let changed = false;

    for (const mapping of mappings) {
      const existing = this.events.get(mapping.eventId);
      if (!existing) {
        continue;
      }

      if (existing.serverSeq !== mapping.serverSeq) {
        existing.serverSeq = mapping.serverSeq;
        existing.syncStatus = 'synced';
        this.events.set(mapping.eventId, existing);
        changed = true;
      }
    }

    return changed;
  }

  async listPendingEvents(limit = 200): Promise<StoredEvent[]> {
    const pending = Array.from(this.events.values())
      .filter((event) => typeof event.serverSeq !== 'number')
      .sort((a, b) => {
        const aLocal = a.localSeq ?? Number.MAX_SAFE_INTEGER;
        const bLocal = b.localSeq ?? Number.MAX_SAFE_INTEGER;
        if (aLocal !== bLocal) {
          return aLocal - bLocal;
        }
        return a.eventId.localeCompare(b.eventId);
      })
      .slice(0, limit)
      .map((event) => clone(event));

    return pending;
  }

  async updateEventStatus(eventId: string, status: SyncItemStatus, error?: SyncError | null): Promise<void> {
    const event = this.events.get(eventId);
    if (!event) {
      return;
    }
    event.syncStatus = status;
    event.errorCode = error?.code;
    event.errorMessage = error?.message;
    this.events.set(eventId, event);
  }

  async saveProjection(snapshot: ProjectionSnapshot): Promise<void> {
    this.projection = clone(snapshot);
  }

  async getProjection(): Promise<ProjectionSnapshot | null> {
    return this.projection ? clone(this.projection) : null;
  }

  async saveBlobManifest(entries: BlobManifestEntry[]): Promise<void> {
    for (const entry of entries) {
      this.blobManifest.set(entry.hash, clone(entry));
    }
  }

  async listBlobManifest(): Promise<BlobManifestEntry[]> {
    return Array.from(this.blobManifest.values()).map((entry) => clone(entry));
  }

  async saveSyncAttempt(attempt: SyncAttempt): Promise<void> {
    this.attempts = [attempt, ...this.attempts].slice(0, 200);
  }

  async listSyncAttempts(limit: number): Promise<SyncAttempt[]> {
    return this.attempts.slice(0, limit).map((attempt) => clone(attempt));
  }
}
