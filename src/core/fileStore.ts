// Injected interfaces — decouple core/ from any specific runtime.
// Obsidian provides VaultFileStore + PluginSyncStateStore.
// A future MCP server provides DiskFileStore + JsonSyncStateStore.

import type { GitFolderMapping, SyncStateMap } from "./types";

// ── Local file system ─────────────────────────────────────────────────────────

export interface LocalFile {
  /** Vault-relative path, forward slashes, no leading slash. */
  path: string;
}

export interface FileStore {
  list(folder: string): Promise<LocalFile[]>;
  read(path: string): Promise<Uint8Array | null>;
  write(path: string, data: Uint8Array): Promise<void>;
  delete(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
}

// ── Sync state persistence ────────────────────────────────────────────────────

export interface SyncStateStore {
  load(): Promise<SyncStateMap>;
  save(state: SyncStateMap): Promise<void>;
}

// ── Git backend (the key seam for MCP reuse) ─────────────────────────────────

/**
 * Abstraction over isomorphic-git operations. SyncEngine depends only on this
 * interface — the concrete GitBackend (src/core/gitBackend.ts) can be swapped
 * for a mock or a different implementation without touching the engine.
 *
 * MCP path: a future MCP server imports GitBackend, provides a DiskFileStore,
 * and exposes pushAll/pullAll as MCP tools. Claude appears in git history as
 * just another author.
 */
export interface IGitBackend {
  /**
   * Ensure the repo is ready: clone if the gitdir doesn't exist yet, or verify
   * the remote URL matches if it does. Must be called before any other method.
   */
  init(mapping: GitFolderMapping, pat: string): Promise<void>;

  /**
   * Fetch from origin and attempt a merge into the worktree. Returns the vault-
   * relative paths of any files that ended up with conflict markers (i.e. the
   * merge could not complete automatically).
   */
  pull(mapping: GitFolderMapping, pat: string): Promise<string[]>;

  /**
   * Stage all changes in the worktree, commit, and push. Returns false (no-op)
   * if the worktree is clean. Throws on push failure (e.g. non-fast-forward —
   * caller should pull first and retry).
   */
  push(
    mapping: GitFolderMapping,
    pat: string,
    author: string,
    message?: string
  ): Promise<boolean>;

  /**
   * After the user resolves a conflict: write the merged content, stage the
   * specific file, commit, and push.
   */
  resolveAndPush(
    mapping: GitFolderMapping,
    pat: string,
    localPath: string,
    mergedContent: Uint8Array,
    author: string
  ): Promise<void>;

  /** True if the worktree has uncommitted changes (staged or unstaged). */
  isDirty(mapping: GitFolderMapping): Promise<boolean>;

  /** SHA of the current HEAD commit, or null if the repo has no commits yet. */
  headSha(mapping: GitFolderMapping): Promise<string | null>;
}

// ── HTTP transport (kept for potential future use, e.g. GitHub API calls) ────

export interface HttpResponse {
  status: number;
  text: string;
  arrayBuffer: ArrayBuffer;
  headers: Record<string, string>;
}

export interface HttpRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string | ArrayBuffer | Uint8Array;
}

export type HttpFn = (req: HttpRequest) => Promise<HttpResponse>;
