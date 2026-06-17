// Cloud Function API client — implements IGcsClient so SyncEngine is unchanged.
// Also exposes share-management methods that have no GcsClient equivalent.

import type { HttpFn, IGcsClient } from "./fileStore";
import { PreconditionFailedError } from "./gcs";
import type { RemoteFile, RemoteObject, ShareInfo } from "./types";
import { CLOUD_FUNCTION_URL } from "./firebaseConfig";

export class ApiClient implements IGcsClient {
  constructor(
    private readonly getIdToken: () => Promise<string>,
    private readonly http: HttpFn,
    private readonly functionUrl: string = CLOUD_FUNCTION_URL
  ) {}

  private async authHeaders(): Promise<Record<string, string>> {
    const token = await this.getIdToken();
    return {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    };
  }

  // ── IGcsClient ────────────────────────────────────────────────────────────

  async list(prefix: string): Promise<RemoteObject[]> {
    const headers = await this.authHeaders();
    const res = await this.http({
      url: `${this.functionUrl}/list?prefix=${encodeURIComponent(prefix)}`,
      method: "GET",
      headers,
    });
    this.assertOk(res, "list");
    return JSON.parse(res.text) as RemoteObject[];
  }

  async download(objectName: string): Promise<RemoteFile | null> {
    const headers = await this.authHeaders();
    const res = await this.http({
      url: `${this.functionUrl}/file?path=${encodeURIComponent(objectName)}`,
      method: "GET",
      headers,
    });
    if (res.status === 404) return null;
    this.assertOk(res, "download");
    return {
      content: new Uint8Array(res.arrayBuffer),
      generation: res.headers["x-generation"] ?? "0",
      author: res.headers["x-author"],
    };
  }

  async getGeneration(objectName: string): Promise<string | null> {
    const headers = await this.authHeaders();
    const res = await this.http({
      url: `${this.functionUrl}/file?path=${encodeURIComponent(
        objectName
      )}&metaOnly=true`,
      method: "GET",
      headers,
    });
    if (res.status === 404) return null;
    this.assertOk(res, "stat");
    return res.headers["x-generation"] ?? null;
  }

  async upload(
    objectName: string,
    data: Uint8Array,
    ifGenerationMatch: string,
    author?: string,
    contentType = "application/octet-stream"
  ): Promise<string> {
    const token = await this.getIdToken();
    const extraHeaders: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      "Content-Type": contentType,
      "X-If-Generation-Match": ifGenerationMatch,
    };
    if (author) extraHeaders["X-Author"] = author;
    const res = await this.http({
      url: `${this.functionUrl}/file?path=${encodeURIComponent(objectName)}`,
      method: "PUT",
      headers: extraHeaders,
      body: data.buffer.slice(
        data.byteOffset,
        data.byteOffset + data.byteLength
      ) as ArrayBuffer,
    });
    if (res.status === 412) throw new PreconditionFailedError(objectName);
    this.assertOk(res, "upload");
    const parsed = JSON.parse(res.text || "{}") as { generation?: string };
    return parsed.generation ?? "0";
  }

  async delete(objectName: string, ifGenerationMatch?: string): Promise<void> {
    const token = await this.getIdToken();
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
    };
    if (ifGenerationMatch) {
      headers["X-If-Generation-Match"] = ifGenerationMatch;
    }
    const res = await this.http({
      url: `${this.functionUrl}/file?path=${encodeURIComponent(objectName)}`,
      method: "DELETE",
      headers,
    });
    if (res.status === 404 || res.status === 412) return;
    this.assertOk(res, "delete");
  }

  // ── Share management ──────────────────────────────────────────────────────

  async listShares(): Promise<ShareInfo[]> {
    const headers = await this.authHeaders();
    const res = await this.http({
      url: `${this.functionUrl}/shares`,
      method: "GET",
      headers,
    });
    this.assertOk(res, "listShares");
    return JSON.parse(res.text) as ShareInfo[];
  }

  async createShare(name: string): Promise<ShareInfo> {
    const headers = await this.authHeaders();
    const res = await this.http({
      url: `${this.functionUrl}/shares`,
      method: "POST",
      headers,
      body: JSON.stringify({ name }),
    });
    this.assertOk(res, "createShare");
    return JSON.parse(res.text) as ShareInfo;
  }

  /** Generate a one-use invite token for a share. Returns the token string. */
  async createInvite(shareId: string): Promise<string> {
    const headers = await this.authHeaders();
    const res = await this.http({
      url: `${this.functionUrl}/shares/${encodeURIComponent(shareId)}/invite`,
      method: "POST",
      headers,
    });
    this.assertOk(res, "createInvite");
    const parsed = JSON.parse(res.text) as { token: string };
    return parsed.token;
  }

  /** Join a shared folder using an invite token. Returns the ShareInfo. */
  async joinShare(token: string): Promise<ShareInfo> {
    const headers = await this.authHeaders();
    const res = await this.http({
      url: `${this.functionUrl}/shares/join`,
      method: "POST",
      headers,
      body: JSON.stringify({ token }),
    });
    this.assertOk(res, "joinShare");
    return JSON.parse(res.text) as ShareInfo;
  }

  /** Leave a share (or remove a member if you're the owner). */
  async leaveShare(shareId: string): Promise<void> {
    const headers = await this.authHeaders();
    const res = await this.http({
      url: `${this.functionUrl}/shares/${encodeURIComponent(shareId)}/leave`,
      method: "DELETE",
      headers,
    });
    this.assertOk(res, "leaveShare");
  }

  // ── helpers ───────────────────────────────────────────────────────────────

  private assertOk(
    res: { status: number; text: string },
    op: string
  ): void {
    if (res.status < 200 || res.status >= 300) {
      let detail = res.text || "no body";
      try {
        const d = JSON.parse(res.text) as { error?: string };
        if (d.error) detail = d.error;
      } catch { /* ignore */ }
      throw new Error(`Conote API ${op} failed (${res.status}): ${detail}`);
    }
  }
}
