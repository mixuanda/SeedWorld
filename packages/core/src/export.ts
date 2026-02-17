import {
  CURRENT_EVENT_SCHEMA_VERSION,
  MIN_SUPPORTED_EVENT_SCHEMA_VERSION,
  type ExportSnapshot,
  type ImportBundle,
  type ProjectionSnapshot,
  type StorageAdapter,
} from './types.js';
import { migrateEvent } from './migrations.js';

export async function buildExportSnapshot(
  storage: StorageAdapter,
  options: { allowMissingBlobs?: boolean } = {},
): Promise<ExportSnapshot> {
  const events = (await storage.listEvents()).map((event) => ({ ...event }));
  const projection = await ensureProjection(storage);
  const blobs = await storage.listBlobManifest();

  const blobByHash = new Map(blobs.map((blob) => [blob.hash, blob]));
  const missingBlobs = projection.referencedBlobs.filter((hash) => !blobByHash.get(hash)?.isPresent);

  if (missingBlobs.length > 0 && !options.allowMissingBlobs) {
    throw new Error(
      `Export blocked: ${missingBlobs.length} referenced blob(s) missing locally (${missingBlobs.join(', ')}). Re-fetch media and retry export.`,
    );
  }

  return {
    manifest: {
      schemaVersion: '0.2',
      createdAtMs: Date.now(),
      workspaceId: (await storage.getDeviceState()).workspaceId,
      eventSchemaVersion: CURRENT_EVENT_SCHEMA_VERSION,
      minSupportedEventSchemaVersion: MIN_SUPPORTED_EVENT_SCHEMA_VERSION,
      counts: {
        atoms: projection.atoms.length,
        events: events.length,
        blobs: blobs.length,
        conflicts: projection.conflicts.length,
      },
      referencedBlobs: projection.referencedBlobs,
      ...(missingBlobs.length > 0 ? { missingBlobs } : {}),
    },
    events,
    atoms: projection.atoms,
    atomVersions: projection.atomVersions,
    conflicts: projection.conflicts,
    blobs,
  };
}

export async function validateImportBundle(bundle: ImportBundle): Promise<void> {
  const manifest = bundle.manifest;

  if (manifest.schemaVersion !== '0.2') {
    throw new Error(`Unsupported export schema version ${manifest.schemaVersion}`);
  }

  if (manifest.minSupportedEventSchemaVersion > CURRENT_EVENT_SCHEMA_VERSION) {
    throw new Error(
      `Import not supported: bundle requires event schema >= ${manifest.minSupportedEventSchemaVersion}, this app supports up to ${CURRENT_EVENT_SCHEMA_VERSION}.`,
    );
  }

  if (manifest.eventSchemaVersion < MIN_SUPPORTED_EVENT_SCHEMA_VERSION) {
    throw new Error(
      `Import not supported: bundle event schema ${manifest.eventSchemaVersion} is below minimum ${MIN_SUPPORTED_EVENT_SCHEMA_VERSION}.`,
    );
  }

  for (const rawEvent of bundle.events) {
    migrateEvent(rawEvent);
  }
}

async function ensureProjection(storage: StorageAdapter): Promise<ProjectionSnapshot> {
  const existing = await storage.getProjection();
  if (existing) {
    return existing;
  }

  return {
    generatedAtMs: Date.now(),
    lastAppliedSeq: 0,
    atoms: [],
    atomVersions: [],
    conflicts: [],
    inbox: [],
    referencedBlobs: [],
  };
}
