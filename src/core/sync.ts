// Sync engine v3 — git-backed. Much simpler than v1/v2 because git handles
// all file tracking; the engine just orchestrates timing and surfaces conflicts.
// No Obsidian imports — pure core, reusable by MCP server.

import type { IGitBackend, SyncStateStore } from "./fileStore";
import type {
  Conflict,
  GitFolderMapping,
  SyncEventHandler,
  SyncStateMap,
} from "./types";
import { parseConflictMarkers } from "./syncState";
import { fs, nodePath } from "./nodeApi";

export interface SyncEngineConfig {
  mappings: GitFolderMapping[];
  pat: string;
  author: string;
}

export class SyncEngine {
  private state: SyncStateMap = {};
  private loaded = false;
  private pushing = false;
  private pulling = false;
  /** Last error emitted per mapping — avoids spamming the same notice every cycle. */
  private lastPushError = new Map<string, string>();

  constructor(
    private readonly backend: IGitBackend,
    private readonly vaultBasePath: string,
    private readonly stateStore: SyncStateStore,
    private config: SyncEngineConfig,
    private readonly emit: SyncEventHandler
  ) {}

  updateConfig(config: SyncEngineConfig): void {
    this.config = config;
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /** Push all dirty mappings. Called after debounce on file save. */
  async pushAll(): Promise<void> {
    if (this.pushing) return;
    this.pushing = true;
    try {
      await this.ensureLoaded();
      for (const mapping of this.config.mappings) {
        await this.pushMapping(mapping);
      }
    } finally {
      this.pushing = false;
    }
  }

  /** Push a single mapping — used when we know exactly which folder changed. */
  async pushMapping(mapping: GitFolderMapping): Promise<void> {
    await this.pushMappingInternal(mapping, true);
  }

  private async pushMappingInternal(
    mapping: GitFolderMapping,
    retryAfterPull: boolean
  ): Promise<void> {
    if (!isComplete(mapping)) return;
    const entry = this.state[mapping.id];
    if (entry?.hasConflicts) return; // block push until conflicts resolved
    try {
      const pushed = await this.backend.push(
        mapping,
        this.config.pat,
        this.config.author
      );
      this.lastPushError.delete(mapping.id);
      if (pushed) {
        const sha = (await this.backend.headSha(mapping)) ?? "";
        this.state[mapping.id] = { lastCommitSha: sha, hasConflicts: false };
        await this.saveState();
        await this.emit({ type: "pushed", mappingId: mapping.id, commitSha: sha });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      switch (classifyPushError(msg)) {
        case "diverged":
          // Someone else pushed first: pull (merge), then push our merge commit.
          await this.pullMapping(mapping);
          if (retryAfterPull && !this.state[mapping.id]?.hasConflicts) {
            await this.pushMappingInternal(mapping, false);
          }
          break;
        case "blocked": {
          // Permission / branch-protection problem. Local commits are kept, so
          // nothing is lost — pushes resume automatically once it's fixed.
          const friendly =
            `GitHub refused the push for "${mapping.label || mapping.localFolder}". ` +
            `Check that you have write access to the repo and that the branch ` +
            `doesn't require pull requests (repo Settings → Branches → allow direct pushes). ` +
            `Your notes are safe locally and will sync automatically once this is fixed.`;
          await this.emitPushErrorOnce(mapping, friendly);
          break;
        }
        default:
          await this.emitPushErrorOnce(mapping, msg);
      }
    }
  }

  /** Emit a push error only when it changes, so auto-sync doesn't spam notices. */
  private async emitPushErrorOnce(
    mapping: GitFolderMapping,
    message: string
  ): Promise<void> {
    if (this.lastPushError.get(mapping.id) === message) return;
    this.lastPushError.set(mapping.id, message);
    await this.emit({ type: "error", message, mappingId: mapping.id });
  }

  /** Pull all mappings. Called on poll interval. */
  async pullAll(): Promise<void> {
    if (this.pulling) return;
    this.pulling = true;
    try {
      await this.ensureLoaded();
      for (const mapping of this.config.mappings) {
        await this.pullMapping(mapping);
      }
    } finally {
      this.pulling = false;
    }
  }

  /** Pull a single mapping and surface any conflicts. */
  async pullMapping(mapping: GitFolderMapping): Promise<void> {
    if (!isComplete(mapping)) return;
    try {
      const conflictedPaths = await this.backend.pull(
        mapping,
        this.config.pat
      );

      if (conflictedPaths.length === 0) {
        const sha = (await this.backend.headSha(mapping)) ?? "";
        this.state[mapping.id] = { lastCommitSha: sha, hasConflicts: false };
        await this.saveState();
        await this.emit({ type: "pulled", mappingId: mapping.id, commitSha: sha });
        return;
      }

      // Surface each conflicted file to the UI.
      this.state[mapping.id] = {
        lastCommitSha: this.state[mapping.id]?.lastCommitSha ?? "",
        hasConflicts: true,
      };
      await this.saveState();

      for (const vaultPath of conflictedPaths) {
        await this.emitConflict(mapping, vaultPath);
      }
    } catch (err) {
      await this.emit({
        type: "error",
        message: err instanceof Error ? err.message : String(err),
        mappingId: mapping.id,
      });
    }
  }

  /**
   * Called by the UI after the user resolves a conflict in the merge modal.
   * Writes the merged content, commits, and pushes.
   */
  async resolveConflict(
    conflict: Conflict,
    mergedContent: Uint8Array
  ): Promise<void> {
    const mapping = this.config.mappings.find(
      (m) => m.id === conflict.mappingId
    );
    if (!mapping) return;

    // Repo-relative path from vault-relative.
    const repoRelPath = conflict.localPath.startsWith(mapping.localFolder + "/")
      ? conflict.localPath.slice(mapping.localFolder.length + 1)
      : conflict.localPath;

    await this.backend.resolveAndPush(
      mapping,
      this.config.pat,
      repoRelPath,
      mergedContent,
      this.config.author
    );

    const sha = (await this.backend.headSha(mapping)) ?? "";
    this.state[mapping.id] = { lastCommitSha: sha, hasConflicts: false };
    await this.saveState();
    await this.emit({ type: "pushed", mappingId: mapping.id, commitSha: sha });
  }

  /** Initialise all repos (clone if needed). Call on plugin load. */
  async initAll(): Promise<void> {
    for (const mapping of this.config.mappings) {
      if (!isComplete(mapping)) continue;
      try {
        await this.backend.init(mapping, this.config.pat);
      } catch (err) {
        await this.emit({
          type: "error",
          message: `Init failed for "${mapping.label}": ${
            err instanceof Error ? err.message : String(err)
          }`,
          mappingId: mapping.id,
        });
      }
    }
  }

  /** Init a single mapping — used when a new one is added in settings. */
  async initMapping(mapping: GitFolderMapping): Promise<void> {
    await this.backend.init(mapping, this.config.pat);
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    this.state = await this.stateStore.load();
    this.loaded = true;
  }

  private async saveState(): Promise<void> {
    await this.stateStore.save(this.state);
  }

  private async emitConflict(
    mapping: GitFolderMapping,
    vaultPath: string
  ): Promise<void> {
    const absPath = nodePath.join(this.vaultBasePath, vaultPath);
    let text: string;
    try {
      text = fs.readFileSync(absPath).toString("utf8");
    } catch {
      return; // file disappeared, skip
    }
    const parsed = parseConflictMarkers(text);
    if (!parsed) return;

    const enc = new TextEncoder();
    const conflict: Conflict = {
      mappingId: mapping.id,
      localPath: vaultPath,
      localContent: enc.encode(parsed.ours),
      remoteContent: enc.encode(parsed.theirs),
    };
    await this.emit({ type: "conflict", conflict });
  }
}

/** A mapping is only syncable once both the folder and the repo are chosen. */
function isComplete(mapping: GitFolderMapping): boolean {
  return !!(mapping.localFolder && mapping.repoUrl);
}

type PushErrorKind = "diverged" | "blocked" | "other";

/**
 * Distinguish "someone pushed before us" (pull + retry fixes it) from
 * "GitHub won't let us push at all" (permissions, protected branch).
 * Blocked patterns are checked first: protected-branch rejections also
 * contain the word "rejected".
 */
function classifyPushError(msg: string): PushErrorKind {
  const m = msg.toLowerCase();
  if (
    m.includes("protected branch") ||
    m.includes("hook declined") ||
    m.includes("pull request") ||
    m.includes("permission") ||
    m.includes("not permitted") ||
    m.includes("unauthorized") ||
    m.includes("401") ||
    m.includes("403")
  ) {
    return "blocked";
  }
  if (
    m.includes("non-fast-forward") ||
    m.includes("fetch first") ||
    m.includes("failed to update ref") ||
    m.includes("rejected") ||
    m.includes("fetch_head")
  ) {
    return "diverged";
  }
  return "other";
}
