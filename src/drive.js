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

const TOKEN_STORAGE_KEY = "sample-typer:drive-token";

let tokenClient = null;
let accessToken = null;
let tokenExpiresAt = 0;
let rootFolderId = null;
let gisReady = null;

export const driveConfigured = () => Boolean(CLIENT_ID);
export const isDriveConnected = () => Boolean(accessToken) && Date.now() < tokenExpiresAt;

function saveTokenToStorage() {
  try { localStorage.setItem(TOKEN_STORAGE_KEY, JSON.stringify({ accessToken, tokenExpiresAt })); } catch { /* storage unavailable */ }
}
function clearStoredToken() {
  try { localStorage.removeItem(TOKEN_STORAGE_KEY); } catch { /* ignore */ }
}

/* Restores a still-valid token saved on a previous page load — instant,
   no network round trip, and immune to the third-party-cookie/popup
   issues that make Google's own silent reauth (below) unreliable. This
   is what actually keeps a page reload connected; trySilentConnect is
   only the fallback once the cached token has genuinely expired. */
export function restoreStoredToken() {
  try {
    const raw = localStorage.getItem(TOKEN_STORAGE_KEY);
    if (!raw) return false;
    const { accessToken: at, tokenExpiresAt: exp } = JSON.parse(raw);
    if (!at || !exp || Date.now() >= exp) { clearStoredToken(); return false; }
    accessToken = at;
    tokenExpiresAt = exp;
    return true;
  } catch {
    return false;
  }
}

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
      saveTokenToStorage();
      resolve(accessToken);
    };
    tokenClient.requestAccessToken({ prompt });
  });
}

async function ensureTokenClient() {
  await loadGis();
  if (!tokenClient) {
    tokenClient = window.google.accounts.oauth2.initTokenClient({
      client_id: CLIENT_ID,
      scope: SCOPE,
      use_fedcm_for_prompt: true, // Google's modern replacement for the third-party-cookie silent flow
      callback: () => {}, // replaced per-request in requestToken()
    });
  }
}

export async function connectDrive() {
  if (!CLIENT_ID) throw new Error("VITE_GOOGLE_CLIENT_ID is not set — see DRIVE_SETUP.md");
  await ensureTokenClient();
  return requestToken("consent");
}

/* Called on every page load: if this browser already granted consent and
   still has an active Google session, Google issues a fresh token with no
   popup and no click. If not, it fails quietly — no UI shown, no prompt —
   and the caller just falls back to the normal "Connect" button. */
export async function trySilentConnect() {
  if (!CLIENT_ID) return false;
  try {
    await ensureTokenClient();
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error("silent connect timed out")), 6000));
    await Promise.race([requestToken(""), timeout]);
    return true;
  } catch {
    return false;
  }
}

export function disconnectDrive() {
  if (accessToken && window.google?.accounts?.oauth2?.revoke) {
    window.google.accounts.oauth2.revoke(accessToken, () => {});
  }
  accessToken = null;
  tokenExpiresAt = 0;
  rootFolderId = null;
  clearStoredToken();
}

async function ensureToken() {
  if (isDriveConnected()) return accessToken;
  await ensureTokenClient();
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

const BLOCK_TAGS = new Set(["p", "div", "h1", "h2", "h3", "h4", "h5", "h6", "li"]);
const isBoldNode = (el) => el.tagName === "B" || el.tagName === "STRONG" || /font-weight:\s*(bold|[6-9]00)/i.test(el.getAttribute("style") || "");
const isItalicNode = (el) => el.tagName === "I" || el.tagName === "EM" || /font-style:\s*italic/i.test(el.getAttribute("style") || "");

/* Collapse a paragraph's inline soup (Docs wraps every run of text in its
   own styled <span>) down to plain text plus bold/italic only — everything
   else Docs bakes inline (color, font-family, font-size, margins) is
   dropped so the app's own theme and heading rule can apply instead. */
function sanitizeInlineFragment(node) {
  let out = "";
  for (const child of node.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) { out += escapeHtmlEntities(child.textContent); continue; }
    if (child.nodeType !== Node.ELEMENT_NODE) continue;
    if (child.tagName === "BR") { out += "<br>"; continue; }
    let inner = sanitizeInlineFragment(child);
    if (isBoldNode(child)) inner = `<b>${inner}</b>`;
    if (isItalicNode(child)) inner = `<i>${inner}</i>`;
    out += inner;
  }
  return out;
}
const escapeHtmlEntities = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/* Walk Docs' block structure (<p>, headings, list items, wrapper <div>s)
   and flatten it into one plain <div> per line — the exact shape the
   editor itself produces, so nothing here fights the app's own styling. */
function sanitizeImportedHtml(bodyEl) {
  const lines = [];
  const walk = (root) => {
    for (const child of root.children) {
      if (BLOCK_TAGS.has(child.tagName.toLowerCase())) {
        lines.push(sanitizeInlineFragment(child).trim());
      } else {
        walk(child);
      }
    }
  };
  walk(bodyEl);
  if (!lines.length) return "<div><br></div>";
  return lines.map((l) => `<div>${l || "<br>"}</div>`).join("");
}

/* The mirror image of pushDocToDrive's wrapping — Drive's HTML export comes
   back as a full document, heavily inline-styled by Docs itself, so unwrap
   and sanitize it before it ever reaches the editor. */
export async function exportDriveDocHtml(fileId) {
  const token = await ensureToken();
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=text/html`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Drive export ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const raw = await res.text();
  const parsed = new DOMParser().parseFromString(raw, "text/html");
  return parsed.body ? sanitizeImportedHtml(parsed.body) : raw;
}
