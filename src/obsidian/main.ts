import { Notice, Plugin, TAbstractFile, TFile } from "obsidian";
import { ConoteSettingTab, ConoteSettings, DEFAULT_SETTINGS } from "./settings";
import { PluginSyncStateStore } from "./vaultFileStore";
import { MergeModal } from "./mergeModal";
import { GitBackend } from "../core/gitBackend";
import { SyncEngine } from "../core/sync";
import * as nodePath from "path";
import type { SyncEvent, SyncStateMap, GitFolderMapping } from "../core/types";

interface PersistedData {
  settings: ConoteSettings;
  syncState: SyncStateMap;
}

export default class ConotePlugin extends Plugin {
  settings!: ConoteSettings;
  private syncState: SyncStateMap = {};
  private engine: SyncEngine | null = null;
  private pullTimer: number | null = null;
  private pushTimers = new Map<string, number>();
  private statusEl: HTMLElement | null = null;

  async onload(): Promise<void> {
    await this.loadPersisted();
    this.addSettingTab(new ConoteSettingTab(this.app, this));
    this.statusEl = this.addStatusBarItem();
    this.setStatus("idle");

    this.addCommand({
      id: "conote-sync-now",
      name: "Sync shared folders now",
      callback: () => void this.syncNow(),
    });
    this.addCommand({
      id: "conote-toggle-autosync",
      name: "Toggle automatic sync",
      callback: async () => {
        this.settings.autoSync = !this.settings.autoSync;
        await this.saveSettings();
        this.restartSync();
        new Notice(`Conote auto-sync ${this.settings.autoSync ? "on" : "off"}`);
      },
    });

    this.registerVaultEvents();

    this.app.workspace.onLayoutReady(async () => {
      this.rebuildEngine();
      if (this.engine) {
        this.setStatus("syncing");
        try {
          await this.engine.initAll();
          await this.engine.pullAll();
        } catch (e) {
          console.error("Conote: init error", e);
        } finally {
          this.setStatus("idle");
        }
      }
      this.restartSync();
      this.decorateFolders();
      // Re-decorate whenever the file explorer re-renders
      this.registerEvent(
        this.app.workspace.on("layout-change", () => this.decorateFolders())
      );
    });
  }

  onunload(): void {
    this.clearPull();
    for (const t of this.pushTimers.values()) window.clearTimeout(t);
    this.pushTimers.clear();
    this.clearFolderBadges();
  }

  // ── Persistence ───────────────────────────────────────────────────────────

  private async loadPersisted(): Promise<void> {
    const data = (await this.loadData()) as Partial<PersistedData> | null;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data?.settings ?? {});
    this.syncState = data?.syncState ?? {};
  }

  private async savePersisted(): Promise<void> {
    await this.saveData({ settings: this.settings, syncState: this.syncState });
  }

  async saveSettings(): Promise<void> {
    await this.savePersisted();
    this.rebuildEngine();
    this.decorateFolders();
  }

  // ── Engine ────────────────────────────────────────────────────────────────

  private isConfigured(): boolean {
    return !!(this.settings.pat && this.settings.mappings.length > 0);
  }

  private vaultBasePath(): string {
    // Obsidian's vault adapter exposes the absolute base path.
    return (this.app.vault.adapter as { basePath?: string }).basePath ?? "";
  }

  private reposBasePath(): string {
    return nodePath.join(
      this.vaultBasePath(),
      this.app.vault.configDir,
      "plugins",
      "conote-git",
      "repos"
    );
  }

  private rebuildEngine(): void {
    if (!this.isConfigured()) { this.engine = null; return; }
    const backend = new GitBackend(this.reposBasePath(), this.vaultBasePath());
    const stateStore = new PluginSyncStateStore(
      async () => this.syncState,
      async (s) => { this.syncState = s; await this.savePersisted(); }
    );
    this.engine = new SyncEngine(
      backend,
      this.vaultBasePath(),
      stateStore,
      {
        mappings: this.settings.mappings,
        pat: this.settings.pat,
        author: this.settings.author || "Conote User",
      },
      (e) => this.onSyncEvent(e)
    );
  }

  /** Expose for settings "Clone / init" button. */
  async initMapping(mapping: GitFolderMapping): Promise<void> {
    if (!this.engine) this.rebuildEngine();
    await this.engine?.initMapping(mapping);
  }

  // ── Vault events ──────────────────────────────────────────────────────────

  private registerVaultEvents(): void {
    this.registerEvent(
      this.app.vault.on("modify", (f) => this.onLocalChange(f))
    );
    this.registerEvent(
      this.app.vault.on("create", (f) => this.onLocalChange(f))
    );
    this.registerEvent(
      this.app.vault.on("delete", (f) => this.onLocalChange(f))
    );
    this.registerEvent(
      this.app.vault.on("rename", (f) => this.onLocalChange(f))
    );
  }

  private mappingForPath(vaultPath: string): GitFolderMapping | null {
    for (const m of this.settings.mappings) {
      if (
        vaultPath === m.localFolder ||
        vaultPath.startsWith(m.localFolder + "/")
      ) {
        return m;
      }
    }
    return null;
  }

  private onLocalChange(f: TAbstractFile): void {
    if (!this.engine || !this.settings.autoSync) return;
    if (!(f instanceof TFile)) return;
    const mapping = this.mappingForPath(f.path);
    if (!mapping) return;
    this.schedulePush(mapping);
  }

  private schedulePush(mapping: GitFolderMapping): void {
    const existing = this.pushTimers.get(mapping.id);
    if (existing) window.clearTimeout(existing);
    const ms = Math.max(3, this.settings.pushDebounceSeconds) * 1000;
    const timer = window.setTimeout(() => {
      this.pushTimers.delete(mapping.id);
      void this.runPush(mapping);
    }, ms);
    this.pushTimers.set(mapping.id, timer);
  }

  private async runPush(mapping: GitFolderMapping): Promise<void> {
    if (!this.engine) return;
    this.setStatus("syncing");
    try {
      await this.engine.pushMapping(mapping);
    } catch (e) {
      console.error("Conote: push failed", e);
    } finally {
      this.setStatus("idle");
    }
  }

  // ── Pull polling ──────────────────────────────────────────────────────────

  restartSync(): void {
    this.clearPull();
    if (!this.settings.autoSync || !this.engine) return;
    const ms = Math.max(10, this.settings.pullIntervalSeconds) * 1000;
    this.pullTimer = window.setInterval(() => void this.runPull(), ms);
  }

  private clearPull(): void {
    if (this.pullTimer !== null) {
      window.clearInterval(this.pullTimer);
      this.pullTimer = null;
    }
  }

  private async runPull(): Promise<void> {
    if (!this.engine) return;
    this.setStatus("syncing");
    try {
      await this.engine.pullAll();
    } catch (e) {
      console.error("Conote: pull failed", e);
    } finally {
      this.setStatus("idle");
    }
  }

  async syncNow(): Promise<void> {
    if (!this.engine) {
      if (!this.settings.pat) {
        new Notice("Conote: add your GitHub PAT in Settings first.");
      } else {
        new Notice("Conote: add at least one folder mapping in Settings.");
      }
      return;
    }
    this.setStatus("syncing");
    try {
      await this.engine.pushAll();
      await this.engine.pullAll();
    } catch (e) {
      new Notice(
        `Conote sync error: ${e instanceof Error ? e.message : String(e)}`,
        6000
      );
    } finally {
      this.setStatus("idle");
    }
  }

  // ── Sync event handler ────────────────────────────────────────────────────

  private async onSyncEvent(e: SyncEvent): Promise<void> {
    switch (e.type) {
      case "conflict":
        new MergeModal(this.app, e.conflict, async (merged) => {
          if (!this.engine) return;
          try {
            await this.engine.resolveConflict(
              e.conflict,
              new TextEncoder().encode(merged)
            );
            new Notice(`Conote: resolved ${e.conflict.localPath}`);
          } catch (err) {
            new Notice(
              `Conote: resolve failed — ${err instanceof Error ? err.message : String(err)}`,
              6000
            );
          }
        }).open();
        break;
      case "error":
        new Notice(`Conote: ${e.message}`, 6000);
        break;
      default:
        break;
    }
  }

  // ── Status bar ────────────────────────────────────────────────────────────

  private setStatus(state: "idle" | "syncing"): void {
    if (!this.statusEl) return;
    this.statusEl.setText(state === "syncing" ? "Conote ⟳" : "Conote ✓");
    this.statusEl.title =
      state === "syncing" ? "Conote: syncing…" : "Conote: idle";
  }

  // ── Folder badges ─────────────────────────────────────────────────────────

  private clearFolderBadges(): void {
    document.querySelectorAll(".conote-folder-badge").forEach((el) => el.remove());
  }

  private decorateFolders(): void {
    this.clearFolderBadges();
    const leaf = this.app.workspace.getLeavesOfType("file-explorer")[0];
    if (!leaf) return;
    const view = leaf.view as unknown as {
      fileItems: Record<string, { el: HTMLElement }>;
    };
    if (!view.fileItems) return;

    for (const mapping of this.settings.mappings) {
      const item = view.fileItems[mapping.localFolder];
      if (!item?.el) continue;
      const titleEl = item.el.querySelector(".nav-folder-title-content");
      if (!titleEl || titleEl.querySelector(".conote-folder-badge")) continue;
      const badge = createEl("span", { cls: "conote-folder-badge", text: "🌐" });
      titleEl.prepend(badge);
    }
  }
}
