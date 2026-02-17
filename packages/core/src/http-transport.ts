import {
  type PullRequest,
  type PullResponse,
  type PushRequest,
  type PushResponse,
  type SyncTransport,
} from './types.js';

export interface HttpTransportOptions {
  baseUrl: string;
  token: string;
}

export function createHttpSyncTransport(options: HttpTransportOptions): SyncTransport {
  const baseUrl = options.baseUrl.replace(/\/+$/, '');

  async function request<T>(path: string, init: RequestInit): Promise<T> {
    const response = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${options.token}`,
        ...(init.headers || {}),
      },
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(text || `HTTP ${response.status}`);
    }

    return (await response.json()) as T;
  }

  return {
    push(requestPayload: PushRequest): Promise<PushResponse> {
      return request<PushResponse>('/sync/push', {
        method: 'POST',
        body: JSON.stringify(requestPayload),
      });
    },

    pull(requestPayload: PullRequest): Promise<PullResponse> {
      const query = new URLSearchParams({ cursor: String(requestPayload.cursor) });
      return request<PullResponse>(`/sync/pull?${query.toString()}`, {
        method: 'GET',
      });
    },

    async uploadBlob(workspaceId: string, hash: string, contentType: string, bytes: Uint8Array): Promise<void> {
      const response = await fetch(
        `${baseUrl}/blobs/upload?workspaceId=${encodeURIComponent(workspaceId)}&hash=${encodeURIComponent(hash)}&contentType=${encodeURIComponent(contentType)}`,
        {
          method: 'POST',
          body: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
          headers: {
            authorization: `Bearer ${options.token}`,
            'content-type': 'application/octet-stream',
          },
        },
      );

      if (!response.ok) {
        const text = await response.text();
        throw new Error(text || `HTTP ${response.status}`);
      }
    },

    async downloadBlob(_workspaceId: string, hash: string): Promise<Uint8Array> {
      const response = await fetch(`${baseUrl}/blobs/${encodeURIComponent(hash)}`, {
        method: 'GET',
        headers: {
          authorization: `Bearer ${options.token}`,
        },
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(text || `HTTP ${response.status}`);
      }

      return new Uint8Array(await response.arrayBuffer());
    },
  };
}
