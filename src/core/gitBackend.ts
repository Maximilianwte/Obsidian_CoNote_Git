// isomorphic-git backend. Runs in Electron/Node — no system git binary needed.
//
// Key design: the .git directory is stored OUTSIDE the vault folder
// (in the plugin's data dir) to keep the vault clean. isomorphic-git
// supports this via the separate `gitdir` + `dir` (worktree) options.

import git from "isomorphic-git";
import http from "isomorphic-git/http/node";
import type { IGitBackend } from "./fileStore";
import type { GitFolderMapping } from "./types";
import { isBinary, parseConflictMarkers } from "./syncState";
import { fs, gitFs, nodePath } from "./nodeApi";

export class GitBackend implements IGitBackend {
  /**
   * @param reposBasePath  Absolute path to the directory where gitdirs are stored.
   *                       e.g. "/vault/.obsidian/plugins/conote-git/repos"
   * @param vaultBasePath  Absolute path to the vault root.
   * @param configDirName  Vault's config dir (usually ".obsidian"). When
   *                       syncing the entire vault, this directory sits
   *                       inside the worktree — it must be gitignored or
   *                       every push would recursively stage the plugin's
   *                       own git data (self-referential) and, critically,
   *                       every plugin's data.json (including this plugin's
   *                       own stored GitHub token).
   */
  constructor(
    private readonly reposBasePath: string,
    private readonly vaultBasePath: string,
    private readonly configDirName: string
  ) {}

  // ── Public IGitBackend methods ────────────────────────────────────────────

  async init(mapping: GitFolderMapping, pat: string): Promise<void> {
    const { dir, gitdir } = this.paths(mapping);
    fs.mkdirSync(gitdir, { recursive: true });
    fs.mkdirSync(dir, { recursive: true });
    this.ensureVaultGitignore(mapping, dir);

    const alreadyInited = fs.existsSync(nodePath.join(gitdir, "HEAD"));
    if (alreadyInited) {
      // Verify the remote URL matches; update if not.
      try {
        const remotes = await git.listRemotes({ fs: gitFs, dir, gitdir });
        const origin = remotes.find((r) => r.remote === "origin");
        if (origin && origin.url !== mapping.repoUrl) {
          await git.setConfig({
            fs: gitFs, dir, gitdir,
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
      fs: gitFs,
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
      fs: gitFs,
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
        fs: gitFs,
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
          fs: gitFs,
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
    this.ensureVaultGitignore(mapping, dir);

    // Stage everything in the worktree. git.add does not stage deletions,
    // so stage those explicitly — otherwise renamed/deleted notes reappear
    // on collaborators' machines.
    await git.add({ fs: gitFs, dir, gitdir, filepath: "." });
    const statusMatrix = await git.statusMatrix({ fs: gitFs, dir, gitdir });
    for (const [filepath, head, workdir] of statusMatrix) {
      if (head === 1 && workdir === 0) {
        await git.remove({ fs: gitFs, dir, gitdir, filepath });
      }
    }

    // Check if there's anything to commit.
    const hasChanges = statusMatrix.some(
      ([, head, workdir, stage]) => head !== 1 || workdir !== 1 || stage !== 1
    );
    if (!hasChanges) return false;

    const [name, email] = parseAuthor(author);
    await git.commit({
      fs: gitFs,
      dir,
      gitdir,
      message: message ?? `Auto-sync from ${author}`,
      author: { name, email, timestamp: Math.floor(Date.now() / 1000), timezoneOffset: 0 },
    });

    await git.push({
      fs: gitFs,
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
    await git.add({ fs: gitFs, dir, gitdir, filepath: localPath });

    const [name, email] = parseAuthor(author);
    await git.commit({
      fs: gitFs,
      dir,
      gitdir,
      message: `Resolve conflict in ${localPath}`,
      author: { name, email, timestamp: Math.floor(Date.now() / 1000), timezoneOffset: 0 },
    });

    await git.push({
      fs: gitFs,
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
      const matrix = await git.statusMatrix({ fs: gitFs, dir, gitdir });
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
      return await git.resolveRef({ fs: gitFs, dir, gitdir, ref: "HEAD" });
    } catch {
      return null;
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  /**
   * When syncing the entire vault, ensure the vault's config dir (which
   * contains this plugin's own git data, other plugins' data.json files,
   * and this plugin's own stored GitHub token) is excluded from tracking.
   * Appends to an existing .gitignore rather than overwriting it.
   */
  private ensureVaultGitignore(mapping: GitFolderMapping, dir: string): void {
    if (mapping.localFolder !== "/") return; // configDir only sits inside the worktree for whole-vault syncs
    const ignoreEntry = `${this.configDirName}/`;
    const gitignorePath = nodePath.join(dir, ".gitignore");

    let existing = "";
    if (fs.existsSync(gitignorePath)) {
      existing = fs.readFileSync(gitignorePath).toString("utf8");
    }
    if (existing.split(/\r?\n/).some((line) => line.trim() === ignoreEntry)) return;

    const separator = existing.length && !existing.endsWith("\n") ? "\n" : "";
    const updated = `${existing}${separator}${ignoreEntry}\n`;
    fs.writeFileSync(gitignorePath, new TextEncoder().encode(updated));
  }

  paths(mapping: GitFolderMapping): { dir: string; gitdir: string } {
    // localFolder "/" means the entire vault is the worktree.
    const folder = mapping.localFolder === "/" ? "" : mapping.localFolder;
    return {
      dir:    nodePath.join(this.vaultBasePath, folder),
      gitdir: nodePath.join(this.reposBasePath, mapping.id),
    };
  }

  private async remoteHeadSha(mapping: GitFolderMapping): Promise<string | null> {
    const { dir, gitdir } = this.paths(mapping);
    try {
      return await git.resolveRef({
        fs: gitFs, dir, gitdir,
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
    const matrix = await git.statusMatrix({ fs: gitFs, dir, gitdir });
    const conflicted: string[] = [];

    for (const [filepath] of matrix) {
      const absPath = nodePath.join(dir, filepath);
      if (!fs.existsSync(absPath)) continue;
      const bytes = fs.readFileSync(absPath);
      if (isBinary(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength))) continue;
      const text = bytes.toString("utf8");
      if (parseConflictMarkers(text) !== null) {
        const folder = mapping.localFolder === "/" ? "" : mapping.localFolder;
        conflicted.push(folder ? `${folder}/${filepath}` : filepath);
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
