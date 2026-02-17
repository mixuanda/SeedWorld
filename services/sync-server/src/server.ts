import { createHash, createHmac, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { URL } from 'node:url';
import { migrateEvent, type Event } from '@seedworld/core';

interface AuthPayload {
  userId: string;
  workspaceId: string;
  exp: number;
}

interface ConflictRow {
  conflictId: string;
  atomId: string;
  versionIds: string[];
  reason: 'concurrent_update';
  status: 'open' | 'resolved';
  createdAtMs: number;
  updatedAtMs: number;
}

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';
const SECRET = process.env.DEV_AUTH_SECRET || 'seedworld-dev-secret';
const DATA_DIR = path.resolve(process.env.SYNC_SERVER_DATA_DIR || path.join(process.cwd(), 'data'));
const BLOBS_DIR = path.join(DATA_DIR, 'blobs');
const DB_PATH = path.join(DATA_DIR, 'sync.db');

fs.mkdirSync(BLOBS_DIR, { recursive: true });

const db = new DatabaseSync(DB_PATH);

db.exec(`
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;

CREATE TABLE IF NOT EXISTS workspace_seq (
  workspace_id TEXT PRIMARY KEY,
  next_seq INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  workspace_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  event_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  event_schema_version INTEGER NOT NULL,
  payload_schema_version INTEGER,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  local_seq INTEGER,
  PRIMARY KEY (workspace_id, seq),
  UNIQUE (workspace_id, event_id)
);

CREATE INDEX IF NOT EXISTS idx_events_workspace_seq ON events(workspace_id, seq);
CREATE INDEX IF NOT EXISTS idx_events_workspace_event ON events(workspace_id, event_id);

CREATE TABLE IF NOT EXISTS device_cursors (
  workspace_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  last_seq INTEGER NOT NULL DEFAULT 0,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, device_id)
);

CREATE TABLE IF NOT EXISTS blobs (
  workspace_id TEXT NOT NULL,
  hash TEXT NOT NULL,
  size INTEGER NOT NULL,
  content_type TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  path TEXT NOT NULL,
  PRIMARY KEY (workspace_id, hash)
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
`);

function nowMs(): number {
  return Date.now();
}

function base64UrlEncode(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function base64UrlDecode(value: string): string {
  return Buffer.from(value, 'base64url').toString('utf8');
}

function signToken(payload: AuthPayload): string {
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signature = createHmac('sha256', SECRET).update(encodedPayload).digest('base64url');
  return `${encodedPayload}.${signature}`;
}

function verifyToken(token: string): AuthPayload | null {
  const parts = token.split('.');
  if (parts.length !== 2) {
    return null;
  }

  const [payloadPart, signaturePart] = parts;
  const expectedSignature = createHmac('sha256', SECRET).update(payloadPart).digest('base64url');
  if (signaturePart !== expectedSignature) {
    return null;
  }

  try {
    const parsed = JSON.parse(base64UrlDecode(payloadPart)) as AuthPayload;
    if (typeof parsed.userId !== 'string' || typeof parsed.workspaceId !== 'string' || typeof parsed.exp !== 'number') {
      return null;
    }

    if (parsed.exp < nowMs()) {
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'authorization,content-type',
  });
  res.end(payload);
}

function sendError(
  res: ServerResponse,
  status: number,
  code: string,
  message: string,
  retryable: boolean,
  details?: string,
): void {
  sendJson(res, status, {
    code,
    message,
    retryable,
    ...(details ? { details } : {}),
  });
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text.length > 0 ? JSON.parse(text) : {};
}

function allocateSeq(workspaceId: string): number {
  db.prepare(`INSERT INTO workspace_seq(workspace_id, next_seq) VALUES (?, 1) ON CONFLICT(workspace_id) DO NOTHING`).run(workspaceId);
  const row = db.prepare(`SELECT next_seq FROM workspace_seq WHERE workspace_id = ?`).get(workspaceId) as { next_seq: number };
  const seq = row.next_seq;
  db.prepare(`UPDATE workspace_seq SET next_seq = ? WHERE workspace_id = ?`).run(seq + 1, workspaceId);
  return seq;
}

function getWorkspaceCursor(workspaceId: string): number {
  const row = db
    .prepare(`SELECT MAX(seq) AS cursor FROM events WHERE workspace_id = ?`)
    .get(workspaceId) as { cursor: number | null };
  return row.cursor ?? 0;
}

function requireAuth(req: IncomingMessage): AuthPayload | null {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }
  const token = authHeader.slice('Bearer '.length).trim();
  return verifyToken(token);
}

function normalizeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return 'Unknown error';
}

function parseRangeHeader(rangeHeader: string | undefined, fileSize: number): [number, number] | null {
  if (!rangeHeader) {
    return null;
  }

  const match = rangeHeader.match(/^bytes=(\d+)-(\d*)$/);
  if (!match) {
    return null;
  }

  const start = Number(match[1]);
  const end = match[2] ? Number(match[2]) : fileSize - 1;

  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end >= fileSize || start > end) {
    return null;
  }

  return [start, end];
}

function blobPathFor(hash: string, extHint?: string): string {
  const safeExt = extHint && /^[a-z0-9]{1,8}$/i.test(extHint) ? `.${extHint.toLowerCase()}` : '';
  return path.join(BLOBS_DIR, `${hash}${safeExt}`);
}

async function handleAuthDev(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = (await readJsonBody(req)) as { userId?: string; workspaceId?: string };
  const userId = body.userId?.trim();
  const workspaceId = body.workspaceId?.trim();

  if (!userId || !workspaceId) {
    sendError(res, 400, 'AUTH', 'userId and workspaceId are required', false);
    return;
  }

  const expiresAtMs = nowMs() + 1000 * 60 * 60 * 8;
  const token = signToken({
    userId,
    workspaceId,
    exp: expiresAtMs,
  });

  sendJson(res, 200, {
    token,
    userId,
    workspaceId,
    expiresAtMs,
  });
}

async function handleSyncPush(req: IncomingMessage, res: ServerResponse, auth: AuthPayload): Promise<void> {
  const body = (await readJsonBody(req)) as {
    workspaceId: string;
    userId: string;
    deviceId: string;
    clientCursor: number;
    events: unknown[];
  };

  if (body.workspaceId !== auth.workspaceId || body.userId !== auth.userId) {
    sendError(res, 403, 'AUTH', 'Token workspace/user mismatch', false);
    return;
  }

  if (!Array.isArray(body.events)) {
    sendError(res, 400, 'SERVER_ERROR', 'events must be an array', false);
    return;
  }

  const accepted: Array<{ eventId: string; serverSeq: number }> = [];
  const missingBlobHashes = new Set<string>();

  db.exec('BEGIN');
  try {
    for (const rawEvent of body.events) {
      const event = migrateEvent(rawEvent);

      if (event.workspaceId !== auth.workspaceId) {
        throw new Error(`Event workspace mismatch for ${event.eventId}`);
      }

      const existing = db
        .prepare(`SELECT seq FROM events WHERE workspace_id = ? AND event_id = ?`)
        .get(auth.workspaceId, event.eventId) as { seq: number } | undefined;

      if (existing) {
        accepted.push({ eventId: event.eventId, serverSeq: existing.seq });
        continue;
      }

      const seq = allocateSeq(auth.workspaceId);

      db.prepare(
        `INSERT INTO events (
          workspace_id, seq, event_id, device_id, user_id, created_at_ms,
          event_schema_version, payload_schema_version, type, payload_json, local_seq
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        auth.workspaceId,
        seq,
        event.eventId,
        event.deviceId,
        auth.userId,
        event.createdAtMs,
        event.eventSchemaVersion,
        event.payloadSchemaVersion ?? null,
        event.type,
        JSON.stringify(event.payload),
        event.localSeq ?? null,
      );

      accepted.push({ eventId: event.eventId, serverSeq: seq });

      if (event.type === 'blob.add') {
        const hash = (event.payload as { hash?: string }).hash;
        if (typeof hash === 'string') {
          const hasBlob = db
            .prepare(`SELECT 1 FROM blobs WHERE workspace_id = ? AND hash = ?`)
            .get(auth.workspaceId, hash);
          if (!hasBlob) {
            missingBlobHashes.add(hash);
          }
        }
      }
    }

    db.prepare(
      `INSERT INTO device_cursors(workspace_id, device_id, last_seq, updated_at_ms)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(workspace_id, device_id)
       DO UPDATE SET
         last_seq = CASE WHEN excluded.last_seq > device_cursors.last_seq THEN excluded.last_seq ELSE device_cursors.last_seq END,
         updated_at_ms = excluded.updated_at_ms`
    ).run(auth.workspaceId, body.deviceId, Math.max(0, Math.trunc(body.clientCursor || 0)), nowMs());

    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  sendJson(res, 200, {
    accepted,
    cursor: getWorkspaceCursor(auth.workspaceId),
    missingBlobHashes: Array.from(missingBlobHashes),
  });
}

function decodeEventRow(row: {
  event_id: string;
  event_schema_version: number;
  payload_schema_version: number | null;
  type: string;
  created_at_ms: number;
  device_id: string;
  workspace_id: string;
  local_seq: number | null;
  seq: number;
  payload_json: string;
}): Event {
  return {
    eventId: row.event_id,
    eventSchemaVersion: row.event_schema_version,
    payloadSchemaVersion: row.payload_schema_version ?? undefined,
    type: row.type as Event['type'],
    createdAtMs: row.created_at_ms,
    deviceId: row.device_id,
    workspaceId: row.workspace_id,
    localSeq: row.local_seq ?? undefined,
    serverSeq: row.seq,
    payload: JSON.parse(row.payload_json) as Event['payload'],
  };
}

async function handleSyncPull(req: IncomingMessage, res: ServerResponse, auth: AuthPayload): Promise<void> {
  const requestUrl = new URL(req.url || '/', `http://${HOST}:${PORT}`);
  const cursor = Math.max(0, Math.trunc(Number(requestUrl.searchParams.get('cursor') || '0')));

  const rows = db
    .prepare(
      `SELECT event_id, event_schema_version, payload_schema_version, type, created_at_ms, device_id, workspace_id, local_seq, seq, payload_json
       FROM events
       WHERE workspace_id = ? AND seq > ?
       ORDER BY seq ASC
       LIMIT 1000`
    )
    .all(auth.workspaceId, cursor) as Array<{
      event_id: string;
      event_schema_version: number;
      payload_schema_version: number | null;
      type: string;
      created_at_ms: number;
      device_id: string;
      workspace_id: string;
      local_seq: number | null;
      seq: number;
      payload_json: string;
    }>;

  const events = rows.map(decodeEventRow);

  const conflictRows = db
    .prepare(
      `SELECT conflict_id, atom_id, version_ids_json, reason, status, created_at_ms, updated_at_ms
       FROM conflicts
       WHERE workspace_id = ? AND status = 'open'`
    )
    .all(auth.workspaceId) as Array<{
      conflict_id: string;
      atom_id: string;
      version_ids_json: string;
      reason: 'concurrent_update';
      status: 'open' | 'resolved';
      created_at_ms: number;
      updated_at_ms: number;
    }>;

  const conflicts: ConflictRow[] = conflictRows.map((row) => ({
    conflictId: row.conflict_id,
    atomId: row.atom_id,
    versionIds: JSON.parse(row.version_ids_json) as string[],
    reason: row.reason,
    status: row.status,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
  }));

  const newCursor = events.length > 0 ? (events[events.length - 1].serverSeq as number) : cursor;

  sendJson(res, 200, {
    events,
    cursor: newCursor,
    conflicts,
  });
}

async function handleBlobUpload(req: IncomingMessage, res: ServerResponse, auth: AuthPayload): Promise<void> {
  const requestUrl = new URL(req.url || '/', `http://${HOST}:${PORT}`);
  const hash = requestUrl.searchParams.get('hash')?.toLowerCase();
  const contentType = requestUrl.searchParams.get('contentType') || 'application/octet-stream';
  const extHint = requestUrl.searchParams.get('ext') || undefined;

  if (!hash || !/^[a-f0-9]{64}$/.test(hash)) {
    sendError(res, 400, 'HASH_MISMATCH', 'Query parameter "hash" must be a sha256 hex digest', false);
    return;
  }

  const targetPath = blobPathFor(hash, extHint);
  const tempPath = path.join(BLOBS_DIR, `.tmp-${hash}-${randomBytes(6).toString('hex')}`);
  const digest = createHash('sha256');
  const output = fs.createWriteStream(tempPath);
  let byteLength = 0;

  await new Promise<void>((resolve, reject) => {
    req.on('data', (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      digest.update(buffer);
      byteLength += buffer.length;
      output.write(buffer);
    });

    req.on('end', () => {
      output.end(() => resolve());
    });

    req.on('error', reject);
    output.on('error', reject);
  });

  const computedHash = digest.digest('hex');
  if (computedHash !== hash) {
    try {
      fs.unlinkSync(tempPath);
    } catch {
      // ignore cleanup errors
    }
    sendError(res, 400, 'HASH_MISMATCH', `Blob hash mismatch. expected=${hash}, got=${computedHash}`, false);
    return;
  }

  if (!fs.existsSync(targetPath)) {
    fs.renameSync(tempPath, targetPath);
  } else {
    fs.unlinkSync(tempPath);
  }

  db.prepare(
    `INSERT INTO blobs(workspace_id, hash, size, content_type, created_at_ms, path)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(workspace_id, hash)
     DO UPDATE SET size = excluded.size, content_type = excluded.content_type, path = excluded.path`
  ).run(auth.workspaceId, hash, byteLength, contentType, nowMs(), targetPath);

  sendJson(res, 200, {
    hash,
    size: byteLength,
    contentType,
  });
}

async function handleBlobFetch(req: IncomingMessage, res: ServerResponse, auth: AuthPayload, hash: string): Promise<void> {
  const row = db
    .prepare(`SELECT path, size, content_type FROM blobs WHERE workspace_id = ? AND hash = ?`)
    .get(auth.workspaceId, hash) as { path: string; size: number; content_type: string } | undefined;

  if (!row || !fs.existsSync(row.path)) {
    sendError(res, 404, 'SERVER_ERROR', `Blob not found for hash ${hash}`, false);
    return;
  }

  const stat = fs.statSync(row.path);
  const fileSize = stat.size;
  const rangeHeaderRaw = req.headers.range;
  const rangeHeader = Array.isArray(rangeHeaderRaw) ? rangeHeaderRaw[0] : rangeHeaderRaw;
  const range = parseRangeHeader(rangeHeader, fileSize);

  if (rangeHeader && !range) {
    res.writeHead(416, {
      'content-type': row.content_type,
      'content-range': `bytes */${fileSize}`,
      'accept-ranges': 'bytes',
      'access-control-allow-origin': '*',
    });
    res.end();
    return;
  }

  if (range) {
    const [start, end] = range;
    const chunkSize = end - start + 1;

    res.writeHead(206, {
      'content-type': row.content_type,
      'content-length': chunkSize,
      'content-range': `bytes ${start}-${end}/${fileSize}`,
      'accept-ranges': 'bytes',
      'access-control-allow-origin': '*',
    });

    fs.createReadStream(row.path, { start, end }).pipe(res);
    return;
  }

  res.writeHead(200, {
    'content-type': row.content_type,
    'content-length': fileSize,
    'accept-ranges': 'bytes',
    'access-control-allow-origin': '*',
  });

  fs.createReadStream(row.path).pipe(res);
}

const server = createServer(async (req, res) => {
  try {
    if (!req.url || !req.method) {
      sendError(res, 400, 'SERVER_ERROR', 'Invalid request', false);
      return;
    }

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET,POST,OPTIONS',
        'access-control-allow-headers': 'authorization,content-type',
      });
      res.end();
      return;
    }

    const requestUrl = new URL(req.url, `http://${HOST}:${PORT}`);

    if (req.method === 'POST' && requestUrl.pathname === '/auth/dev') {
      await handleAuthDev(req, res);
      return;
    }

    const auth = requireAuth(req);
    if (!auth) {
      sendError(res, 401, 'AUTH', 'Missing or invalid token', true);
      return;
    }

    if (req.method === 'POST' && requestUrl.pathname === '/sync/push') {
      await handleSyncPush(req, res, auth);
      return;
    }

    if (req.method === 'GET' && requestUrl.pathname === '/sync/pull') {
      await handleSyncPull(req, res, auth);
      return;
    }

    if (req.method === 'POST' && requestUrl.pathname === '/blobs/upload') {
      await handleBlobUpload(req, res, auth);
      return;
    }

    if (req.method === 'GET' && requestUrl.pathname.startsWith('/blobs/')) {
      const hash = requestUrl.pathname.split('/').at(-1) || '';
      await handleBlobFetch(req, res, auth, hash);
      return;
    }

    sendError(res, 404, 'SERVER_ERROR', `Route not found: ${req.method} ${requestUrl.pathname}`, false);
  } catch (error) {
    sendError(res, 500, 'SERVER_ERROR', normalizeError(error), true);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[sync-server] Listening on http://${HOST}:${PORT}`);
  console.log(`[sync-server] Data directory: ${DATA_DIR}`);
});
