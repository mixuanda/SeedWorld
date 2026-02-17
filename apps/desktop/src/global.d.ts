import type { WorldSeedAPI } from './preload';

export type {
  Note,
  NoteInput,
  NoteIndex,
  NoteIndexEntry,
  VaultSyncHealthReport,
  VoiceNote,
  ProviderMode,
  LocalProviderConfig,
  OnlineProviderConfig,
  ProviderConfig,
  SafeProviderConfig,
  TestConnectionResult,
  VaultAPI,
  AIAPI,
  VoiceAPI,
  AttachmentAPI,
  WhisperStatus,
  WhisperProgress,
  WhisperAPI,
  AuthConfig,
  LocalWorkspaceIdentity,
  InboxItem,
  SyncError,
  SyncStatus,
  AuthAPI,
  InboxAPI,
  CaptureAPI,
  SyncAPI,
  ExportAPI,
  DiagnosticsAPI,
  ImportAPI,
  WorldSeedAPI,
} from './preload';

declare global {
  interface Window {
    api: WorldSeedAPI;
  }
}

export {};
