import { ulid } from 'ulid';
import { v7 as uuidv7 } from 'uuid';
import {
  CURRENT_EVENT_SCHEMA_VERSION,
  type Event,
  type EventDraft,
  type EventType,
  type StoredEvent,
} from './types';

export function generateEventId(): string {
  try {
    if (typeof uuidv7 === 'function') {
      return uuidv7();
    }
  } catch {
    // Fall through to ULID.
  }
  return ulid();
}

export function createEvent<TType extends EventType>(args: {
  draft: EventDraft<TType>;
  deviceId: string;
  workspaceId: string;
  localSeq: number;
}): Event<TType> {
  const createdAtMs =
    typeof args.draft.createdAtMs === 'number' && Number.isFinite(args.draft.createdAtMs)
      ? Math.trunc(args.draft.createdAtMs)
      : Date.now();

  return {
    eventId: generateEventId(),
    eventSchemaVersion: CURRENT_EVENT_SCHEMA_VERSION,
    payloadSchemaVersion: args.draft.payloadSchemaVersion,
    type: args.draft.type,
    createdAtMs,
    deviceId: args.deviceId,
    workspaceId: args.workspaceId,
    localSeq: args.localSeq,
    payload: args.draft.payload,
  };
}

export function withStoredMetadata(event: Event): StoredEvent {
  return {
    ...event,
    syncStatus: event.serverSeq ? 'synced' : 'saved_local',
  };
}
