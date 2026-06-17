// Thin wrapper over the GCS JSON API. All requests go through the injected HttpFn
// so this works identically inside Obsidian (requestUrl) and in a Node MCP server.

import type { HttpFn } from "./fileStore";
import type { RemoteFile, RemoteObject } from "./types";
import type { TokenProvider } from "./auth";

const API = "https://storage.googleapis.com/storage/v1";
const UPLOAD_API = "https://storage.googleapis.com/upload/storage/v1";

/** Thrown when a conditional write fails because the object changed (HTTP 412). */
export class PreconditionFailedError extends Error {
  constructor(public readonly objectName: string) {
    super(`Precondition failed for ${objectName} (remote changed).`);
    this.name = "PreconditionFailedError";
  }
}

export class GcsClient {
  constructor(
    private readonly bucket: string,
    private readonly tokens: TokenProvider,
    private readonly http: HttpFn
  ) {}

  private async authHeaders(
    extra: Record<string, string> = {}
  ): Promise<Record<string, string>> {
    const token = await this.tokens.getToken();
    return { Authorization: `Bearer ${token}`, ...extra };
  }

  /** List objects under a prefix, following pagination. */
  async list(prefix: string): Promise<RemoteObject[]> {
    const out: RemoteObject[] = [];
    let pageToken: string | undefined;
    do {
      const params = new URLSearchParams({
        prefix,
        fields:
          "items(name,generation,size,updated,metadata),nextPageToken",
        maxResults: "1000",
      });
      if (pageToken) params.set("pageToken", pageToken);
      const res = await this.http({
        url: `${API}/b/${encodeURIComponent(this.bucket)}/o?${params}`,
        method: "GET",
        headers: await this.authHeaders(),
      });
      this.assertOk(res, "list");
      const data = JSON.parse(res.text || "{}") as {
        items?: Array<{
          name: string;
          generation: string;
          size?: string;
          updated?: string;
          metadata?: Record<string, string>;
        }>;
        nextPageToken?: string;
      };
      for (const item of data.items ?? []) {
        // Skip "directory placeholder" objects ending in "/".
        if (item.name.endsWith("/")) continue;
        out.push({
          name: item.name,
          generation: item.generation,
          author: item.metadata?.author,
          size: item.size ? Number(item.size) : undefined,
          updated: item.updated,
        });
      }
      pageToken = data.nextPageToken;
    } while (pageToken);
    return out;
  }

  /** Download an object's bytes plus its current generation. Null if missing. */
  async download(objectName: string): Promise<RemoteFile | null> {
    const res = await this.http({
      url: `${API}/b/${encodeURIComponent(this.bucket)}/o/${encodeURIComponent(
        objectName
      )}?alt=media`,
      method: "GET",
      headers: await this.authHeaders(),
    });
    if (res.status === 404) return null;
    this.assertOk(res, "download");
    return {
      content: new Uint8Array(res.arrayBuffer),
      generation: res.headers["x-goog-generation"] ?? "0",
      author: res.headers["x-goog-meta-author"],
    };
  }

  /** Fetch just the current generation of an object, or null if missing. */
  async getGeneration(objectName: string): Promise<string | null> {
    const params = new URLSearchParams({ fields: "generation" });
    const res = await this.http({
      url: `${API}/b/${encodeURIComponent(this.bucket)}/o/${encodeURIComponent(
        objectName
      )}?${params}`,
      method: "GET",
      headers: await this.authHeaders(),
    });
    if (res.status === 404) return null;
    this.assertOk(res, "stat");
    const data = JSON.parse(res.text || "{}") as { generation?: string };
    return data.generation ?? null;
  }

  /**
   * Upload bytes with optimistic concurrency. `ifGenerationMatch` of "0" means
   * "create only if absent"; any other value means "only if unchanged".
   * Throws PreconditionFailedError on 412.
   */
  async upload(
    objectName: string,
    data: Uint8Array,
    ifGenerationMatch: string,
    author?: string,
    contentType = "application/octet-stream"
  ): Promise<string> {
    const params = new URLSearchParams({
      uploadType: "media",
      name: objectName,
      ifGenerationMatch,
      fields: "generation",
    });
    const headers = await this.authHeaders({ "Content-Type": contentType });
    if (author) headers["x-goog-meta-author"] = author;
    const res = await this.http({
      url: `${UPLOAD_API}/b/${encodeURIComponent(this.bucket)}/o?${params}`,
      method: "POST",
      headers,
      body: toArrayBuffer(data),
    });
    if (res.status === 412) throw new PreconditionFailedError(objectName);
    this.assertOk(res, "upload");
    const parsed = JSON.parse(res.text || "{}") as { generation?: string };
    return parsed.generation ?? "0";
  }

  /** Delete an object, optionally only if its generation matches. */
  async delete(objectName: string, ifGenerationMatch?: string): Promise<void> {
    const params = new URLSearchParams();
    if (ifGenerationMatch) params.set("ifGenerationMatch", ifGenerationMatch);
    const qs = params.toString();
    const res = await this.http({
      url: `${API}/b/${encodeURIComponent(this.bucket)}/o/${encodeURIComponent(
        objectName
      )}${qs ? `?${qs}` : ""}`,
      method: "DELETE",
      headers: await this.authHeaders(),
    });
    if (res.status === 404 || res.status === 412) return; // already gone / changed
    this.assertOk(res, "delete");
  }

  private assertOk(
    res: { status: number; text: string },
    op: string
  ): void {
    if (res.status < 200 || res.status >= 300) {
      throw new Error(
        `GCS ${op} failed (${res.status}): ${res.text || "no body"}`
      );
    }
  }
}

function toArrayBuffer(data: Uint8Array): ArrayBuffer {
  return data.buffer.slice(
    data.byteOffset,
    data.byteOffset + data.byteLength
  ) as ArrayBuffer;
}
