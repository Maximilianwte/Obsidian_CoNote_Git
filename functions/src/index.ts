/**
 * Conote API — Cloud Function
 *
 * GCS proxy + share management. Verifies Firebase ID tokens on every request
 * and enforces Firestore-based access control before touching the bucket.
 *
 * Deploy:
 *   cd functions && npm install && npm run build
 *   gcloud functions deploy conote-api \
 *     --runtime nodejs20 --trigger-http --allow-unauthenticated \
 *     --entry-point app --source dist \
 *     --set-env-vars GCS_BUCKET=obsidian-conote \
 *     --set-env-vars GCS_KEY_JSON="$(cat /path/to/gcp-cloud-stroage-key.json)"
 */

import * as admin from "firebase-admin";
import { Storage } from "@google-cloud/storage";
import cors from "cors";
import express, {
  type Request,
  type Response,
  type NextFunction,
} from "express";
import crypto from "crypto";

// ── Initialise Firebase Admin ─────────────────────────────────────────────────

const keyJson = process.env.GCS_KEY_JSON;
if (!keyJson) {
  throw new Error("GCS_KEY_JSON env var is required.");
}
const serviceAccount = JSON.parse(keyJson) as admin.ServiceAccount;

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();
const bucket = new Storage({
  credentials: serviceAccount,
}).bucket(process.env.GCS_BUCKET ?? "obsidian-conote");

// ── Express app ───────────────────────────────────────────────────────────────

export const app = express();
app.use(cors({ origin: true }));
app.use(express.json({ limit: "50mb" }));
app.use(express.raw({ type: "*/*", limit: "50mb" }));

// ── Auth middleware ───────────────────────────────────────────────────────────

interface AuthedRequest extends Request {
  uid: string;
  email: string;
}

async function authenticate(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Missing Bearer token." });
    return;
  }
  try {
    const decoded = await admin.auth().verifyIdToken(auth.slice(7));
    (req as AuthedRequest).uid = decoded.uid;
    (req as AuthedRequest).email = decoded.email ?? "";
    next();
  } catch {
    res.status(401).json({ error: "Invalid token." });
  }
}

app.use(authenticate);

// ── Access control helpers ────────────────────────────────────────────────────

/** Returns true if uid is allowed to access the given GCS prefix. */
async function canAccess(uid: string, prefix: string): Promise<boolean> {
  // Own space.
  if (prefix.startsWith(`users/${uid}/`) || prefix === `users/${uid}`) {
    return true;
  }
  // Shared folder — look up Firestore.
  const snap = await db
    .collection("shares")
    .where("gcsPrefix", "==", stripTrailingSlash(prefix))
    .limit(1)
    .get();
  if (snap.empty) return false;
  const share = snap.docs[0].data() as ShareDoc;
  return share.owner === uid || (share.members ?? []).includes(uid);
}

function stripTrailingSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}

// ── GCS routes ────────────────────────────────────────────────────────────────

// GET /list?prefix=...
app.get("/list", async (req: Request, res: Response): Promise<void> => {
  const { uid } = req as AuthedRequest;
  const prefix = (req.query.prefix as string) ?? "";
  if (!(await canAccess(uid, prefix))) {
    res.status(403).json({ error: "Access denied." });
    return;
  }
  const [files] = await bucket.getFiles({ prefix, autoPaginate: true });
  const result = files
    .filter((f) => !f.name.endsWith("/"))
    .map((f) => ({
      name: f.name,
      generation: f.metadata.generation as string,
      author: (f.metadata.metadata as Record<string, string> | undefined)?.author,
      size: Number(f.metadata.size),
      updated: f.metadata.updated,
    }));
  res.json(result);
});

// GET /file?path=... [&metaOnly=true]
app.get("/file", async (req: Request, res: Response): Promise<void> => {
  const { uid } = req as AuthedRequest;
  const path = req.query.path as string;
  const metaOnly = req.query.metaOnly === "true";
  if (!path) { res.status(400).json({ error: "path required" }); return; }

  const prefix = prefixOf(path, uid);
  if (!(await canAccess(uid, prefix))) {
    res.status(403).json({ error: "Access denied." });
    return;
  }

  const file = bucket.file(path);
  const [exists] = await file.exists();
  if (!exists) { res.status(404).json({ error: "Not found." }); return; }

  const [meta] = await file.getMetadata();
  const generation = meta.generation as string;
  const author =
    (meta.metadata as Record<string, string> | undefined)?.author ?? "";

  res.set("X-Generation", generation);
  res.set("X-Author", author);

  if (metaOnly) {
    res.status(200).end();
    return;
  }

  const [contents] = await file.download();
  res.set("Content-Type", meta.contentType ?? "application/octet-stream");
  res.status(200).send(contents);
});

// PUT /file?path=...  body = raw bytes
app.put("/file", async (req: Request, res: Response): Promise<void> => {
  const { uid } = req as AuthedRequest;
  const path = req.query.path as string;
  if (!path) { res.status(400).json({ error: "path required" }); return; }

  const prefix = prefixOf(path, uid);
  if (!(await canAccess(uid, prefix))) {
    res.status(403).json({ error: "Access denied." });
    return;
  }

  const ifGenMatch = req.headers["x-if-generation-match"] as string | undefined;
  const author = req.headers["x-author"] as string | undefined;
  const contentType =
    (req.headers["content-type"] as string) ?? "application/octet-stream";

  const file = bucket.file(path);
  const saveOptions: Parameters<typeof file.save>[1] = {
    contentType,
    metadata: { metadata: { author: author ?? "" } },
  };
  if (ifGenMatch !== undefined) {
    saveOptions.preconditionOpts = { ifGenerationMatch: Number(ifGenMatch) };
  }

  try {
    const data = req.body as Buffer;
    await file.save(data, saveOptions);
    const [meta] = await file.getMetadata();
    res.json({ generation: meta.generation });
  } catch (err: unknown) {
    const code = (err as { code?: number })?.code;
    if (code === 412) {
      res.status(412).json({ error: "Precondition failed." });
      return;
    }
    throw err;
  }
});

// DELETE /file?path=...
app.delete("/file", async (req: Request, res: Response): Promise<void> => {
  const { uid } = req as AuthedRequest;
  const path = req.query.path as string;
  if (!path) { res.status(400).json({ error: "path required" }); return; }

  const prefix = prefixOf(path, uid);
  if (!(await canAccess(uid, prefix))) {
    res.status(403).json({ error: "Access denied." });
    return;
  }

  const ifGenMatch = req.headers["x-if-generation-match"] as string | undefined;
  const file = bucket.file(path);
  try {
    await file.delete(
      ifGenMatch !== undefined
        ? { ifGenerationMatch: Number(ifGenMatch) }
        : undefined
    );
  } catch (err: unknown) {
    const code = (err as { code?: number })?.code;
    if (code === 404 || code === 412) { res.status(200).end(); return; }
    throw err;
  }
  res.status(200).end();
});

// ── Share routes ──────────────────────────────────────────────────────────────

interface ShareDoc {
  owner: string;
  name: string;
  gcsPrefix: string;
  members: string[];
  invites: { token: string; createdAt: number }[];
}

// GET /shares — list all shares the user owns or is a member of
app.get("/shares", async (req: Request, res: Response): Promise<void> => {
  const { uid, email } = req as AuthedRequest;

  const [owned, membered] = await Promise.all([
    db.collection("shares").where("owner", "==", uid).get(),
    db.collection("shares").where("members", "array-contains", uid).get(),
  ]);

  const seen = new Set<string>();
  const result: object[] = [];
  for (const doc of [...owned.docs, ...membered.docs]) {
    if (seen.has(doc.id)) continue;
    seen.add(doc.id);
    const d = doc.data() as ShareDoc;
    result.push({
      shareId: doc.id,
      name: d.name,
      gcsPrefix: d.gcsPrefix,
      role: d.owner === uid ? "owner" : "member",
    });
  }
  void email; // available for future use
  res.json(result);
});

// POST /shares  { name }  — create a new share under the caller's space
app.post("/shares", async (req: Request, res: Response): Promise<void> => {
  const { uid } = req as AuthedRequest;
  const { name } = req.body as { name?: string };
  if (!name?.trim()) {
    res.status(400).json({ error: "name required" });
    return;
  }
  const gcsPrefix = `users/${uid}/${sanitizeName(name)}`;
  const ref = await db.collection("shares").add({
    owner: uid,
    name: name.trim(),
    gcsPrefix,
    members: [],
    invites: [],
  } as ShareDoc);
  res.json({ shareId: ref.id, name: name.trim(), gcsPrefix, role: "owner" });
});

// POST /shares/:shareId/invite — generate a one-time invite token
app.post(
  "/shares/:shareId/invite",
  async (req: Request, res: Response): Promise<void> => {
    const { uid } = req as AuthedRequest;
    const { shareId } = req.params;
    const ref = db.collection("shares").doc(shareId);
    const snap = await ref.get();
    if (!snap.exists) { res.status(404).json({ error: "Share not found." }); return; }
    const share = snap.data() as ShareDoc;
    if (share.owner !== uid) {
      res.status(403).json({ error: "Only the owner can invite." });
      return;
    }
    const token = crypto.randomBytes(16).toString("hex");
    await ref.update({
      invites: admin.firestore.FieldValue.arrayUnion({
        token,
        createdAt: Date.now(),
      }),
    });
    res.json({ token });
  }
);

// POST /shares/join  { token } — accept an invite
app.post("/shares/join", async (req: Request, res: Response): Promise<void> => {
  const { uid } = req as AuthedRequest;
  const { token } = req.body as { token?: string };
  if (!token) { res.status(400).json({ error: "token required" }); return; }

  // Find the share with this pending invite token.
  const snap = await db
    .collection("shares")
    .where("invites", "array-contains", { token, createdAt: 0 })
    .limit(1)
    .get();

  // Firestore array-contains on objects needs exact match — use a query on a subcollection
  // OR iterate. For a small dataset, iterate is fine.
  const all = await db.collection("shares").get();
  let found: admin.firestore.DocumentSnapshot | null = null;
  let foundInvite: { token: string; createdAt: number } | null = null;
  for (const doc of all.docs) {
    const d = doc.data() as ShareDoc;
    const inv = d.invites.find((i) => i.token === token);
    if (inv) { found = doc; foundInvite = inv; break; }
  }
  void snap; // unused fallback

  if (!found || !foundInvite) {
    res.status(404).json({ error: "Invalid or expired invite token." });
    return;
  }
  const share = found.data() as ShareDoc;
  if (share.owner === uid || share.members.includes(uid)) {
    res.json({ shareId: found.id, name: share.name, gcsPrefix: share.gcsPrefix, role: share.owner === uid ? "owner" : "member" });
    return;
  }

  // Remove invite, add member — atomic update.
  await found.ref.update({
    members: admin.firestore.FieldValue.arrayUnion(uid),
    invites: admin.firestore.FieldValue.arrayRemove(foundInvite),
  });
  res.json({
    shareId: found.id,
    name: share.name,
    gcsPrefix: share.gcsPrefix,
    role: "member",
  });
});

// DELETE /shares/:shareId/leave — leave or (if owner) delete
app.delete(
  "/shares/:shareId/leave",
  async (req: Request, res: Response): Promise<void> => {
    const { uid } = req as AuthedRequest;
    const { shareId } = req.params;
    const ref = db.collection("shares").doc(shareId);
    const snap = await ref.get();
    if (!snap.exists) { res.status(404).json({ error: "Share not found." }); return; }
    const share = snap.data() as ShareDoc;
    if (share.owner === uid) {
      await ref.delete();
    } else {
      await ref.update({
        members: admin.firestore.FieldValue.arrayRemove(uid),
      });
    }
    res.status(200).end();
  }
);

// ── Error handler ─────────────────────────────────────────────────────────────

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error("Conote API error:", err);
  res.status(500).json({ error: err.message ?? "Internal error." });
});

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Return the top-level GCS prefix for a given object path and requesting uid. */
function prefixOf(objectPath: string, uid: string): string {
  // "users/abc123/folder/file.md" → "users/abc123/folder"
  // "users/abc123/file.md" → "users/abc123"
  const parts = objectPath.split("/");
  if (parts[0] === "users" && parts.length >= 3) {
    return `${parts[0]}/${parts[1]}/${parts[2]}`;
  }
  return objectPath;
}

function sanitizeName(name: string): string {
  return name.trim().replace(/[^a-zA-Z0-9_\- ]/g, "_").replace(/\s+/g, "_");
}
