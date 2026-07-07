// Explicit, narrow typings for the handful of Node.js builtin functions this
// plugin needs (fs, path, crypto — required because isomorphic-git operates
// on the real filesystem, and the gitdir lives outside the vault).
//
// Some static analysis environments don't provide ambient Node.js types
// (@types/node's global `declare module "fs"` etc.), which makes raw
// `import * as fs from "fs"` resolve as `any` and cascades into unrelated
// "unsafe" lint warnings everywhere the result is used. Casting through
// `unknown` to these hand-written interfaces breaks that cascade: everything
// downstream sees a fully concrete type regardless of the ambient types
// available in whatever environment is doing the type-checking.

import * as fsRaw from "fs";
import * as pathRaw from "path";
import * as cryptoRaw from "crypto";
import type { CallbackFsClient } from "isomorphic-git";

export interface FsBuffer {
  readonly buffer: ArrayBufferLike;
  readonly byteOffset: number;
  readonly byteLength: number;
  toString(encoding: string): string;
}

interface FsApi {
  mkdirSync(path: string, options: { recursive: boolean }): void;
  existsSync(path: string): boolean;
  readFileSync(path: string): FsBuffer;
  writeFileSync(path: string, data: Uint8Array): void;
}

interface PathApi {
  join(...parts: string[]): string;
  dirname(path: string): string;
}

interface HashApi {
  update(data: Uint8Array): HashApi;
  digest(encoding: "hex"): string;
}

interface CryptoApi {
  createHash(algorithm: string): HashApi;
}

/** Narrow, synchronous surface used directly by our own code. */
export const fs: FsApi = fsRaw as unknown as FsApi;

/** Full fs surface isomorphic-git needs for its own read/write/stat calls. */
export const gitFs: CallbackFsClient = fsRaw as unknown as CallbackFsClient;

export const nodePath: PathApi = pathRaw as unknown as PathApi;
export const nodeCrypto: CryptoApi = cryptoRaw as unknown as CryptoApi;
