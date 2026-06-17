"use strict";
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
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.app = void 0;
const admin = __importStar(require("firebase-admin"));
const storage_1 = require("@google-cloud/storage");
const cors_1 = __importDefault(require("cors"));
const express_1 = __importDefault(require("express"));
const crypto_1 = __importDefault(require("crypto"));
// ── Initialise Firebase Admin ─────────────────────────────────────────────────
const keyJson = process.env.GCS_KEY_JSON;
if (!keyJson) {
    throw new Error("GCS_KEY_JSON env var is required.");
}
const serviceAccount = JSON.parse(keyJson);
admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
});
const db = admin.firestore();
const bucket = new storage_1.Storage({
    credentials: serviceAccount,
}).bucket(process.env.GCS_BUCKET ?? "obsidian-conote");
// ── Express app ───────────────────────────────────────────────────────────────
exports.app = (0, express_1.default)();
exports.app.use((0, cors_1.default)({ origin: true }));
exports.app.use(express_1.default.json({ limit: "50mb" }));
exports.app.use(express_1.default.raw({ type: "*/*", limit: "50mb" }));
async function authenticate(req, res, next) {
    const auth = req.headers.authorization;
    if (!auth?.startsWith("Bearer ")) {
        res.status(401).json({ error: "Missing Bearer token." });
        return;
    }
    try {
        const decoded = await admin.auth().verifyIdToken(auth.slice(7));
        req.uid = decoded.uid;
        req.email = decoded.email ?? "";
        next();
    }
    catch {
        res.status(401).json({ error: "Invalid token." });
    }
}
exports.app.use(authenticate);
// ── Access control helpers ────────────────────────────────────────────────────
/** Returns true if uid is allowed to access the given GCS prefix. */
async function canAccess(uid, prefix) {
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
    if (snap.empty)
        return false;
    const share = snap.docs[0].data();
    return share.owner === uid || (share.members ?? []).includes(uid);
}
function stripTrailingSlash(s) {
    return s.endsWith("/") ? s.slice(0, -1) : s;
}
// ── GCS routes ────────────────────────────────────────────────────────────────
// GET /list?prefix=...
exports.app.get("/list", async (req, res) => {
    const { uid } = req;
    const prefix = req.query.prefix ?? "";
    if (!(await canAccess(uid, prefix))) {
        res.status(403).json({ error: "Access denied." });
        return;
    }
    const [files] = await bucket.getFiles({ prefix, autoPaginate: true });
    const result = files
        .filter((f) => !f.name.endsWith("/"))
        .map((f) => ({
        name: f.name,
        generation: f.metadata.generation,
        author: f.metadata.metadata?.author,
        size: Number(f.metadata.size),
        updated: f.metadata.updated,
    }));
    res.json(result);
});
// GET /file?path=... [&metaOnly=true]
exports.app.get("/file", async (req, res) => {
    const { uid } = req;
    const path = req.query.path;
    const metaOnly = req.query.metaOnly === "true";
    if (!path) {
        res.status(400).json({ error: "path required" });
        return;
    }
    const prefix = prefixOf(path, uid);
    if (!(await canAccess(uid, prefix))) {
        res.status(403).json({ error: "Access denied." });
        return;
    }
    const file = bucket.file(path);
    const [exists] = await file.exists();
    if (!exists) {
        res.status(404).json({ error: "Not found." });
        return;
    }
    const [meta] = await file.getMetadata();
    const generation = meta.generation;
    const author = meta.metadata?.author ?? "";
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
exports.app.put("/file", async (req, res) => {
    const { uid } = req;
    const path = req.query.path;
    if (!path) {
        res.status(400).json({ error: "path required" });
        return;
    }
    const prefix = prefixOf(path, uid);
    if (!(await canAccess(uid, prefix))) {
        res.status(403).json({ error: "Access denied." });
        return;
    }
    const ifGenMatch = req.headers["x-if-generation-match"];
    const author = req.headers["x-author"];
    const contentType = req.headers["content-type"] ?? "application/octet-stream";
    const file = bucket.file(path);
    const saveOptions = {
        contentType,
        metadata: { metadata: { author: author ?? "" } },
    };
    if (ifGenMatch !== undefined) {
        saveOptions.preconditionOpts = { ifGenerationMatch: Number(ifGenMatch) };
    }
    try {
        const data = req.body;
        await file.save(data, saveOptions);
        const [meta] = await file.getMetadata();
        res.json({ generation: meta.generation });
    }
    catch (err) {
        const code = err?.code;
        if (code === 412) {
            res.status(412).json({ error: "Precondition failed." });
            return;
        }
        throw err;
    }
});
// DELETE /file?path=...
exports.app.delete("/file", async (req, res) => {
    const { uid } = req;
    const path = req.query.path;
    if (!path) {
        res.status(400).json({ error: "path required" });
        return;
    }
    const prefix = prefixOf(path, uid);
    if (!(await canAccess(uid, prefix))) {
        res.status(403).json({ error: "Access denied." });
        return;
    }
    const ifGenMatch = req.headers["x-if-generation-match"];
    const file = bucket.file(path);
    try {
        await file.delete(ifGenMatch !== undefined
            ? { ifGenerationMatch: Number(ifGenMatch) }
            : undefined);
    }
    catch (err) {
        const code = err?.code;
        if (code === 404 || code === 412) {
            res.status(200).end();
            return;
        }
        throw err;
    }
    res.status(200).end();
});
// GET /shares — list all shares the user owns or is a member of
exports.app.get("/shares", async (req, res) => {
    const { uid, email } = req;
    const [owned, membered] = await Promise.all([
        db.collection("shares").where("owner", "==", uid).get(),
        db.collection("shares").where("members", "array-contains", uid).get(),
    ]);
    const seen = new Set();
    const result = [];
    for (const doc of [...owned.docs, ...membered.docs]) {
        if (seen.has(doc.id))
            continue;
        seen.add(doc.id);
        const d = doc.data();
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
exports.app.post("/shares", async (req, res) => {
    const { uid } = req;
    const { name } = req.body;
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
    });
    res.json({ shareId: ref.id, name: name.trim(), gcsPrefix, role: "owner" });
});
// POST /shares/:shareId/invite — generate a one-time invite token
exports.app.post("/shares/:shareId/invite", async (req, res) => {
    const { uid } = req;
    const { shareId } = req.params;
    const ref = db.collection("shares").doc(shareId);
    const snap = await ref.get();
    if (!snap.exists) {
        res.status(404).json({ error: "Share not found." });
        return;
    }
    const share = snap.data();
    if (share.owner !== uid) {
        res.status(403).json({ error: "Only the owner can invite." });
        return;
    }
    const token = crypto_1.default.randomBytes(16).toString("hex");
    await ref.update({
        invites: admin.firestore.FieldValue.arrayUnion({
            token,
            createdAt: Date.now(),
        }),
    });
    res.json({ token });
});
// POST /shares/join  { token } — accept an invite
exports.app.post("/shares/join", async (req, res) => {
    const { uid } = req;
    const { token } = req.body;
    if (!token) {
        res.status(400).json({ error: "token required" });
        return;
    }
    // Find the share with this pending invite token.
    const snap = await db
        .collection("shares")
        .where("invites", "array-contains", { token, createdAt: 0 })
        .limit(1)
        .get();
    // Firestore array-contains on objects needs exact match — use a query on a subcollection
    // OR iterate. For a small dataset, iterate is fine.
    const all = await db.collection("shares").get();
    let found = null;
    let foundInvite = null;
    for (const doc of all.docs) {
        const d = doc.data();
        const inv = d.invites.find((i) => i.token === token);
        if (inv) {
            found = doc;
            foundInvite = inv;
            break;
        }
    }
    void snap; // unused fallback
    if (!found || !foundInvite) {
        res.status(404).json({ error: "Invalid or expired invite token." });
        return;
    }
    const share = found.data();
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
exports.app.delete("/shares/:shareId/leave", async (req, res) => {
    const { uid } = req;
    const { shareId } = req.params;
    const ref = db.collection("shares").doc(shareId);
    const snap = await ref.get();
    if (!snap.exists) {
        res.status(404).json({ error: "Share not found." });
        return;
    }
    const share = snap.data();
    if (share.owner === uid) {
        await ref.delete();
    }
    else {
        await ref.update({
            members: admin.firestore.FieldValue.arrayRemove(uid),
        });
    }
    res.status(200).end();
});
// ── Error handler ─────────────────────────────────────────────────────────────
exports.app.use((err, _req, res, _next) => {
    console.error("Conote API error:", err);
    res.status(500).json({ error: err.message ?? "Internal error." });
});
// ── Helpers ───────────────────────────────────────────────────────────────────
/** Return the top-level GCS prefix for a given object path and requesting uid. */
function prefixOf(objectPath, uid) {
    // "users/abc123/folder/file.md" → "users/abc123/folder"
    // "users/abc123/file.md" → "users/abc123"
    const parts = objectPath.split("/");
    if (parts[0] === "users" && parts.length >= 3) {
        return `${parts[0]}/${parts[1]}/${parts[2]}`;
    }
    return objectPath;
}
function sanitizeName(name) {
    return name.trim().replace(/[^a-zA-Z0-9_\- ]/g, "_").replace(/\s+/g, "_");
}
