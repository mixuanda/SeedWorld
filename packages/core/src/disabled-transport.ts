import type {
  PullRequest,
  PullResponse,
  PushRequest,
  PushResponse,
  SyncTransport,
} from './types';

const DEFAULT_MESSAGE = 'AUTH: Sign in required for sync';

export function createDisabledSyncTransport(message = DEFAULT_MESSAGE): SyncTransport {
  async function fail(): Promise<never> {
    throw new Error(message);
  }

  return {
    push(_request: PushRequest): Promise<PushResponse> {
      return fail();
    },
    pull(_request: PullRequest): Promise<PullResponse> {
      return fail();
    },
    uploadBlob(): Promise<void> {
      return fail();
    },
    downloadBlob(): Promise<Uint8Array> {
      return fail();
    },
  };
}
