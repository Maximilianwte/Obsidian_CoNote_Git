// Backend-agnostic shared types. No Obsidian imports allowed in this directory.

/** Maps a local folder (vault-relative path) to a prefix in the GCS bucket. */
export interface FolderMapping {
  /** Local folder path, vault-relative, no leading/trailing slash. e.g. "Shared/notes" */
  localFolder: string;
  /** Object-name prefix in the bucket, no leading slash. e.g. "notes" */
  bucketPrefix: string;
}

/** Credentials parsed from a Google service-account JSON key. */
export interface ServiceAccountKey {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

/** Per-file sync bookkeeping, persisted between sessions. */
export interface FileSyncState {
  /** GCS object generation we last reconciled with. "0" means not yet uploaded. */
  remoteGeneration: string;
  /** Hash of the file content as it was at the last successful sync. */
  syncedHash: string;
  /** True while a conflict is unresolved; the file is excluded from auto-push. */
  conflicted?: boolean;
}

/** Whole-vault sync state keyed by local (vault-relative) path. */
export type SyncStateMap = Record<string, FileSyncState>;

/** Metadata about a remote object returned by a list call. */
export interface RemoteObject {
  /** Full object name in the bucket, e.g. "notes/foo.md". */
  name: string;
  generation: string;
  /** Custom metadata: author display name, if set. */
  author?: string;
  /** Size in bytes, from the listing. */
  size?: number;
  updated?: string;
}

/** Content + generation of a single downloaded object. */
export interface RemoteFile {
  content: Uint8Array;
  generation: string;
  author?: string;
}

/**
 * A detected edit collision: both the local copy and the remote copy changed
 * since the last sync. Returned as plain data so UI (Obsidian) or an MCP server
 * can decide how to resolve it.
 */
export interface Conflict {
  /** Vault-relative local path. */
  localPath: string;
  /** Remote object name. */
  objectName: string;
  /** Local file content at conflict time. */
  localContent: Uint8Array;
  /** Remote file content at conflict time. */
  remoteContent: Uint8Array;
  /** Remote generation that must be matched when the resolution is uploaded. */
  remoteGeneration: string;
  /** Author of the remote change, if known. */
  remoteAuthor?: string;
  /** True if the content is non-text (binary) — line merge is not possible. */
  binary: boolean;
}

/** A folder mapping for v2: also carries the share ID if it's a shared folder. */
export interface FolderMappingV2 {
  localFolder: string;
  /** GCS object prefix, e.g. "users/{uid}/MyNotes" or "users/{ownerId}/ProjectX" */
  gcsPrefix: string;
  /** Set if this mapping points at a shared folder owned by someone else. */
  shareId?: string;
  /** Human-readable name shown in UI. */
  name?: string;
}

/** Authenticated user info, stored in plugin data. */
export interface UserProfile {
  uid: string;
  email: string;
  displayName?: string;
}

/** A shared folder as returned by the Cloud Function /shares API. */
export interface ShareInfo {
  shareId: string;
  name: string;
  gcsPrefix: string;
  role: "owner" | "member";
  ownerEmail?: string;
}

export type SyncEvent =
  | { type: "pushed"; localPath: string }
  | { type: "pulled"; localPath: string }
  | { type: "deleted-local"; localPath: string }
  | { type: "deleted-remote"; localPath: string }
  | { type: "conflict"; conflict: Conflict }
  | { type: "error"; message: string; localPath?: string };

export type SyncEventHandler = (event: SyncEvent) => void | Promise<void>;
