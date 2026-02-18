import {
  type AtomRecord,
  type AtomVersion,
  type ConflictRecord,
  type Event,
  type InboxItem,
  type ProjectionSnapshot,
  type StoredEvent,
  type SyncItemStatus,
} from './types';

interface WorkingAtom {
  atomId: string;
  title: string;
  body: string;
  createdAtMs: number;
  updatedAtMs: number;
  captureEventId: string;
  headVersionIds: string[];
  needsResolution: boolean;
  blobHashes: Set<string>;
}

function localFallbackOrder(a: Event, b: Event): number {
  const aLocal = a.localSeq ?? Number.MAX_SAFE_INTEGER;
  const bLocal = b.localSeq ?? Number.MAX_SAFE_INTEGER;
  if (aLocal !== bLocal) {
    return aLocal - bLocal;
  }
  if (a.createdAtMs !== b.createdAtMs) {
    return a.createdAtMs - b.createdAtMs;
  }
  return a.eventId.localeCompare(b.eventId);
}

function eventAtomId(event: Event): string | undefined {
  const payload = event.payload as unknown as Record<string, unknown>;
  const atomId = payload.atomId;
  return typeof atomId === 'string' ? atomId : undefined;
}

function previewText(value: string): string {
  const cleaned = value.replace(/\s+/g, ' ').trim();
  return cleaned.length > 120 ? `${cleaned.slice(0, 117)}...` : cleaned;
}

function foldStatus(current: SyncItemStatus, candidate: SyncItemStatus): SyncItemStatus {
  const priority: SyncItemStatus[] = [
    'blocked_auth',
    'blocked_hash_mismatch',
    'blocked_quota_or_storage',
    'sync_failed',
    'syncing',
    'media_downloading',
    'synced_text_only',
    'waiting_sync',
    'saved_local',
    'synced',
  ];

  const currentRank = priority.indexOf(current);
  const candidateRank = priority.indexOf(candidate);

  if (candidateRank !== -1 && (currentRank === -1 || candidateRank < currentRank)) {
    return candidate;
  }
  return current;
}

export function buildProjection(events: StoredEvent[]): ProjectionSnapshot {
  const canonical = events
    .filter((event) => typeof event.serverSeq === 'number')
    .sort((a, b) => (a.serverSeq as number) - (b.serverSeq as number));

  const provisional = events
    .filter((event) => typeof event.serverSeq !== 'number')
    .sort(localFallbackOrder);

  const ordered = [...canonical, ...provisional];

  const atoms = new Map<string, WorkingAtom>();
  const atomVersions: AtomVersion[] = [];
  const conflicts = new Map<string, ConflictRecord>();
  const eventStatuses = new Map<string, SyncItemStatus>();
  const referencedBlobs = new Set<string>();

  for (const event of ordered) {
    eventStatuses.set(event.eventId, event.syncStatus);

    if (event.type === 'capture.text.create') {
      const payload = event.payload as { atomId: string; title?: string; body: string };
      if (atoms.has(payload.atomId)) {
        continue;
      }

      atoms.set(payload.atomId, {
        atomId: payload.atomId,
        title: payload.title?.trim() || payload.body.trim().split('\n')[0] || 'Untitled',
        body: payload.body,
        createdAtMs: event.createdAtMs,
        updatedAtMs: event.createdAtMs,
        captureEventId: event.eventId,
        headVersionIds: [event.eventId],
        needsResolution: false,
        blobHashes: new Set<string>(),
      });

      atomVersions.push({
        atomId: payload.atomId,
        versionId: event.eventId,
        eventId: event.eventId,
        body: payload.body,
        createdAtMs: event.createdAtMs,
        serverSeq: event.serverSeq,
        localSeq: event.localSeq,
      });
      continue;
    }

    if (event.type === 'atom.text.update') {
      const payload = event.payload as { atomId: string; body: string; baseVersionId?: string };
      const atom = atoms.get(payload.atomId);
      if (!atom) {
        atoms.set(payload.atomId, {
          atomId: payload.atomId,
          title: payload.body.trim().split('\n')[0] || 'Untitled',
          body: payload.body,
          createdAtMs: event.createdAtMs,
          updatedAtMs: event.createdAtMs,
          captureEventId: event.eventId,
          headVersionIds: [event.eventId],
          needsResolution: false,
          blobHashes: new Set<string>(),
        });
      }

      const working = atoms.get(payload.atomId) as WorkingAtom;

      const conflictDetected =
        payload.baseVersionId !== undefined &&
        working.headVersionIds.length > 0 &&
        !working.headVersionIds.includes(payload.baseVersionId);

      if (conflictDetected) {
        const versionIds = Array.from(new Set([...working.headVersionIds, event.eventId]));
        working.headVersionIds = versionIds;
        working.needsResolution = true;

        const conflictId = `conflict:${payload.atomId}`;
        conflicts.set(conflictId, {
          conflictId,
          atomId: payload.atomId,
          versionIds,
          reason: 'concurrent_update',
          status: 'open',
          createdAtMs: event.createdAtMs,
          updatedAtMs: event.createdAtMs,
        });
      } else {
        working.headVersionIds = [event.eventId];
      }

      working.body = payload.body;
      working.updatedAtMs = event.createdAtMs;
      working.title = working.title || payload.body.trim().split('\n')[0] || 'Untitled';

      atomVersions.push({
        atomId: payload.atomId,
        versionId: event.eventId,
        eventId: event.eventId,
        parentVersionId: payload.baseVersionId,
        body: payload.body,
        createdAtMs: event.createdAtMs,
        serverSeq: event.serverSeq,
        localSeq: event.localSeq,
      });
      continue;
    }

    if (event.type === 'blob.add') {
      const payload = event.payload as { atomId?: string; hash: string };
      referencedBlobs.add(payload.hash);
      if (payload.atomId && atoms.has(payload.atomId)) {
        (atoms.get(payload.atomId) as WorkingAtom).blobHashes.add(payload.hash);
      }
    }
  }

  const inbox: InboxItem[] = [];

  for (const atom of atoms.values()) {
    const relatedEvents = ordered.filter((event) => eventAtomId(event) === atom.atomId);

    let status: SyncItemStatus = 'synced';
    for (const event of relatedEvents) {
      const eventStatus = eventStatuses.get(event.eventId) || (event.serverSeq ? 'synced' : 'waiting_sync');
      status = foldStatus(status, eventStatus);
      if (!event.serverSeq && status === 'synced') {
        status = 'waiting_sync';
      }
    }

    inbox.push({
      id: `atom:${atom.atomId}`,
      atomId: atom.atomId,
      title: atom.title,
      preview: previewText(atom.body),
      createdAtMs: atom.createdAtMs,
      updatedAtMs: atom.updatedAtMs,
      sourceEventId: atom.captureEventId,
      syncStatus: status,
      needsResolution: atom.needsResolution,
      serverSeq: relatedEvents.reduce<number | undefined>((max, event) => {
        if (typeof event.serverSeq !== 'number') {
          return max;
        }
        return typeof max === 'number' ? Math.max(max, event.serverSeq) : event.serverSeq;
      }, undefined),
    });

    for (const hash of atom.blobHashes) {
      referencedBlobs.add(hash);
    }
  }

  inbox.sort((a, b) => {
    if (a.createdAtMs !== b.createdAtMs) {
      return b.createdAtMs - a.createdAtMs;
    }
    return a.id.localeCompare(b.id);
  });

  const atomRecords: AtomRecord[] = Array.from(atoms.values()).map((atom) => ({
    atomId: atom.atomId,
    title: atom.title,
    body: atom.body,
    createdAtMs: atom.createdAtMs,
    updatedAtMs: atom.updatedAtMs,
    captureEventId: atom.captureEventId,
    headVersionIds: atom.headVersionIds,
    needsResolution: atom.needsResolution,
    blobHashes: Array.from(atom.blobHashes),
  }));

  const lastAppliedSeq = canonical.length > 0 ? (canonical[canonical.length - 1].serverSeq as number) : 0;

  return {
    generatedAtMs: Date.now(),
    lastAppliedSeq,
    atoms: atomRecords,
    atomVersions,
    conflicts: Array.from(conflicts.values()),
    inbox,
    referencedBlobs: Array.from(referencedBlobs).sort(),
  };
}
