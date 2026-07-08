/* ————————————————————————————————————————————————————————
   Google Drive bridge — signs in with Google Identity Services
   (browser-only, no backend) and keeps drafts as native Google
   Docs via the Drive v3 REST API, scoped to drive.file so the
   app only ever touches files it created itself.
———————————————————————————————————————————————————————— */

const SCOPE = "https://www.googleapis.com/auth/drive.file";
/* Not a secret — Client IDs ship inside every OAuth request and the built JS
   bundle regardless. The real access boundary is Google's Authorized
   JavaScript Origins allowlist plus the OAuth consent screen's test-user
   list, not hiding this string. Falls back to this project's ID so it works
   without needing a platform env var configured (e.g. on Vercel's free tier). */
const CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID || "458772377918-fa3617rsh2eluujqdd0eca4m4i2g66mh.apps.googleusercontent.com";
const ROOT_FOLDER_NAME = "Sample Typer";

let tokenClient = null;
let accessToken = null;
let tokenExpiresAt = 0;
let rootFolderId = null;
let gisReady = null;

export const driveConfigured = () => Boolean(CLIENT_ID);
export const isDriveConnected = () => Boolean(accessToken) && Date.now() < tokenExpiresAt;

function loadGis() {
  if (gisReady) return gisReady;
  gisReady = new Promise((resolve, reject) => {
    const deadline = Date.now() + 10000;
    const check = () => {
      if (window.google?.accounts?.oauth2) return resolve();
      if (Date.now() > deadline) return reject(new Error("Google sign-in script failed to load"));
      setTimeout(check, 100);
    };
    check();
  });
  return gisReady;
}

function requestToken(prompt) {
  return new Promise((resolve, reject) => {
    tokenClient.callback = (resp) => {
      if (resp.error) { reject(new Error(resp.error_description || resp.error)); return; }
      accessToken = resp.access_token;
      tokenExpiresAt = Date.now() + (resp.expires_in - 60) * 1000;
      resolve(accessToken);
    };
    tokenClient.requestAccessToken({ prompt });
  });
}

export async function connectDrive() {
  if (!CLIENT_ID) throw new Error("VITE_GOOGLE_CLIENT_ID is not set — see DRIVE_SETUP.md");
  await loadGis();
  if (!tokenClient) {
    tokenClient = window.google.accounts.oauth2.initTokenClient({
      client_id: CLIENT_ID,
      scope: SCOPE,
      callback: () => {}, // replaced per-request in requestToken()
    });
  }
  return requestToken("consent");
}

export function disconnectDrive() {
  if (accessToken && window.google?.accounts?.oauth2?.revoke) {
    window.google.accounts.oauth2.revoke(accessToken, () => {});
  }
  accessToken = null;
  tokenExpiresAt = 0;
  rootFolderId = null;
}

async function ensureToken() {
  if (isDriveConnected()) return accessToken;
  if (!tokenClient) throw new Error("Google Drive is not connected");
  await loadGis();
  return requestToken(""); // silent renewal — the user already granted consent
}

async function driveFetch(path, opts = {}) {
  const token = await ensureToken();
  const res = await fetch(`https://www.googleapis.com/drive/v3/${path}`, {
    ...opts,
    headers: { ...(opts.headers || {}), Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Drive API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.status === 204 ? null : res.json();
}

const esc = (s) => s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");

export async function ensureRootFolder() {
  if (rootFolderId) return rootFolderId;
  const q = encodeURIComponent(
    `name='${esc(ROOT_FOLDER_NAME)}' and mimeType='application/vnd.google-apps.folder' and trashed=false and 'root' in parents`
  );
  const found = await driveFetch(`files?q=${q}&fields=files(id,name)&spaces=drive`);
  if (found.files?.length) { rootFolderId = found.files[0].id; return rootFolderId; }
  const created = await driveFetch("files", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: ROOT_FOLDER_NAME, mimeType: "application/vnd.google-apps.folder" }),
  });
  rootFolderId = created.id;
  return rootFolderId;
}

export async function ensureFolder(name, parentId) {
  const parent = parentId || (await ensureRootFolder());
  const q = encodeURIComponent(
    `name='${esc(name)}' and mimeType='application/vnd.google-apps.folder' and trashed=false and '${parent}' in parents`
  );
  const found = await driveFetch(`files?q=${q}&fields=files(id,name)&spaces=drive`);
  if (found.files?.length) return found.files[0].id;
  const created = await driveFetch("files", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, mimeType: "application/vnd.google-apps.folder", parents: [parent] }),
  });
  return created.id;
}

export function renameDriveFile(fileId, name) {
  return driveFetch(`files/${fileId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
}

export function moveDriveFile(fileId, newParentId, oldParentId) {
  const params = new URLSearchParams({ addParents: newParentId });
  if (oldParentId) params.set("removeParents", oldParentId);
  return driveFetch(`files/${fileId}?${params.toString()}`, { method: "PATCH" });
}

export function trashDriveFile(fileId) {
  return driveFetch(`files/${fileId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ trashed: true }),
  }).catch(() => {}); // best-effort — a doc getting orphaned in Drive isn't fatal
}

/* Create or update a native Google Doc from HTML. Drive converts the
   uploaded HTML into Docs' own format on the way in, both on create
   and on every subsequent content update. */
export async function pushDocToDrive({ driveFileId, name, html, parentId }) {
  const token = await ensureToken();
  const metadata = { name };
  if (!driveFileId) {
    metadata.mimeType = "application/vnd.google-apps.document";
    if (parentId) metadata.parents = [parentId];
  }

  const boundary = "st_" + Math.random().toString(36).slice(2);
  const fullHtml = `<html><body>${html || "<div><br></div>"}</body></html>`;
  const body =
    `--${boundary}\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
    `${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: text/html; charset=UTF-8\r\n\r\n` +
    `${fullHtml}\r\n` +
    `--${boundary}--`;

  const url = driveFileId
    ? `https://www.googleapis.com/upload/drive/v3/files/${driveFileId}?uploadType=multipart`
    : `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart`;

  const res = await fetch(url, {
    method: driveFileId ? "PATCH" : "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": `multipart/related; boundary=${boundary}`,
    },
    body,
  });
  if (!res.ok) throw new Error(`Drive upload ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const json = await res.json();
  return json.id;
}

/* Everything directly inside a folder — used to rebuild the local library
   from what's actually sitting in Drive (a fresh device, a cleared browser,
   another login). */
export async function listDriveChildren(parentId) {
  const q = encodeURIComponent(`'${parentId}' in parents and trashed=false`);
  const res = await driveFetch(`files?q=${q}&fields=files(id,name,mimeType,modifiedTime)&pageSize=1000&spaces=drive`);
  return res.files || [];
}

/* The mirror image of pushDocToDrive's wrapping — Drive's HTML export comes
   back as a full document with <head>/styles, so unwrap to just the body
   before handing it to the editor. */
export async function exportDriveDocHtml(fileId) {
  const token = await ensureToken();
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=text/html`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Drive export ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const raw = await res.text();
  const parsed = new DOMParser().parseFromString(raw, "text/html");
  return parsed.body ? parsed.body.innerHTML : raw;
}
