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

interface PersistedState {
  deviceState: DeviceState;
  events: StoredEvent[];
  projection: ProjectionSnapshot | null;
  blobs: BlobManifestEntry[];
  attempts: SyncAttempt[];
}

const DB_NAME = 'seedworld-web';
const STORE_NAME = 'kv';

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

async function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Failed to open IndexedDB'));
  });
}

async function readPersistedState(defaultState: DeviceState): Promise<PersistedState> {
  const db = await openDatabase();
  try {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);

    const state = await new Promise<PersistedState | null>((resolve, reject) => {
      const getRequest = store.get(defaultState.workspaceId);
      getRequest.onsuccess = () => resolve((getRequest.result as PersistedState) || null);
      getRequest.onerror = () => reject(getRequest.error || new Error('Failed to read state'));
    });

    if (state) {
      return state;
    }

    return {
      deviceState: defaultState,
      events: [],
      projection: null,
      blobs: [],
      attempts: [],
    };
  } finally {
    db.close();
  }
}

async function writePersistedState(workspaceId: string, state: PersistedState): Promise<void> {
  const db = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put(state, workspaceId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('Failed to write state'));
      tx.onabort = () => reject(tx.error || new Error('Failed to write state'));
    });
  } finally {
    db.close();
  }
}

export class IndexedDbStorageAdapter implements StorageAdapter {
  private readonly workspaceId: string;

  private state: PersistedState;

  private constructor(workspaceId: string, state: PersistedState) {
    this.workspaceId = workspaceId;
    this.state = state;
  }

  static async create(deviceState: DeviceState): Promise<IndexedDbStorageAdapter> {
    const persisted = await readPersistedState(deviceState);
    return new IndexedDbStorageAdapter(deviceState.workspaceId, persisted);
  }

  private async persist(): Promise<void> {
    await writePersistedState(this.workspaceId, this.state);
  }

  async getDeviceState(): Promise<DeviceState> {
    return clone(this.state.deviceState);
  }

  async saveDeviceState(state: DeviceState): Promise<void> {
    this.state.deviceState = clone(state);
    await this.persist();
  }

  async allocateLocalSeq(): Promise<number> {
    const next = this.state.deviceState.nextLocalSeq;
    this.state.deviceState.nextLocalSeq += 1;
    await this.persist();
    return next;
  }

  async upsertEvents(events: StoredEvent[]): Promise<void> {
    const map = new Map(this.state.events.map((event) => [event.eventId, event]));

    for (const event of events) {
      const existing = map.get(event.eventId);
      if (!existing) {
        map.set(event.eventId, clone(event));
        continue;
      }

      map.set(event.eventId, {
        ...existing,
        ...clone(event),
        serverSeq: typeof event.serverSeq === 'number' ? event.serverSeq : existing.serverSeq,
      });
    }

    this.state.events = Array.from(map.values());
    await this.persist();
  }

  async listEvents(): Promise<StoredEvent[]> {
    return clone(this.state.events);
  }

  async assignServerSeq(mappings: EventServerSeqMapping[]): Promise<boolean> {
    let changed = false;

    const byId = new Map(this.state.events.map((event) => [event.eventId, event]));

    for (const mapping of mappings) {
      const event = byId.get(mapping.eventId);
      if (!event) {
        continue;
      }

      if (event.serverSeq !== mapping.serverSeq) {
        event.serverSeq = mapping.serverSeq;
        event.syncStatus = 'synced';
        byId.set(mapping.eventId, event);
        changed = true;
      }
    }

    if (changed) {
      this.state.events = Array.from(byId.values());
      await this.persist();
    }

    return changed;
  }

  async listPendingEvents(limit = 200): Promise<StoredEvent[]> {
    const pending = this.state.events
      .filter((event) => typeof event.serverSeq !== 'number')
      .sort((a, b) => {
        const aLocal = a.localSeq ?? Number.MAX_SAFE_INTEGER;
        const bLocal = b.localSeq ?? Number.MAX_SAFE_INTEGER;
        if (aLocal !== bLocal) return aLocal - bLocal;
        return a.eventId.localeCompare(b.eventId);
      })
      .slice(0, limit);

    return clone(pending);
  }

  async updateEventStatus(eventId: string, status: SyncItemStatus, error?: SyncError | null): Promise<void> {
    this.state.events = this.state.events.map((event) => {
      if (event.eventId !== eventId) {
        return event;
      }
      return {
        ...event,
        syncStatus: status,
        errorCode: error?.code,
        errorMessage: error?.message,
      };
    });
    await this.persist();
  }

  async saveProjection(snapshot: ProjectionSnapshot): Promise<void> {
    this.state.projection = clone(snapshot);
    await this.persist();
  }

  async getProjection(): Promise<ProjectionSnapshot | null> {
    return this.state.projection ? clone(this.state.projection) : null;
  }

  async saveBlobManifest(entries: BlobManifestEntry[]): Promise<void> {
    const map = new Map(this.state.blobs.map((entry) => [entry.hash, entry]));
    for (const entry of entries) {
      map.set(entry.hash, clone(entry));
    }
    this.state.blobs = Array.from(map.values());
    await this.persist();
  }

  async listBlobManifest(): Promise<BlobManifestEntry[]> {
    return clone(this.state.blobs);
  }

  async saveSyncAttempt(attempt: SyncAttempt): Promise<void> {
    this.state.attempts = [clone(attempt), ...this.state.attempts].slice(0, 200);
    await this.persist();
  }

  async listSyncAttempts(limit: number): Promise<SyncAttempt[]> {
    return clone(this.state.attempts.slice(0, limit));
  }
}
