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
import * as fs from "fs";
import * as nodePath from "path";

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
    const entry = this.state[mapping.id];
    if (entry?.hasConflicts) return; // block push until conflicts resolved
    try {
      const pushed = await this.backend.push(
        mapping,
        this.config.pat,
        this.config.author
      );
      if (pushed) {
        const sha = (await this.backend.headSha(mapping)) ?? "";
        this.state[mapping.id] = { lastCommitSha: sha, hasConflicts: false };
        await this.saveState();
        await this.emit({ type: "pushed", mappingId: mapping.id, commitSha: sha });
      }
    } catch (err) {
      // Non-fast-forward: someone else pushed first. Pull and let the next
      // push cycle retry.
      const msg = err instanceof Error ? err.message : String(err);
      if (isNonFastForward(msg)) {
        await this.pullMapping(mapping);
      } else {
        await this.emit({ type: "error", message: msg, mappingId: mapping.id });
      }
    }
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
    let fileContent: Buffer;
    try {
      fileContent = fs.readFileSync(absPath);
    } catch {
      return; // file disappeared, skip
    }
    const text = fileContent.toString("utf8");
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

function isNonFastForward(msg: string): boolean {
  return (
    msg.includes("non-fast-forward") ||
    msg.includes("rejected") ||
    msg.includes("FETCH_HEAD")
  );
}
