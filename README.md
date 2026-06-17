# Conote Shared Folder

Collaboratively edit a folder of Obsidian notes with a small group — backed by
**Google Cloud Storage**, with no server to maintain and no GCP setup required
for collaborators.

- **Email sign-in.** Click a magic link in your inbox — no password, no GCP account.
- **Central bucket.** One GCS bucket (`obsidian-conote`) owned by you. Collaborators
  never touch GCP.
- **Per-user folders.** Each user gets their own prefix in the bucket (`users/{uid}/`).
- **Folder sharing.** Share a folder by generating a one-click invite token and
  sending it to a friend. They paste it in the plugin and can sync immediately.
- **Safe conflicts.** If two people edit the same file between syncs, a
  **GitHub-style merge view** opens — no silent overwrites.
- **Claude co-user (planned).** The sync core is fully decoupled from Obsidian.
  A future MCP server will let Claude read and edit the same shared folder.

Desktop-only (Electron/Node required for local callback server).

---

## Architecture

```
Obsidian plugin (Firebase Auth SDK-free — pure REST)
  └── FirebaseAuthClient  →  Firebase Auth REST API  (magic link sign-in)
  └── ApiClient           →  Cloud Function (Node 20) →  GCS obsidian-conote
                                     │
                               Firestore (shares / memberships)
Firebase Hosting (static)  ←  magic link from email → completes sign-in in browser
                           →  localhost:{port}/callback → plugin captures tokens
```

---

## One-time owner setup

You (the bucket owner) do this once. Collaborators just install the plugin and sign in.

### 1 — GCP / Firebase project

You already have `obsidian-conote` bucket. Now:

1. Open [console.firebase.google.com](https://console.firebase.google.com) → **Add project** → **use existing GCP project** → select your project ID.
2. **Authentication** → Sign-in methods → enable **Email link (passwordless)**.
3. Add `localhost` and your Firebase Hosting domain (`*.web.app`) to the
   **Authorized domains** list.
4. **Firestore** → Create database → Production mode. Apply the rules below.
5. **Project settings** → Your apps → **Add app** (Web) → copy the `firebaseConfig` object.

#### Firestore security rules

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /shares/{shareId} {
      // Owners can write; members and owners can read.
      allow read:  if request.auth != null &&
                      (resource.data.owner == request.auth.uid ||
                       request.auth.uid in resource.data.members);
      allow write: if request.auth != null &&
                      resource.data.owner == request.auth.uid;
      allow create: if request.auth != null;
    }
  }
}
```

### 2 — Fill in `src/core/firebaseConfig.ts`

Paste your Firebase project config (from step 1.5 above) and the Cloud Function URL
(from step 3 below) into [src/core/firebaseConfig.ts](src/core/firebaseConfig.ts).

### 3 — Deploy the Cloud Function

```bash
cd functions
npm install
npm run build

gcloud functions deploy conote-api \
  --runtime nodejs20 \
  --trigger-http \
  --allow-unauthenticated \
  --entry-point app \
  --source dist \
  --set-env-vars GCS_BUCKET=obsidian-conote \
  --set-env-vars "GCS_KEY_JSON=$(cat /Users/maximilian/Documents/JS/conote-obsidian/gcp-cloud-stroage-key.json)"
```

Get the function URL:
```bash
gcloud functions describe conote-api --format='value(httpsTrigger.url)'
```
Paste it into `CLOUD_FUNCTION_URL` in `firebaseConfig.ts`.

> The service-account key is stored as a Cloud Function environment variable —
> never distributed to users.

### 4 — Deploy Firebase Hosting

Fill in the Firebase config in [hosting/index.html](hosting/index.html) (same values as `firebaseConfig.ts`), then:

```bash
npm install -g firebase-tools
firebase login
cd hosting
# Edit .firebaserc: replace REPLACE_WITH_YOUR_PROJECT_ID
firebase deploy --only hosting
```

Paste the Hosting URL into `AUTH_REDIRECT_BASE` in `firebaseConfig.ts`.

**Important:** add `https://YOUR_PROJECT.web.app` to Firebase Auth's authorized domains.

### 5 — Build and install the plugin

```bash
cd ..  # back to project root
npm install
npm run build
```

Copy `main.js`, `manifest.json`, `styles.css` into:
```
<your-vault>/.obsidian/plugins/conote-shared-folder/
```
Enable in **Settings → Community plugins**.

---

## Using the plugin

### Sign in (first use)
1. **Settings → Conote Shared Folder → Sign in with email**
2. Enter your email → click **Send sign-in link**
3. Check your inbox → click the magic link → browser opens and completes sign-in
4. The modal closes automatically: "Signed in as you@example.com"

### Sync a personal folder
1. **Settings → Add folder mapping**
2. Set **Vault folder** (e.g. `Shared/Notes`) and **GCS prefix** (auto-filled to
   `users/{uid}/Notes` — keep the `users/{uid}/` prefix)
3. Enable **Automatic sync** (on by default)

### Share a folder with someone
1. **Settings → Manage shares… → Create a new shared folder** → enter a name → **Create**
2. Click **Get invite token** — the token is copied to your clipboard
3. Send the token to your collaborator (any messaging app)
4. They: **Settings → Manage shares… → Join a shared folder** → paste token → **Join**
5. Both sides get a new folder mapping auto-added pointing at the shared prefix

### Conflict resolution
When two people edit the same file between syncs, a **Resolve conflict** modal opens:
- Left pane: your version with diff highlights
- Right pane: their version
- Bottom: editable merged result
- Use **"Use mine" / "Use theirs"**, copy-paste between panes, then **Save & upload**

---

## Distributing to collaborators

1. Build: `npm run build`
2. Share the folder (`main.js`, `manifest.json`, `styles.css`) — e.g. via GitHub
   release or [BRAT](https://github.com/TfTHacker/obsidian42-brat)
3. Collaborators install the plugin, open Settings, sign in with their email
4. Send them an invite token for any folder you want to share

They never touch GCP, Firebase console, or JSON keys.

---

## Project structure

```
src/
  core/               No Obsidian imports — reusable in MCP server (v3)
    types.ts          Shared types
    fileStore.ts      IGcsClient + FileStore + SyncStateStore interfaces
    firebaseConfig.ts  ← Fill this in (Firebase config + Function URL)
    firebaseAuth.ts   Firebase Auth via REST (no SDK)
    apiClient.ts      Cloud Function client, implements IGcsClient
    gcs.ts            Direct GCS client (v1/MCP use)
    sync.ts           Sync engine (push/pull/conflict, unchanged from v1)
    syncState.ts      Hashing, path mapping
  obsidian/
    main.ts           Plugin entry point
    settings.ts       Settings tab (sign in, folder mappings, sync)
    authModal.ts      Magic link sign-in + local callback server
    sharesModal.ts    Create / join / leave shared folders
    mergeModal.ts     GitHub-style conflict resolution UI
    vaultFileStore.ts Vault adapter (FileStore implementation)

functions/            Cloud Function (deploy once to GCP)
  src/index.ts        Express app: GCS proxy + share management

hosting/              Firebase Hosting (deploy once)
  index.html          Magic link completion page
```
