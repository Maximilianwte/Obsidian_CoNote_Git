// Sync engine: reconciles a set of mapped folders between the local FileStore and
// a GCS bucket using object generations for optimistic concurrency. Pure core —
// no Obsidian imports. Conflicts are surfaced as data via the event handler.

import type { FileStore, IGcsClient, SyncStateStore } from "./fileStore";
import { PreconditionFailedError } from "./gcs";
import {
  conflictCopyPath,
  contentTypeFor,
  hashContent,
  isBinary,
  localToObject,
  objectToLocal,
} from "./syncState";
import type {
  Conflict,
  FolderMapping,
  RemoteObject,
  SyncEventHandler,
  SyncStateMap,
} from "./types";

export interface SyncEngineConfig {
  mappings: FolderMapping[];
  /** Display name stored as object metadata for attribution. */
  author: string;
}

export class SyncEngine {
  private state: SyncStateMap = {};
  private loaded = false;
  private running = false;

  constructor(
    private readonly gcs: IGcsClient,
    private readonly files: FileStore,
    private readonly stateStore: SyncStateStore,
    private config: SyncEngineConfig,
    private readonly emit: SyncEventHandler
  ) {}

  updateConfig(config: SyncEngineConfig): void {
    this.config = config;
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    this.state = await this.stateStore.load();
    this.loaded = true;
  }

  private async persist(): Promise<void> {
    await this.stateStore.save(this.state);
  }

  /** Push a single local file (used by the debounced save handler). */
  async pushFile(localPath: string): Promise<void> {
    await this.ensureLoaded();
    const objectName = localToObject(localPath, this.config.mappings);
    if (!objectName) return;
    const entry = this.state[localPath];
    if (entry?.conflicted) return; // don't clobber an unresolved conflict

    const data = await this.files.read(localPath);
    if (data === null) {
      await this.pushDelete(localPath);
      return;
    }
    const localHash = hashContent(data);
    if (entry && entry.syncedHash === localHash) return; // nothing changed

    const ifGen = entry?.remoteGeneration ?? "0";
    try {
      const gen = await this.gcs.upload(
        objectName,
        data,
        ifGen,
        this.config.author,
        contentTypeFor(localPath)
      );
      this.state[localPath] = { remoteGeneration: gen, syncedHash: localHash };
      await this.persist();
      await this.emit({ type: "pushed", localPath });
    } catch (err) {
      if (err instanceof PreconditionFailedError) {
        await this.raiseConflict(localPath, objectName, data);
      } else {
        await this.emit({
          type: "error",
          message: String(err instanceof Error ? err.message : err),
          localPath,
        });
      }
    }
  }

  /** Propagate a local deletion to the remote (only if remote is unchanged). */
  async pushDelete(localPath: string): Promise<void> {
    await this.ensureLoaded();
    const objectName = localToObject(localPath, this.config.mappings);
    if (!objectName) return;
    const entry = this.state[localPath];
    if (!entry || entry.conflicted) return;
    await this.gcs.delete(objectName, entry.remoteGeneration);
    delete this.state[localPath];
    await this.persist();
    await this.emit({ type: "deleted-remote", localPath });
  }

  /** Full reconcile of all mapped folders in both directions. */
  async syncAll(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.ensureLoaded();
      const remote = await this.listRemote();
      const localPaths = await this.listLocal();
      const seenLocal = new Set<string>();

      for (const localPath of localPaths) {
        seenLocal.add(localPath);
        await this.reconcileLocal(localPath, remote);
      }
      // Remote objects with no local counterpart.
      for (const [objectName, obj] of remote) {
        const localPath = objectToLocal(objectName, this.config.mappings);
        if (!localPath || seenLocal.has(localPath)) continue;
        await this.reconcileRemoteOnly(localPath, objectName, obj);
      }
      await this.persist();
    } finally {
      this.running = false;
    }
  }

  // ---- reconciliation helpers ----

  private async reconcileLocal(
    localPath: string,
    remote: Map<string, RemoteObject>
  ): Promise<void> {
    const objectName = localToObject(localPath, this.config.mappings);
    if (!objectName) return;
    const entry = this.state[localPath];
    if (entry?.conflicted) return;

    const data = await this.files.read(localPath);
    if (data === null) return; // raced with a delete; handled elsewhere
    const localHash = hashContent(data);
    const obj = remote.get(objectName);

    if (!obj) {
      // Remote missing. Either brand-new local, or remote was deleted.
      const ifGen = entry ? entry.remoteGeneration : "0";
      if (entry && entry.syncedHash === localHash) {
        // We synced before, remote deleted, local untouched -> delete local.
        await this.files.delete(localPath);
        delete this.state[localPath];
        await this.emit({ type: "deleted-local", localPath });
        return;
      }
      // New local file, or local changed after remote deletion -> (re)create.
      await this.tryUpload(localPath, objectName, data, ifGen, localHash);
      return;
    }

    if (!entry) {
      // Both exist but we have no record. Adopt if identical, else conflict.
      const remoteFile = await this.gcs.download(objectName);
      if (!remoteFile) return;
      if (hashContent(remoteFile.content) === localHash) {
        this.state[localPath] = {
          remoteGeneration: obj.generation,
          syncedHash: localHash,
        };
      } else {
        await this.raiseConflict(localPath, objectName, data, remoteFile);
      }
      return;
    }

    if (obj.generation === entry.remoteGeneration) {
      // Remote unchanged since last sync.
      if (localHash !== entry.syncedHash) {
        await this.tryUpload(
          localPath,
          objectName,
          data,
          entry.remoteGeneration,
          localHash
        );
      }
      return;
    }

    // Remote changed since last sync.
    if (localHash === entry.syncedHash) {
      // Local untouched -> fast-forward pull.
      await this.pullInto(localPath, objectName);
    } else {
      // Both changed -> conflict.
      await this.raiseConflict(localPath, objectName, data);
    }
  }

  private async reconcileRemoteOnly(
    localPath: string,
    objectName: string,
    obj: RemoteObject
  ): Promise<void> {
    const entry = this.state[localPath];
    if (entry?.conflicted) return;

    if (!entry) {
      // New remote file -> create locally.
      await this.pullInto(localPath, objectName);
      return;
    }
    // We had it locally but it's gone now -> local deletion.
    if (obj.generation === entry.remoteGeneration) {
      // Remote unchanged since last sync -> propagate delete.
      await this.gcs.delete(objectName, entry.remoteGeneration);
      delete this.state[localPath];
      await this.emit({ type: "deleted-remote", localPath });
    } else {
      // Local deleted but remote changed -> resurrect locally to be safe.
      await this.pullInto(localPath, objectName);
    }
  }

  private async tryUpload(
    localPath: string,
    objectName: string,
    data: Uint8Array,
    ifGen: string,
    localHash: string
  ): Promise<void> {
    try {
      const gen = await this.gcs.upload(
        objectName,
        data,
        ifGen,
        this.config.author,
        contentTypeFor(localPath)
      );
      this.state[localPath] = { remoteGeneration: gen, syncedHash: localHash };
      await this.emit({ type: "pushed", localPath });
    } catch (err) {
      if (err instanceof PreconditionFailedError) {
        await this.raiseConflict(localPath, objectName, data);
      } else {
        throw err;
      }
    }
  }

  private async pullInto(localPath: string, objectName: string): Promise<void> {
    const remoteFile = await this.gcs.download(objectName);
    if (!remoteFile) return;
    await this.files.write(localPath, remoteFile.content);
    this.state[localPath] = {
      remoteGeneration: remoteFile.generation,
      syncedHash: hashContent(remoteFile.content),
    };
    await this.emit({ type: "pulled", localPath });
  }

  private async raiseConflict(
    localPath: string,
    objectName: string,
    localData: Uint8Array,
    preloadedRemote?: { content: Uint8Array; generation: string; author?: string }
  ): Promise<void> {
    const remoteFile = preloadedRemote ?? (await this.gcs.download(objectName));
    if (!remoteFile) {
      // Remote vanished mid-flight; fall back to a plain create next round.
      return;
    }
    const binary = isBinary(localData) || isBinary(remoteFile.content);

    if (binary) {
      // Can't line-merge: keep both, adopt the remote as the canonical file.
      const copyPath = conflictCopyPath(
        localPath,
        remoteFile.author ?? "remote"
      );
      await this.files.write(copyPath, localData); // preserve our version
      await this.files.write(localPath, remoteFile.content); // take remote
      this.state[localPath] = {
        remoteGeneration: remoteFile.generation,
        syncedHash: hashContent(remoteFile.content),
      };
      await this.emit({ type: "pulled", localPath });
      await this.emit({
        type: "error",
        message: `Binary conflict on ${localPath}; your version kept at ${copyPath}.`,
        localPath,
      });
      return;
    }

    const conflict: Conflict = {
      localPath,
      objectName,
      localContent: localData,
      remoteContent: remoteFile.content,
      remoteGeneration: remoteFile.generation,
      remoteAuthor: remoteFile.author,
      binary: false,
    };
    const entry = this.state[localPath] ?? {
      remoteGeneration: remoteFile.generation,
      syncedHash: "",
    };
    entry.conflicted = true;
    this.state[localPath] = entry;
    await this.persist();
    await this.emit({ type: "conflict", conflict });
  }

  /**
   * Apply a user-merged result for a previously-raised conflict: write it locally
   * and upload with the conflict's remote generation as the precondition. If a
   * newer remote write landed meanwhile, returns a fresh Conflict to re-resolve.
   */
  async resolveConflict(
    conflict: Conflict,
    mergedContent: Uint8Array
  ): Promise<Conflict | null> {
    await this.ensureLoaded();
    const { localPath, objectName } = conflict;
    await this.files.write(localPath, mergedContent);
    const localHash = hashContent(mergedContent);
    try {
      const gen = await this.gcs.upload(
        objectName,
        mergedContent,
        conflict.remoteGeneration,
        this.config.author,
        contentTypeFor(localPath)
      );
      this.state[localPath] = { remoteGeneration: gen, syncedHash: localHash };
      await this.persist();
      await this.emit({ type: "pushed", localPath });
      return null;
    } catch (err) {
      if (err instanceof PreconditionFailedError) {
        const remoteFile = await this.gcs.download(objectName);
        if (!remoteFile) return null;
        return {
          localPath,
          objectName,
          localContent: mergedContent,
          remoteContent: remoteFile.content,
          remoteGeneration: remoteFile.generation,
          remoteAuthor: remoteFile.author,
          binary: false,
        };
      }
      throw err;
    }
  }

  /** Whether a path currently has an unresolved conflict. */
  isConflicted(localPath: string): boolean {
    return !!this.state[localPath]?.conflicted;
  }

  // ---- listing helpers ----

  private async listRemote(): Promise<Map<string, RemoteObject>> {
    const map = new Map<string, RemoteObject>();
    const prefixes = new Set(
      this.config.mappings.map((m) =>
        m.bucketPrefix.replace(/^\/+/, "").replace(/\/+$/, "")
      )
    );
    for (const prefix of prefixes) {
      const objs = await this.gcs.list(prefix === "" ? "" : prefix + "/");
      for (const o of objs) map.set(o.name, o);
    }
    return map;
  }

  private async listLocal(): Promise<string[]> {
    const set = new Set<string>();
    for (const m of this.config.mappings) {
      const files = await this.files.list(m.localFolder);
      for (const f of files) set.add(f.path);
    }
    return [...set];
  }
}
