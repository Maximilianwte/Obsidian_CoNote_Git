import { App, TFile, TFolder, normalizePath } from "obsidian";
import type { FileStore, LocalFile, SyncStateStore } from "../core/fileStore";
import type { SyncStateMap } from "../core/types";

export class VaultFileStore implements FileStore {
  constructor(private readonly app: App) {}

  async list(folder: string): Promise<LocalFile[]> {
    const root = normalizePath(folder);
    const out: LocalFile[] = [];
    const af = this.app.vault.getAbstractFileByPath(root);
    const collect = (f: TFolder) => {
      for (const child of f.children) {
        if (child instanceof TFile) out.push({ path: child.path });
        else if (child instanceof TFolder) collect(child);
      }
    };
    if (af instanceof TFolder) collect(af);
    return out;
  }

  async read(path: string): Promise<Uint8Array | null> {
    const p = normalizePath(path);
    if (!(await this.app.vault.adapter.exists(p))) return null;
    const buf = await this.app.vault.adapter.readBinary(p);
    return new Uint8Array(buf);
  }

  async write(path: string, data: Uint8Array): Promise<void> {
    const p = normalizePath(path);
    await this.ensureParent(p);
    await this.app.vault.adapter.writeBinary(p, toArrayBuffer(data));
  }

  async delete(path: string): Promise<void> {
    const p = normalizePath(path);
    if (await this.app.vault.adapter.exists(p)) {
      await this.app.vault.adapter.remove(p);
    }
  }

  async exists(path: string): Promise<boolean> {
    return this.app.vault.adapter.exists(normalizePath(path));
  }

  private async ensureParent(path: string): Promise<void> {
    const idx = path.lastIndexOf("/");
    if (idx <= 0) return;
    const dir = path.slice(0, idx);
    if (!(await this.app.vault.adapter.exists(dir))) {
      await this.app.vault.adapter.mkdir(dir);
    }
  }
}

function toArrayBuffer(data: Uint8Array): ArrayBuffer {
  const ab = new ArrayBuffer(data.byteLength);
  new Uint8Array(ab).set(data);
  return ab;
}

export class PluginSyncStateStore implements SyncStateStore {
  constructor(
    private readonly load_: () => Promise<SyncStateMap>,
    private readonly save_: (s: SyncStateMap) => Promise<void>
  ) {}
  load(): Promise<SyncStateMap> { return this.load_(); }
  save(state: SyncStateMap): Promise<void> { return this.save_(state); }
}
