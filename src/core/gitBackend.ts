// isomorphic-git backend. Runs in Electron/Node — no system git binary needed.
//
// Key design: the .git directory is stored OUTSIDE the vault folder
// (in the plugin's data dir) to keep the vault clean. isomorphic-git
// supports this via the separate `gitdir` + `dir` (worktree) options.

import git from "isomorphic-git";
import http from "isomorphic-git/http/node";
import * as fs from "fs";
import * as nodePath from "path";
import type { IGitBackend } from "./fileStore";
import type { GitFolderMapping } from "./types";
import { isBinary, parseConflictMarkers } from "./syncState";

export class GitBackend implements IGitBackend {
  /**
   * @param reposBasePath  Absolute path to the directory where gitdirs are stored.
   *                       e.g. "/vault/.obsidian/plugins/conote-git/repos"
   * @param vaultBasePath  Absolute path to the vault root.
   */
  constructor(
    private readonly reposBasePath: string,
    private readonly vaultBasePath: string
  ) {}

  // ── Public IGitBackend methods ────────────────────────────────────────────

  async init(mapping: GitFolderMapping, pat: string): Promise<void> {
    const { dir, gitdir } = this.paths(mapping);
    fs.mkdirSync(gitdir, { recursive: true });
    fs.mkdirSync(dir, { recursive: true });

    const alreadyInited = fs.existsSync(nodePath.join(gitdir, "HEAD"));
    if (alreadyInited) {
      // Verify the remote URL matches; update if not.
      try {
        const remotes = await git.listRemotes({ fs, dir, gitdir });
        const origin = remotes.find((r) => r.remote === "origin");
        if (origin && origin.url !== mapping.repoUrl) {
          await git.setConfig({
            fs, dir, gitdir,
            path: "remote.origin.url",
            value: mapping.repoUrl,
          });
        }
      } catch {
        // If we can't list remotes the repo may be corrupted; re-clone below.
      }
      return;
    }

    // Clone into gitdir (separate from worktree).
    await git.clone({
      fs,
      http,
      dir,
      gitdir,
      url: mapping.repoUrl,
      ref: mapping.branch,
      singleBranch: true,
      depth: 50,
      onAuth: () => ({ username: pat, password: "" }),
      onAuthFailure: () => ({ cancel: true }),
    });
  }

  async pull(mapping: GitFolderMapping, pat: string): Promise<string[]> {
    const { dir, gitdir } = this.paths(mapping);

    // Fetch latest from origin.
    await git.fetch({
      fs,
      http,
      dir,
      gitdir,
      remote: "origin",
      ref: mapping.branch,
      singleBranch: true,
      onAuth: () => ({ username: pat, password: "" }),
      onAuthFailure: () => ({ cancel: true }),
    });

    const localSha  = await this.headSha(mapping);
    const remoteSha = await this.remoteHeadSha(mapping);

    if (!remoteSha || localSha === remoteSha) return []; // already up to date

    // Attempt merge.
    try {
      const result = await git.merge({
        fs,
        dir,
        gitdir,
        ours: mapping.branch,
        theirs: `origin/${mapping.branch}`,
        abortOnConflict: false,
        author: { name: "Conote Sync", email: "sync@conote" },
      });

      if (!result.alreadyMerged) {
        // Checkout the merge result into the worktree.
        await git.checkout({
          fs,
          dir,
          gitdir,
          ref: mapping.branch,
          force: true,
        });
      }
      return []; // clean merge
    } catch {
      // isomorphic-git throws on merge conflict; fall through to parse conflicts.
      const conflicted = await this.findConflictedFiles(dir, gitdir, mapping);
      return conflicted;
    }
  }

  async push(
    mapping: GitFolderMapping,
    pat: string,
    author: string,
    message?: string
  ): Promise<boolean> {
    const { dir, gitdir } = this.paths(mapping);

    // Stage everything in the worktree.
    await git.add({ fs, dir, gitdir, filepath: "." });

    // Check if there's anything to commit.
    const statusMatrix = await git.statusMatrix({ fs, dir, gitdir });
    const hasChanges = statusMatrix.some(
      ([, head, workdir, stage]) => head !== 1 || workdir !== 1 || stage !== 1
    );
    if (!hasChanges) return false;

    const [name, email] = parseAuthor(author);
    await git.commit({
      fs,
      dir,
      gitdir,
      message: message ?? `Auto-sync from ${author}`,
      author: { name, email, timestamp: Math.floor(Date.now() / 1000), timezoneOffset: 0 },
    });

    await git.push({
      fs,
      http,
      dir,
      gitdir,
      remote: "origin",
      ref: mapping.branch,
      onAuth: () => ({ username: pat, password: "" }),
      onAuthFailure: () => ({ cancel: true }),
    });

    return true;
  }

  async resolveAndPush(
    mapping: GitFolderMapping,
    pat: string,
    localPath: string,
    mergedContent: Uint8Array,
    author: string
  ): Promise<void> {
    const { dir, gitdir } = this.paths(mapping);

    // Write the resolved content.
    const absPath = nodePath.join(dir, localPath);
    fs.mkdirSync(nodePath.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, mergedContent);

    // Stage only the resolved file.
    await git.add({ fs, dir, gitdir, filepath: localPath });

    const [name, email] = parseAuthor(author);
    await git.commit({
      fs,
      dir,
      gitdir,
      message: `Resolve conflict in ${localPath}`,
      author: { name, email, timestamp: Math.floor(Date.now() / 1000), timezoneOffset: 0 },
    });

    await git.push({
      fs,
      http,
      dir,
      gitdir,
      remote: "origin",
      ref: mapping.branch,
      onAuth: () => ({ username: pat, password: "" }),
      onAuthFailure: () => ({ cancel: true }),
    });
  }

  async isDirty(mapping: GitFolderMapping): Promise<boolean> {
    const { dir, gitdir } = this.paths(mapping);
    try {
      const matrix = await git.statusMatrix({ fs, dir, gitdir });
      return matrix.some(
        ([, head, workdir, stage]) => head !== 1 || workdir !== 1 || stage !== 1
      );
    } catch {
      return false;
    }
  }

  async headSha(mapping: GitFolderMapping): Promise<string | null> {
    const { dir, gitdir } = this.paths(mapping);
    try {
      return await git.resolveRef({ fs, dir, gitdir, ref: "HEAD" });
    } catch {
      return null;
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  paths(mapping: GitFolderMapping): { dir: string; gitdir: string } {
    return {
      dir:    nodePath.join(this.vaultBasePath, mapping.localFolder),
      gitdir: nodePath.join(this.reposBasePath, mapping.id),
    };
  }

  private async remoteHeadSha(mapping: GitFolderMapping): Promise<string | null> {
    const { dir, gitdir } = this.paths(mapping);
    try {
      return await git.resolveRef({
        fs, dir, gitdir,
        ref: `refs/remotes/origin/${mapping.branch}`,
      });
    } catch {
      return null;
    }
  }

  /**
   * After a failed merge attempt, walk the worktree and find files that contain
   * git conflict markers. Returns vault-relative paths.
   */
  private async findConflictedFiles(
    dir: string,
    gitdir: string,
    mapping: GitFolderMapping
  ): Promise<string[]> {
    // git.statusMatrix after a failed merge marks conflicted files with
    // workdir=2 (modified) or similar. The most reliable approach is to
    // scan for conflict markers in text files.
    const matrix = await git.statusMatrix({ fs, dir, gitdir });
    const conflicted: string[] = [];

    for (const [filepath] of matrix) {
      const absPath = nodePath.join(dir, filepath);
      if (!fs.existsSync(absPath)) continue;
      const bytes = fs.readFileSync(absPath);
      if (isBinary(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength))) continue;
      const text = bytes.toString("utf8");
      if (parseConflictMarkers(text) !== null) {
        const vaultPath = mapping.localFolder
          ? `${mapping.localFolder}/${filepath}`
          : filepath;
        conflicted.push(vaultPath);
      }
    }
    return conflicted;
  }
}

/** Split "Name <email>" or just "Name" into [name, email]. */
function parseAuthor(author: string): [string, string] {
  const m = author.match(/^(.+?)\s*<(.+)>$/);
  if (m) return [m[1].trim(), m[2].trim()];
  return [author || "Conote User", `${(author || "conote").replace(/\s+/g, ".")}@conote.sync`];
}
