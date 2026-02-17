import {
  CURRENT_EVENT_SCHEMA_VERSION,
  MIN_SUPPORTED_EVENT_SCHEMA_VERSION,
  type Event,
  type EventType,
} from './types.js';

function isEventType(value: unknown): value is EventType {
  return (
    value === 'capture.text.create' ||
    value === 'atom.text.update' ||
    value === 'blob.add' ||
    value === 'changeset.suggest.create'
  );
}

function normalizeCreatedAtMs(input: Record<string, unknown>): number {
  const createdAtMsRaw = input.createdAtMs;
  if (typeof createdAtMsRaw === 'number' && Number.isFinite(createdAtMsRaw)) {
    return Math.trunc(createdAtMsRaw);
  }

  const createdAtRaw = input.createdAt;
  if (typeof createdAtRaw === 'string') {
    const parsed = Date.parse(createdAtRaw);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return Date.now();
}

function toOptionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : undefined;
}

export function migrateEvent(raw: unknown): Event {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Invalid event payload: expected object');
  }

  const input = raw as Record<string, unknown>;
  const eventId = input.eventId;
  if (typeof eventId !== 'string' || eventId.length < 8) {
    throw new Error('Invalid event payload: missing eventId');
  }

  const typeRaw = input.type;
  if (!isEventType(typeRaw)) {
    throw new Error(`Invalid event payload: unsupported type ${String(typeRaw)}`);
  }

  const eventSchemaVersionRaw = input.eventSchemaVersion;
  const eventSchemaVersion =
    typeof eventSchemaVersionRaw === 'number' && Number.isFinite(eventSchemaVersionRaw)
      ? Math.trunc(eventSchemaVersionRaw)
      : 1;

  if (eventSchemaVersion < MIN_SUPPORTED_EVENT_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported event schema version ${eventSchemaVersion}. Minimum supported is ${MIN_SUPPORTED_EVENT_SCHEMA_VERSION}.`,
    );
  }

  if (eventSchemaVersion > CURRENT_EVENT_SCHEMA_VERSION) {
    throw new Error(
      `Event schema version ${eventSchemaVersion} is newer than this client (${CURRENT_EVENT_SCHEMA_VERSION}).`,
    );
  }

  const deviceId = input.deviceId;
  const workspaceId = input.workspaceId;
  if (typeof deviceId !== 'string' || typeof workspaceId !== 'string') {
    throw new Error('Invalid event payload: missing deviceId/workspaceId');
  }

  const payload = input.payload;
  if (!payload || typeof payload !== 'object') {
    throw new Error('Invalid event payload: payload must be object');
  }

  return {
    eventId,
    eventSchemaVersion,
    payloadSchemaVersion: toOptionalNumber(input.payloadSchemaVersion),
    type: typeRaw,
    createdAtMs: normalizeCreatedAtMs(input),
    deviceId,
    workspaceId,
    localSeq: toOptionalNumber(input.localSeq),
    serverSeq: toOptionalNumber(input.serverSeq),
    payload: payload as Event['payload'],
  };
}
