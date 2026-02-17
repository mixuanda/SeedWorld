export const CURRENT_EVENT_SCHEMA_VERSION = 1;
export const MIN_SUPPORTED_EVENT_SCHEMA_VERSION = 1;

export type EventType =
  | 'capture.text.create'
  | 'atom.text.update'
  | 'blob.add'
  | 'changeset.suggest.create';

export interface CaptureTextCreatePayload {
  atomId: string;
  title?: string;
  body: string;
}

export interface AtomTextUpdatePayload {
  atomId: string;
  body: string;
  baseVersionId?: string;
}

export interface BlobAddPayload {
  atomId?: string;
  hash: string;
  size: number;
  contentType: string;
  extHint?: string;
}

export interface ChangeSetSuggestCreatePayload {
  changesetId: string;
  noteIds: string[];
  summary?: string;
}

export interface EventPayloadByType {
  'capture.text.create': CaptureTextCreatePayload;
  'atom.text.update': AtomTextUpdatePayload;
  'blob.add': BlobAddPayload;
  'changeset.suggest.create': ChangeSetSuggestCreatePayload;
}

export interface Event<TType extends EventType = EventType> {
  eventId: string;
  eventSchemaVersion: number;
  payloadSchemaVersion?: number;
  type: TType;
  createdAtMs: number;
  deviceId: string;
  workspaceId: string;
  localSeq?: number;
  serverSeq?: number;
  payload: EventPayloadByType[TType];
}

export interface StoredEvent extends Event {
  syncStatus: SyncItemStatus;
  errorCode?: SyncErrorCode;
  errorMessage?: string;
}

export interface EventDraft<TType extends EventType = EventType> {
  type: TType;
  payload: EventPayloadByType[TType];
  createdAtMs?: number;
  payloadSchemaVersion?: number;
}

export type SyncItemStatus =
  | 'saved_local'
  | 'waiting_sync'
  | 'syncing'
  | 'synced'
  | 'synced_text_only'
  | 'media_downloading'
  | 'sync_failed'
  | 'blocked_quota_or_storage'
  | 'blocked_hash_mismatch'
  | 'blocked_auth';

export type SyncErrorCode =
  | 'NETWORK'
  | 'AUTH'
  | 'HASH_MISMATCH'
  | 'QUOTA'
  | 'DISK_FULL'
  | 'SERVER_ERROR';

export interface SyncError {
  code: SyncErrorCode;
  message: string;
  details?: string;
}

export interface SyncAttempt {
  timestampMs: number;
  action: string;
  result: 'success' | 'error';
  errorCode?: SyncErrorCode;
  message?: string;
}

export interface DeviceState {
  workspaceId: string;
  userId: string;
  deviceId: string;
  nextLocalSeq: number;
  lastPulledSeq: number;
  lastAppliedSeq: number;
  projectionDirty: boolean;
  lastSyncSuccessAtMs?: number;
  lastErrorCode?: SyncErrorCode;
  lastErrorMessage?: string;
}

export interface EventServerSeqMapping {
  eventId: string;
  serverSeq: number;
}

export interface AtomVersion {
  atomId: string;
  versionId: string;
  eventId: string;
  parentVersionId?: string;
  body: string;
  createdAtMs: number;
  serverSeq?: number;
  localSeq?: number;
}

export interface AtomRecord {
  atomId: string;
  title: string;
  body: string;
  createdAtMs: number;
  updatedAtMs: number;
  captureEventId: string;
  headVersionIds: string[];
  needsResolution: boolean;
  blobHashes: string[];
}

export interface ConflictRecord {
  conflictId: string;
  atomId: string;
  versionIds: string[];
  reason: 'concurrent_update';
  status: 'open' | 'resolved';
  createdAtMs: number;
  updatedAtMs: number;
}

export interface InboxItem {
  id: string;
  atomId: string;
  title: string;
  preview: string;
  createdAtMs: number;
  updatedAtMs: number;
  sourceEventId: string;
  syncStatus: SyncItemStatus;
  needsResolution: boolean;
  serverSeq?: number;
}

export interface ProjectionSnapshot {
  generatedAtMs: number;
  lastAppliedSeq: number;
  atoms: AtomRecord[];
  atomVersions: AtomVersion[];
  conflicts: ConflictRecord[];
  inbox: InboxItem[];
  referencedBlobs: string[];
}

export interface BlobManifestEntry {
  hash: string;
  size: number;
  contentType: string;
  localPath: string;
  isPresent: boolean;
  syncStatus: SyncItemStatus;
  errorCode?: SyncErrorCode;
  errorMessage?: string;
  updatedAtMs: number;
}

export interface ExportManifest {
  schemaVersion: '0.2';
  createdAtMs: number;
  workspaceId: string;
  eventSchemaVersion: number;
  minSupportedEventSchemaVersion: number;
  counts: {
    atoms: number;
    events: number;
    blobs: number;
    conflicts: number;
  };
  referencedBlobs: string[];
  missingBlobs?: string[];
}

export interface ExportSnapshot {
  manifest: ExportManifest;
  events: Event[];
  atoms: AtomRecord[];
  atomVersions: AtomVersion[];
  conflicts: ConflictRecord[];
  blobs: BlobManifestEntry[];
}

export interface SyncStatus {
  lastSuccessAtMs?: number;
  pendingEvents: number;
  pendingBlobs: number;
  lastError?: SyncError;
  lastPulledSeq: number;
  lastAppliedSeq: number;
}

export interface PushRequest {
  workspaceId: string;
  userId: string;
  deviceId: string;
  clientCursor: number;
  events: Event[];
}

export interface PushResponse {
  accepted: EventServerSeqMapping[];
  cursor: number;
  missingBlobHashes: string[];
}

export interface PullRequest {
  workspaceId: string;
  userId: string;
  deviceId: string;
  cursor: number;
}

export interface PullResponse {
  events: Event[];
  cursor: number;
  conflicts: ConflictRecord[];
}

export interface SyncTransport {
  push(request: PushRequest): Promise<PushResponse>;
  pull(request: PullRequest): Promise<PullResponse>;
  uploadBlob?(workspaceId: string, hash: string, contentType: string, bytes: Uint8Array): Promise<void>;
  downloadBlob?(workspaceId: string, hash: string): Promise<Uint8Array>;
}

export interface StorageAdapter {
  getDeviceState(): Promise<DeviceState>;
  saveDeviceState(state: DeviceState): Promise<void>;
  allocateLocalSeq(): Promise<number>;
  upsertEvents(events: StoredEvent[]): Promise<void>;
  listEvents(): Promise<StoredEvent[]>;
  assignServerSeq(mappings: EventServerSeqMapping[]): Promise<boolean>;
  listPendingEvents(limit?: number): Promise<StoredEvent[]>;
  updateEventStatus(eventId: string, status: SyncItemStatus, error?: SyncError | null): Promise<void>;
  saveProjection(snapshot: ProjectionSnapshot): Promise<void>;
  getProjection(): Promise<ProjectionSnapshot | null>;
  saveBlobManifest(entries: BlobManifestEntry[]): Promise<void>;
  listBlobManifest(): Promise<BlobManifestEntry[]>;
  saveSyncAttempt(attempt: SyncAttempt): Promise<void>;
  listSyncAttempts(limit: number): Promise<SyncAttempt[]>;
}

export type ImportMode = 'restore' | 'clone';

export interface ImportBundle {
  manifest: ExportManifest;
  events: unknown[];
  atoms?: AtomRecord[];
  atomVersions?: AtomVersion[];
  conflicts?: ConflictRecord[];
  blobs?: BlobManifestEntry[];
}
