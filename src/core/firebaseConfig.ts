/**
 * Firebase project configuration — safe to commit (not a secret).
 * Fill these in from: Firebase console → Project settings → Your apps → Web app → Config.
 *
 * Steps to get these values:
 *  1. Go to https://console.firebase.google.com and open your project.
 *  2. Click the gear icon → Project settings → "Your apps" → Add a Web app (or use existing).
 *  3. Copy the firebaseConfig object shown there.
 */
export const FIREBASE_CONFIG = {
  apiKey: "AIzaSyC460NBtszdj4z32xI72-dpWp0Q-u8aiZc",
  authDomain: "obsidian-conote.firebaseapp.com",
  projectId: "obsidian-conote",
  storageBucket: "obsidian-conote.firebasestorage.app",
  messagingSenderId: "512956519874",
  appId: "1:512956519874:web:e3f2e8145c0ea301c2f25b"
};

/**
 * The URL of your deployed Cloud Function.
 * After deploying (see README), get this from:
 *   gcloud functions describe conote-api --format='value(httpsTrigger.url)'
 */
export const CLOUD_FUNCTION_URL =
  "https://REGION-PROJECT_ID.cloudfunctions.net/conote-api";

/**
 * The Firebase Hosting URL used as the magic-link action URL.
 * After deploying Firebase Hosting: https://YOUR_PROJECT_ID.web.app/auth
 */
export const AUTH_REDIRECT_BASE =
  "https://obsidian-conote.web.app//auth";
