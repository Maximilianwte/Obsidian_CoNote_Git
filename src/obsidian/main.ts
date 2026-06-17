import {
  Notice,
  Plugin,
  TAbstractFile,
  TFile,
  requestUrl,
  type RequestUrlParam,
} from "obsidian";
import {
  ConoteSettingTab,
  ConoteSettings,
  DEFAULT_SETTINGS,
} from "./settings";
import { VaultFileStore, PluginSyncStateStore } from "./vaultFileStore";
import { MergeModal } from "./mergeModal";
import { AuthModal } from "./authModal";
import { SharesModal } from "./sharesModal";
import { FirebaseAuthClient } from "../core/firebaseAuth";
import { ApiClient } from "../core/apiClient";
import { SyncEngine } from "../core/sync";
import { localToObject } from "../core/syncState";
import type { HttpFn, HttpResponse } from "../core/fileStore";
import type { SyncEvent, SyncStateMap, FolderMappingV2, ShareInfo } from "../core/types";

// v2 folder mappings use gcsPrefix; adapt for SyncEngine which expects FolderMapping
// (localFolder + bucketPrefix). We just rename the field at the boundary.
function toFolderMappings(v2: FolderMappingV2[]) {
  return v2.map((m) => ({ localFolder: m.localFolder, bucketPrefix: m.gcsPrefix }));
}

interface PersistedData {
  settings: ConoteSettings;
  syncState: SyncStateMap;
}

const PUSH_DEBOUNCE_MS = 2000;

export default class ConotePlugin extends Plugin {
  settings!: ConoteSettings;
  private syncState: SyncStateMap = {};
  private firebaseAuth!: FirebaseAuthClient;
  private engine: SyncEngine | null = null;
  private pollTimer: number | null = null;
  private pushTimers = new Map<string, number>();
  private statusEl: HTMLElement | null = null;

  async onload(): Promise<void> {
    await this.loadPersisted();

    this.firebaseAuth = new FirebaseAuthClient(this.makeHttp());
    this.firebaseAuth.load(this.settings.credential);

    this.addSettingTab(new ConoteSettingTab(this.app, this));
    this.statusEl = this.addStatusBarItem();
    this.setStatus("idle");

    this.addCommand({
      id: "conote-sync-now",
      name: "Sync shared folders now",
      callback: () => void this.syncNow(),
    });
    this.addCommand({
      id: "conote-manage-shares",
      name: "Manage shared folders",
      callback: () => this.openSharesModal(),
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

    this.app.workspace.onLayoutReady(() => {
      this.rebuildEngine();
      this.restartSync();
      if (this.engine && this.settings.autoSync) void this.syncNow();
    });
  }

  onunload(): void {
    this.clearPoll();
    for (const t of this.pushTimers.values()) window.clearTimeout(t);
    this.pushTimers.clear();
  }

  // ── Persistence ───────────────────────────────────────────────────────────

  private async loadPersisted(): Promise<void> {
    const data = (await this.loadData()) as Partial<PersistedData> | null;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data?.settings ?? {});
    this.syncState = data?.syncState ?? {};
  }

  private async savePersisted(): Promise<void> {
    await this.saveData({
      settings: this.settings,
      syncState: this.syncState,
    } satisfies PersistedData);
  }

  async saveSettings(): Promise<void> {
    await this.savePersisted();
    this.rebuildEngine();
  }

  // ── Auth helpers ──────────────────────────────────────────────────────────

  getUid(): string | null {
    return this.firebaseAuth.getUid();
  }

  signOut(): void {
    this.firebaseAuth.signOut();
    this.settings.credential = null;
    this.engine = null;
    this.clearPoll();
    this.setStatus("idle");
  }

  openAuthModal(): void {
    new AuthModal(this.app, this.firebaseAuth, async (cred) => {
      this.settings.credential = cred;
      if (!this.settings.author) {
        this.settings.author = cred.email.split("@")[0];
      }
      await this.saveSettings();
      this.rebuildEngine();
      this.restartSync();
      new Notice(`Conote: signed in as ${cred.email}`);
    }).open();
  }

  openSharesModal(): void {
    if (!this.isSignedIn()) {
      new Notice("Conote: please sign in first (Settings → Conote).");
      return;
    }
    const api = this.buildApiClient();
    if (!api) return;
    new SharesModal(this.app, api, (shares) =>
      this.addShareMappings(shares)
    ).open();
  }

  private async addShareMappings(shares: ShareInfo[]): Promise<void> {
    let changed = false;
    for (const share of shares) {
      const existing = this.settings.mappings.find(
        (m) => m.shareId === share.shareId
      );
      if (!existing) {
        this.settings.mappings.push({
          localFolder: share.name,
          gcsPrefix: share.gcsPrefix,
          shareId: share.shareId,
          name: share.name,
        });
        changed = true;
      }
    }
    if (changed) {
      await this.saveSettings();
      new Notice("Conote: folder mappings updated. Check Settings to adjust local paths.");
    }
  }

  // ── Engine ────────────────────────────────────────────────────────────────

  private isSignedIn(): boolean {
    return this.firebaseAuth.isSignedIn();
  }

  private isConfigured(): boolean {
    return this.isSignedIn() && this.settings.mappings.length > 0;
  }

  private buildApiClient(): ApiClient | null {
    if (!this.isSignedIn()) return null;
    return new ApiClient(
      () => this.firebaseAuth.getIdToken(),
      this.makeHttp()
    );
  }

  private rebuildEngine(): void {
    if (!this.isConfigured()) {
      this.engine = null;
      return;
    }
    const api = this.buildApiClient();
    if (!api) { this.engine = null; return; }

    const files = new VaultFileStore(this.app);
    const stateStore = new PluginSyncStateStore(
      async () => this.syncState,
      async (s) => {
        this.syncState = s;
        await this.savePersisted();
      }
    );
    this.engine = new SyncEngine(
      api,
      files,
      stateStore,
      {
        mappings: toFolderMappings(this.settings.mappings),
        author: this.settings.author || this.firebaseAuth.getEmail() || "anonymous",
      },
      (e) => this.onSyncEvent(e)
    );
  }

  /** Obsidian's requestUrl adapted to the core HttpFn contract. */
  private makeHttp(): HttpFn {
    return async (req): Promise<HttpResponse> => {
      const params: RequestUrlParam = {
        url: req.url,
        method: req.method ?? "GET",
        headers: req.headers as Record<string, string>,
        throw: false,
      };
      if (req.body !== undefined) {
        params.body =
          req.body instanceof Uint8Array
            ? (req.body.buffer.slice(
                req.body.byteOffset,
                req.body.byteOffset + req.body.byteLength
              ) as ArrayBuffer)
            : req.body;
      }
      const res = await requestUrl(params);
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(res.headers ?? {})) {
        headers[k.toLowerCase()] = String(v);
      }
      return {
        status: res.status,
        text: res.text ?? "",
        arrayBuffer: res.arrayBuffer ?? new ArrayBuffer(0),
        headers,
      };
    };
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
      this.app.vault.on("delete", (f) => this.onLocalDelete(f))
    );
    this.registerEvent(
      this.app.vault.on("rename", (f, oldPath) => {
        this.queueDelete(oldPath);
        this.onLocalChange(f);
      })
    );
  }

  private inScope(path: string): boolean {
    return localToObject(path, toFolderMappings(this.settings.mappings)) !== null;
  }

  private onLocalChange(f: TAbstractFile): void {
    if (!this.engine || !this.settings.autoSync) return;
    if (!(f instanceof TFile)) return;
    if (!this.inScope(f.path)) return;
    this.schedulePush(f.path);
  }

  private onLocalDelete(f: TAbstractFile): void {
    if (!this.engine || !this.settings.autoSync) return;
    if (!this.inScope(f.path)) return;
    this.queueDelete(f.path);
  }

  private schedulePush(path: string): void {
    const existing = this.pushTimers.get(path);
    if (existing) window.clearTimeout(existing);
    const timer = window.setTimeout(() => {
      this.pushTimers.delete(path);
      void this.runPush(path);
    }, PUSH_DEBOUNCE_MS);
    this.pushTimers.set(path, timer);
  }

  private queueDelete(path: string): void {
    const existing = this.pushTimers.get(path);
    if (existing) { window.clearTimeout(existing); this.pushTimers.delete(path); }
    void this.engine?.pushDelete(path).catch((e) =>
      console.error("Conote: pushDelete failed", e)
    );
  }

  private async runPush(path: string): Promise<void> {
    if (!this.engine) return;
    this.setStatus("syncing");
    try {
      await this.engine.pushFile(path);
    } catch (e) {
      console.error("Conote: push failed", e);
    } finally {
      this.setStatus("idle");
    }
  }

  // ── Polling ───────────────────────────────────────────────────────────────

  restartSync(): void {
    this.clearPoll();
    if (!this.settings.autoSync || !this.engine) return;
    const ms = Math.max(5, this.settings.pollIntervalSeconds) * 1000;
    this.pollTimer = window.setInterval(() => void this.syncNow(), ms);
  }

  private clearPoll(): void {
    if (this.pollTimer !== null) {
      window.clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  async syncNow(): Promise<void> {
    if (!this.engine) {
      if (!this.isSignedIn()) {
        new Notice("Conote: please sign in first (Settings → Conote).");
      } else if (this.settings.mappings.length === 0) {
        new Notice("Conote: add a folder mapping in Settings first.");
      }
      return;
    }
    this.setStatus("syncing");
    try {
      await this.engine.syncAll();
    } catch (e) {
      new Notice(
        `Conote sync error: ${e instanceof Error ? e.message : String(e)}`,
        6000
      );
      console.error("Conote: syncAll failed", e);
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
          let result = await this.engine.resolveConflict(
            e.conflict,
            new TextEncoder().encode(merged)
          );
          while (result) {
            const next = result;
            const merged2 = await MergeModal.openAsync(this.app, next);
            if (merged2 === null) break;
            result = await this.engine.resolveConflict(
              next,
              new TextEncoder().encode(merged2)
            );
          }
          if (!result) new Notice(`Conote: resolved ${e.conflict.localPath}`);
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
}
