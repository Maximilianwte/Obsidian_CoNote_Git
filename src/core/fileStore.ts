// Injected interfaces that decouple core/ from any specific runtime.
// Obsidian provides a VaultFileStore; an MCP server would provide a DiskFileStore.

import type { RemoteFile, RemoteObject, SyncStateMap } from "./types";

/**
 * Structural interface for the remote storage layer. Both GcsClient (v1/MCP,
 * talks to GCS directly) and ApiClient (v2, talks to the Cloud Function proxy)
 * satisfy this shape so SyncEngine doesn't care which one it gets.
 */
export interface IGcsClient {
  list(prefix: string): Promise<RemoteObject[]>;
  download(objectName: string): Promise<RemoteFile | null>;
  getGeneration(objectName: string): Promise<string | null>;
  upload(
    objectName: string,
    data: Uint8Array,
    ifGenerationMatch: string,
    author?: string,
    contentType?: string
  ): Promise<string>;
  delete(objectName: string, ifGenerationMatch?: string): Promise<void>;
}

/** A single file listed from the local store. */
export interface LocalFile {
  /** Vault-relative path, forward slashes, no leading slash. */
  path: string;
}

/** Abstraction over the local file system (vault, disk, memory, ...). */
export interface FileStore {
  /** List all files under a folder (recursive), vault-relative paths. */
  list(folder: string): Promise<LocalFile[]>;
  /** Read raw bytes; returns null if the file does not exist. */
  read(path: string): Promise<Uint8Array | null>;
  /** Create/overwrite a file with raw bytes, creating parent folders. */
  write(path: string, data: Uint8Array): Promise<void>;
  /** Delete a file; no-op if it does not exist. */
  delete(path: string): Promise<void>;
  /** True if the path exists. */
  exists(path: string): Promise<boolean>;
}

/** Persists the per-file sync-state map (Obsidian: plugin data; MCP: a JSON file). */
export interface SyncStateStore {
  load(): Promise<SyncStateMap>;
  save(state: SyncStateMap): Promise<void>;
}

/**
 * Minimal HTTP response shape, modeled on Obsidian's requestUrl. The injected
 * HTTP function never throws on non-2xx — callers inspect `status`.
 */
export interface HttpResponse {
  status: number;
  /** Decoded text body (may be empty for binary). */
  text: string;
  /** Raw body bytes. */
  arrayBuffer: ArrayBuffer;
  /** Response headers, lowercased keys. */
  headers: Record<string, string>;
}

export interface HttpRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  /** Request body: string or raw bytes. */
  body?: string | ArrayBuffer | Uint8Array;
}

/** Pluggable HTTP transport: Obsidian's requestUrl, or Node fetch/https. */
export type HttpFn = (req: HttpRequest) => Promise<HttpResponse>;
