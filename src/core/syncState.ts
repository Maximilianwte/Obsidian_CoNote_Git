// Helpers around the per-file sync-state map, plus content hashing and path
// mapping between local (vault-relative) paths and bucket object names.

import * as crypto from "crypto";
import type { FolderMapping } from "./types";

/** Stable content hash used to detect whether a file changed since last sync. */
export function hashContent(data: Uint8Array): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

/** Heuristic: treat as binary if a NUL byte appears in the first 8 KB. */
export function isBinary(data: Uint8Array): boolean {
  const limit = Math.min(data.length, 8192);
  for (let i = 0; i < limit; i++) {
    if (data[i] === 0) return true;
  }
  return false;
}

/** Guess a Content-Type from the file extension (text-friendly defaults). */
export function contentTypeFor(path: string): string {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  switch (ext) {
    case "md":
      return "text/markdown; charset=utf-8";
    case "txt":
      return "text/plain; charset=utf-8";
    case "json":
      return "application/json; charset=utf-8";
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "svg":
      return "image/svg+xml";
    case "pdf":
      return "application/pdf";
    default:
      return "application/octet-stream";
  }
}

/** Normalize a folder path: strip leading/trailing slashes. */
function normFolder(folder: string): string {
  return folder.replace(/^\/+/, "").replace(/\/+$/, "");
}

/** Map a vault-relative local path to a bucket object name, or null if unmapped. */
export function localToObject(
  localPath: string,
  mappings: FolderMapping[]
): string | null {
  for (const m of mappings) {
    const local = normFolder(m.localFolder);
    const prefix = normFolder(m.bucketPrefix);
    if (localPath === local) continue; // the folder itself, not a file
    if (local === "" || localPath.startsWith(local + "/")) {
      const rel = local === "" ? localPath : localPath.slice(local.length + 1);
      return prefix === "" ? rel : `${prefix}/${rel}`;
    }
  }
  return null;
}

/** Map a bucket object name back to a vault-relative local path, or null. */
export function objectToLocal(
  objectName: string,
  mappings: FolderMapping[]
): string | null {
  for (const m of mappings) {
    const local = normFolder(m.localFolder);
    const prefix = normFolder(m.bucketPrefix);
    if (prefix === "" || objectName.startsWith(prefix + "/")) {
      const rel =
        prefix === "" ? objectName : objectName.slice(prefix.length + 1);
      return local === "" ? rel : `${local}/${rel}`;
    }
  }
  return null;
}

/** Build a "keep both" sibling path for unmergeable (binary) conflicts. */
export function conflictCopyPath(localPath: string, author: string): string {
  const dot = localPath.lastIndexOf(".");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const safeAuthor = author.replace(/[\\/:*?"<>|]/g, "_") || "remote";
  const suffix = ` (conflict from ${safeAuthor} ${stamp})`;
  if (dot <= localPath.lastIndexOf("/")) return localPath + suffix;
  return localPath.slice(0, dot) + suffix + localPath.slice(dot);
}
