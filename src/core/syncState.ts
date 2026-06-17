// Utilities that are backend-agnostic: hashing, binary detection, path helpers.
// No GCS / git specifics here.

import * as crypto from "crypto";

/** Stable content hash used to detect whether a file changed. */
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

/**
 * Parse git conflict markers in text content and return the two sides.
 * Returns null if no conflict markers are found.
 *
 * Standard git conflict block:
 *   <<<<<<< HEAD
 *   (ours)
 *   =======
 *   (theirs)
 *   >>>>>>> branch-name
 */
export function parseConflictMarkers(
  text: string
): { ours: string; theirs: string } | null {
  const START = /^<{7} /m;
  const SEP   = /^={7}$/m;
  const END   = /^>{7} /m;

  if (!START.test(text)) return null;

  const enc = new TextEncoder();
  const lines = text.split("\n");
  const ourLines: string[] = [];
  const theirLines: string[] = [];
  let state: "before" | "ours" | "theirs" | "after" = "before";

  for (const line of lines) {
    if (state === "before" && line.startsWith("<<<<<<<")) {
      state = "ours";
    } else if (state === "ours" && line === "=======") {
      state = "theirs";
    } else if (state === "theirs" && line.startsWith(">>>>>>>")) {
      state = "after";
    } else if (state === "ours") {
      ourLines.push(line);
    } else if (state === "theirs") {
      theirLines.push(line);
    }
  }

  void enc; // kept to show intent; callers use TextEncoder themselves
  if (state !== "after") return null;
  return { ours: ourLines.join("\n"), theirs: theirLines.join("\n") };
}

/** Vault-relative path → repo-relative path given a local folder root. */
export function vaultToRepo(vaultPath: string, localFolder: string): string {
  const prefix = localFolder === "" ? "" : localFolder + "/";
  return vaultPath.startsWith(prefix)
    ? vaultPath.slice(prefix.length)
    : vaultPath;
}

/** Repo-relative path → vault-relative path given a local folder root. */
export function repoToVault(repoPath: string, localFolder: string): string {
  return localFolder === "" ? repoPath : `${localFolder}/${repoPath}`;
}
