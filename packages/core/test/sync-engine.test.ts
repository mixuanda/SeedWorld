import { createHash } from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  type Event,
  type PullRequest,
  type PullResponse,
  type PushRequest,
  type PushResponse,
  type StoredEvent,
  type SyncTransport,
  InMemoryStorageAdapter,
  SyncEngine,
  buildProjection,
  generateEventId,
} from '../src/index.js';

class InMemorySyncServer {
  private nextSeq = new Map<string, number>();

  private events = new Map<string, Map<string, Event & { serverSeq: number }>>();

  private blobs = new Map<string, Map<string, Uint8Array>>();

  async push(request: PushRequest): Promise<PushResponse> {
    const workspaceEvents = this.ensureWorkspaceEvents(request.workspaceId);
    const accepted: Array<{ eventId: string; serverSeq: number }> = [];

    for (const event of request.events) {
      const existing = workspaceEvents.get(event.eventId);
      if (existing) {
        accepted.push({ eventId: existing.eventId, serverSeq: existing.serverSeq });
        continue;
      }

      const seq = this.allocateSeq(request.workspaceId);
      const stored: Event & { serverSeq: number } = {
        ...event,
        serverSeq: seq,
      };

      workspaceEvents.set(event.eventId, stored);
      accepted.push({ eventId: event.eventId, serverSeq: seq });
    }

    const missingBlobHashes = request.events
      .filter((event) => event.type === 'blob.add')
      .map((event) => (event.payload as { hash: string }).hash)
      .filter((hash) => !this.ensureWorkspaceBlobs(request.workspaceId).has(hash));

    const cursor = Array.from(workspaceEvents.values()).reduce((max, event) => Math.max(max, event.serverSeq), request.clientCursor);

    return {
      accepted,
      cursor,
      missingBlobHashes,
    };
  }

  async pull(request: PullRequest): Promise<PullResponse> {
    const workspaceEvents = this.ensureWorkspaceEvents(request.workspaceId);

    const events = Array.from(workspaceEvents.values())
      .filter((event) => event.serverSeq > request.cursor)
      .sort((a, b) => a.serverSeq - b.serverSeq)
      .map((event) => ({ ...event }));

    const cursor = events.length > 0 ? events[events.length - 1].serverSeq! : request.cursor;

    return {
      events,
      cursor,
      conflicts: [],
    };
  }

  async uploadBlob(workspaceId: string, hash: string, _contentType: string, bytes: Uint8Array): Promise<void> {
    this.ensureWorkspaceBlobs(workspaceId).set(hash, bytes);
  }

  async downloadBlob(workspaceId: string, hash: string): Promise<Uint8Array> {
    const blob = this.ensureWorkspaceBlobs(workspaceId).get(hash);
    if (!blob) {
      throw new Error(`blob not found: ${hash}`);
    }
    return blob;
  }

  hasBlob(workspaceId: string, hash: string): boolean {
    return this.ensureWorkspaceBlobs(workspaceId).has(hash);
  }

  private allocateSeq(workspaceId: string): number {
    const next = (this.nextSeq.get(workspaceId) ?? 1);
    this.nextSeq.set(workspaceId, next + 1);
    return next;
  }

  private ensureWorkspaceEvents(workspaceId: string): Map<string, Event & { serverSeq: number }> {
    let workspace = this.events.get(workspaceId);
    if (!workspace) {
      workspace = new Map();
      this.events.set(workspaceId, workspace);
    }
    return workspace;
  }

  private ensureWorkspaceBlobs(workspaceId: string): Map<string, Uint8Array> {
    let workspace = this.blobs.get(workspaceId);
    if (!workspace) {
      workspace = new Map();
      this.blobs.set(workspaceId, workspace);
    }
    return workspace;
  }
}

function createClient(server: InMemorySyncServer, deviceId: string): { engine: SyncEngine; storage: InMemoryStorageAdapter; transport: SyncTransport } {
  const storage = new InMemoryStorageAdapter({
    workspaceId: 'workspace-1',
    userId: 'user-1',
    deviceId,
    nextLocalSeq: 1,
    lastPulledSeq: 0,
    lastAppliedSeq: 0,
    projectionDirty: false,
  });

  const transport: SyncTransport = {
    push: (request) => server.push(request),
    pull: (request) => server.pull(request),
    uploadBlob: (workspaceId, hash, contentType, bytes) => server.uploadBlob(workspaceId, hash, contentType, bytes),
    downloadBlob: (workspaceId, hash) => server.downloadBlob(workspaceId, hash),
  };

  const engine = new SyncEngine({ storage, transport });

  return { engine, storage, transport };
}

function makeAtomId(prefix: string, index: number): string {
  return `${prefix}-${index}-${generateEventId().slice(0, 8)}`;
}

test('two clients converge after offline capture and repeated sync without duplicates', async () => {
  const server = new InMemorySyncServer();
  const clientA = createClient(server, 'device-A');
  const clientB = createClient(server, 'device-B');

  for (let i = 0; i < 3; i += 1) {
    await clientA.engine.captureText({
      atomId: makeAtomId('a', i),
      body: `Client A note ${i}`,
      title: `A ${i}`,
    });
  }

  for (let i = 0; i < 2; i += 1) {
    await clientB.engine.captureText({
      atomId: makeAtomId('b', i),
      body: `Client B note ${i}`,
      title: `B ${i}`,
    });
  }

  assert.equal((await clientA.engine.getInbox()).length, 3);
  assert.equal((await clientB.engine.getInbox()).length, 2);

  await clientA.engine.syncNow();
  await clientB.engine.syncNow();
  await clientA.engine.syncNow();
  await clientB.engine.syncNow();

  const inboxA = await clientA.engine.getInbox();
  const inboxB = await clientB.engine.getInbox();

  assert.equal(inboxA.length, 5);
  assert.equal(inboxB.length, 5);

  const uniqueA = new Set(inboxA.map((item) => item.id));
  const uniqueB = new Set(inboxB.map((item) => item.id));

  assert.equal(uniqueA.size, 5);
  assert.equal(uniqueB.size, 5);

  await clientA.engine.syncNow();
  await clientB.engine.syncNow();

  assert.equal((await clientA.engine.getInbox()).length, 5);
  assert.equal((await clientB.engine.getInbox()).length, 5);
});

test('concurrent offline atom updates preserve conflict with two versions', async () => {
  const server = new InMemorySyncServer();
  const clientA = createClient(server, 'device-A');
  const clientB = createClient(server, 'device-B');

  const atomId = makeAtomId('shared', 1);

  const capture = await clientA.engine.captureText({ atomId, title: 'Shared', body: 'Original body' });
  await clientA.engine.syncNow();
  await clientB.engine.syncNow();

  await clientA.engine.appendLocalEvent({
    type: 'atom.text.update',
    payload: {
      atomId,
      body: 'Edit from A',
      baseVersionId: capture.eventId,
    },
  });

  await clientB.engine.appendLocalEvent({
    type: 'atom.text.update',
    payload: {
      atomId,
      body: 'Edit from B',
      baseVersionId: capture.eventId,
    },
  });

  await clientA.engine.syncNow();
  await clientB.engine.syncNow();
  await clientA.engine.syncNow();
  await clientB.engine.syncNow();

  const projectionA = await clientA.storage.getProjection();
  const projectionB = await clientB.storage.getProjection();

  assert.ok(projectionA);
  assert.ok(projectionB);

  const atomA = projectionA!.atoms.find((atom) => atom.atomId === atomId);
  const atomB = projectionB!.atoms.find((atom) => atom.atomId === atomId);

  assert.ok(atomA?.needsResolution);
  assert.ok(atomB?.needsResolution);
  assert.ok((atomA?.headVersionIds.length ?? 0) >= 2);
  assert.ok((atomB?.headVersionIds.length ?? 0) >= 2);

  const conflictA = projectionA!.conflicts.find((conflict) => conflict.atomId === atomId);
  const conflictB = projectionB!.conflicts.find((conflict) => conflict.atomId === atomId);

  assert.equal(conflictA?.status, 'open');
  assert.equal(conflictB?.status, 'open');
});

test('blob upload/fetch and missing blob detection behavior', async () => {
  const server = new InMemorySyncServer();
  const client = createClient(server, 'device-A');

  const blobBytes = new TextEncoder().encode('seedworld-blob');
  const hash = createHash('sha256').update(blobBytes).digest('hex');

  const capture = await client.engine.captureText({
    atomId: makeAtomId('blob-atom', 1),
    title: 'Blob Note',
    body: 'Has media',
  });

  await client.engine.appendLocalEvent({
    type: 'blob.add',
    payload: {
      atomId: (capture.payload as { atomId: string }).atomId,
      hash,
      size: blobBytes.length,
      contentType: 'text/plain',
    },
  });

  const pending = await client.storage.listPendingEvents();
  const pushResponse = await server.push({
    workspaceId: 'workspace-1',
    userId: 'user-1',
    deviceId: 'device-A',
    clientCursor: 0,
    events: pending.map(({ syncStatus, errorCode, errorMessage, ...event }) => event),
  });

  assert.ok(pushResponse.missingBlobHashes.includes(hash));

  await server.uploadBlob('workspace-1', hash, 'text/plain', blobBytes);
  assert.ok(server.hasBlob('workspace-1', hash));

  const downloaded = await server.downloadBlob('workspace-1', hash);
  assert.deepEqual(downloaded, blobBytes);
});

test('local projection remains immediate before server sequence assignment', async () => {
  const server = new InMemorySyncServer();
  const client = createClient(server, 'device-A');

  const event = await client.engine.captureText({
    atomId: makeAtomId('offline', 1),
    body: 'Offline first note',
  });

  assert.equal(typeof event.serverSeq, 'undefined');

  const inboxBeforeSync = await client.engine.getInbox();
  assert.equal(inboxBeforeSync.length, 1);
  assert.equal(inboxBeforeSync[0].syncStatus === 'waiting_sync' || inboxBeforeSync[0].syncStatus === 'saved_local', true);

  await client.engine.syncNow();
  const inboxAfterSync = await client.engine.getInbox();
  assert.equal(inboxAfterSync.length, 1);
  assert.equal(inboxAfterSync[0].syncStatus, 'synced');

  const events = await client.storage.listEvents();
  const syncedEvent = events.find((item) => item.eventId === event.eventId);
  assert.equal(typeof syncedEvent?.serverSeq, 'number');
});

test('projection rebuild is deterministic when canonical order differs from provisional order', async () => {
  const baseEvents: StoredEvent[] = [
    {
      eventId: '01',
      eventSchemaVersion: 1,
      type: 'capture.text.create',
      createdAtMs: 100,
      deviceId: 'd1',
      workspaceId: 'w1',
      localSeq: 1,
      payload: { atomId: 'a1', body: 'base', title: 'Base' },
      syncStatus: 'synced',
      serverSeq: 10,
    },
    {
      eventId: '02',
      eventSchemaVersion: 1,
      type: 'atom.text.update',
      createdAtMs: 300,
      deviceId: 'd1',
      workspaceId: 'w1',
      localSeq: 3,
      payload: { atomId: 'a1', body: 'late local', baseVersionId: '01' },
      syncStatus: 'waiting_sync',
    },
    {
      eventId: '03',
      eventSchemaVersion: 1,
      type: 'atom.text.update',
      createdAtMs: 200,
      deviceId: 'd1',
      workspaceId: 'w1',
      localSeq: 2,
      payload: { atomId: 'a1', body: 'early local', baseVersionId: '01' },
      syncStatus: 'waiting_sync',
    },
  ];

  const provisionalProjection = buildProjection(baseEvents);
  assert.equal(provisionalProjection.atoms.find((atom) => atom.atomId === 'a1')?.body, 'late local');

  const canonicalEvents: StoredEvent[] = baseEvents.map((event) => {
    if (event.eventId === '02') {
      return { ...event, serverSeq: 12, syncStatus: 'synced' };
    }
    if (event.eventId === '03') {
      return { ...event, serverSeq: 11, syncStatus: 'synced' };
    }
    return event;
  });

  const rebuiltProjection = buildProjection(canonicalEvents);
  assert.equal(rebuiltProjection.atoms.find((atom) => atom.atomId === 'a1')?.body, 'late local');
  assert.equal(rebuiltProjection.lastAppliedSeq, 12);
});
