// Backend-agnostic shared types. No Obsidian imports allowed in this directory.

/** Maps a local vault subfolder to an independent GitHub repo. */
export interface GitFolderMapping {
  /** Stable ID (uuid-style). Used as the gitdir folder name. */
  id: string;
  /** Vault-relative folder path, no leading/trailing slash. e.g. "Shared/ProjectX" */
  localFolder: string;
  /** GitHub repo HTTPS URL. e.g. "https://github.com/user/projectx" */
  repoUrl: string;
  /** Branch to track. Defaults to "main". */
  branch: string;
  /** Human-readable label shown in UI. */
  label: string;
}

/** Per-mapping sync bookkeeping, persisted between sessions. */
export interface MappingSyncState {
  /** SHA of HEAD after the last successful push/pull. */
  lastCommitSha: string;
  /** Whether any conflicted files are pending resolution. */
  hasConflicts: boolean;
}

/** Whole-plugin sync state keyed by mapping ID. */
export type SyncStateMap = Record<string, MappingSyncState>;

/**
 * A text-file conflict detected after a git merge attempt.
 * Returned as plain data so the UI (Obsidian merge modal) or an MCP server
 * can decide how to resolve it.
 */
export interface Conflict {
  /** Mapping this conflict belongs to. */
  mappingId: string;
  /** Vault-relative path of the conflicted file. */
  localPath: string;
  /** "Ours" content (current HEAD before merge). */
  localContent: Uint8Array;
  /** "Theirs" content (incoming remote). */
  remoteContent: Uint8Array;
  /** Author of the incoming change, extracted from git log if available. */
  remoteAuthor?: string;
}

export type SyncEvent =
  | { type: "pushed";   mappingId: string; commitSha: string }
  | { type: "pulled";   mappingId: string; commitSha: string }
  | { type: "conflict"; conflict: Conflict }
  | { type: "error";    message: string; mappingId?: string };

export type SyncEventHandler = (event: SyncEvent) => void | Promise<void>;
