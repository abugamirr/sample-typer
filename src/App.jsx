import { useState, useEffect, useRef, useCallback } from "react";
import {
  driveConfigured, isDriveConnected, connectDrive, disconnectDrive, trySilentConnect, restoreStoredToken,
  ensureRootFolder, ensureFolder, renameDriveFile, moveDriveFile, trashDriveFile, pushDocToDrive,
  listDriveChildren, exportDriveDocHtml,
} from "./drive";

/* ————————————————————————————————————————————————————————
   SAMPLE TYPER v5 — a quiet writing room for scripts & prose

   The finalization pass:
   • Rich text — bold (⌘B), italic (⌘I), and the first line is
     the title, iPhone-Notes style. Renaming = editing line one.
   • Focus mode, rebuilt — the writing line now rests at the
     upper third (~33%), where the eye naturally settles, like
     lyrics on a music player but quieter. Scrolling releases
     the vignette so you can re-read in full light; the moment
     you type, it locks back onto the platen.
   • The scrollbar is gone — a hair-thin ghost appears only
     while your cursor is over the page edge.
   • Softer palette pass — warm gradients instead of hard
     borders, hover glow on every row.
   • Backup all → one .json, for a manual copy anywhere you like;
     Restore merges it back, newest version of each draft wins.
   • Connect Google Drive and every draft lives there too, as a
     real, editable Google Doc — synced live as you type, filed
     into matching Drive folders.
   Autosaves every keystroke to persistent storage.
———————————————————————————————————————————————————————— */

const T = {
  bg: "#171412",
  bgDeep: "#131110",
  panel: "#1E1A16",
  edge: "rgba(150,125,95,0.13)",
  edgeSoft: "rgba(150,125,95,0.08)",
  ink: "#E9E2D4",
  inkBright: "#F3EDDF",
  inkDim: "#9A907F",
  inkFaint: "#605A4E",
  accent: "#C77B52",
  accentSoft: "rgba(199,123,82,0.14)",
  accentGlow: "rgba(199,123,82,0.32)",
  good: "#7FA37A",
  warn: "#C9A26B",
  rowHover: "rgba(233,226,212,0.035)",
};

const SERIF = "'Charter', 'Iowan Old Style', Georgia, 'Times New Roman', serif";
const MONO = "'Courier Prime', 'Courier New', Courier, monospace";
const UI = "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif";

const PLATEN = 0.33; // the writing line rests at the upper third — natural eye level

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const timeAgo = (ts) => {
  if (!ts) return "";
  const m = Math.floor((Date.now() - ts) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
};
const byRecent = (a, b) => (b.updatedAt || 0) - (a.updatedAt || 0);

/* ——— html <-> text helpers ——— */
const scratch = typeof document !== "undefined" ? document.createElement("div") : null;
const htmlToText = (html) => {
  if (!scratch) return "";
  scratch.innerHTML = html || "";
  return scratch.innerText || "";
};
const escapeHtml = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const textToHtml = (text) =>
  (text || "")
    .split("\n")
    .map((line) => (line.trim() ? `<div>${escapeHtml(line)}</div>` : "<div><br></div>"))
    .join("");
const looksLikeHtml = (s) => /^\s*</.test(s || "");
const countWordsText = (t) => (t.trim() ? t.trim().split(/\s+/).length : 0);
const countWordsHtml = (html) => countWordsText(htmlToText(html));
const firstLineTitle = (html) => {
  if (!scratch) return "Untitled";
  scratch.innerHTML = html || "";
  const first = scratch.firstChild;
  const t = (first ? (first.innerText ?? first.textContent) : "") || "";
  return t.trim().slice(0, 80) || "Untitled";
};

export default function SampleTyper() {
  const [folders, setFolders] = useState([]);
  const [docs, setDocs] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [title, setTitle] = useState("");       // derived from line one
  const [bodyHtml, setBodyHtml] = useState(""); // current html, for saving/stats
  const [mode, setMode] = useState("prose");
  const [status, setStatus] = useState("idle");
  const [loading, setLoading] = useState(true);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [moveMenuFor, setMoveMenuFor] = useState(null);
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [renamingFolder, setRenamingFolder] = useState(null);
  const [renameValue, setRenameValue] = useState("");
  const [confirmDissolve, setConfirmDissolve] = useState(null);
  const [docNonce, setDocNonce] = useState(0); // bumps every doc load — drives the imperative content write

  /* drag & drop */
  const [draggingId, setDraggingId] = useState(null);
  const [dragOver, setDragOver] = useState(null);
  const [dropFlash, setDropFlash] = useState(null);

  /* focus mode */
  const [focus, setFocus] = useState(false);
  const [reviewing, setReviewing] = useState(false); // scrolled away to re-read
  const [chromeHover, setChromeHover] = useState(false);
  const [isEmpty, setIsEmpty] = useState(true);

  /* session goal */
  const [sessionWords, setSessionWords] = useState(0);
  const [goal, setGoal] = useState(null);
  const [goalEditing, setGoalEditing] = useState(false);
  const [goalInput, setGoalInput] = useState("");
  const [lastBackupAt, setLastBackupAt] = useState(null);

  /* Google Drive live sync */
  const [driveStatus, setDriveStatus] = useState("disconnected"); // disconnected | connecting | connected | syncing | error
  const [driveError, setDriveError] = useState("");
  const [activeDriveFileId, setActiveDriveFileId] = useState(null);
  const driveSyncTimer = useRef(null);

  const saveTimer = useRef(null);
  const retryTimer = useRef(null);
  const latest = useRef({ id: null, html: "" });
  const latestLib = useRef({ folders: [], docs: [] });
  const prevWordCount = useRef(0);
  const prevLen = useRef(0);
  const initialHtml = useRef("");     // what the editor mounts with, per doc
  const editorRef = useRef(null);     // the contentEditable page
  const scrollRef = useRef(null);     // its scrolling container
  const bloomRef = useRef(null);
  const progScroll = useRef(false);   // ignore our own smooth scrolls
  const prefsRef = useRef({});
  latest.current = { id: activeId, html: bodyHtml };
  latestLib.current = { folders, docs };

  /* ——— load library, migrating older formats ——— */
  useEffect(() => {
    (async () => {
      try {
        const res = await window.storage.get("writer:index");
        const parsed = res ? JSON.parse(res.value) : { folders: [], docs: [] };
        const lib = Array.isArray(parsed)
          ? { folders: [], docs: parsed.map((d) => ({ ...d, folderId: null })) }
          : { folders: parsed.folders || [], docs: parsed.docs || [] };
        setFolders(lib.folders);
        setDocs(lib.docs);
        latestLib.current = { folders: lib.folders, docs: lib.docs }; // ahead of the render — syncFromDrive below reads this
        const first = [...lib.docs].sort(byRecent)[0];
        if (first) await openDoc(first.id);
      } catch { /* first visit */ }
      try {
        const prefs = await window.storage.get("writer:prefs");
        if (prefs) {
          const p = JSON.parse(prefs.value);
          prefsRef.current = p;
          if (p.goal) setGoal(p.goal);
          if (p.lastBackupAt) setLastBackupAt(p.lastBackupAt);
        }
      } catch { /* no prefs yet */ }
      setLoading(false);

      /* try to pick the Drive connection back up without making the user
         click "Connect" again every single reload */
      if (driveConfigured()) {
        if (restoreStoredToken()) {
          setDriveStatus("connected");
          await syncFromDrive();
        } else {
          setDriveStatus("connecting");
          const ok = await trySilentConnect();
          if (ok) { setDriveStatus("connected"); await syncFromDrive(); }
          else setDriveStatus("disconnected");
        }
      }
    })();
    return () => {
      clearTimeout(saveTimer.current);
      clearTimeout(retryTimer.current);
    };
  }, []);

  const persistLib = useCallback(async (lib) => {
    setFolders(lib.folders);
    setDocs(lib.docs);
    try {
      await window.storage.set("writer:index", JSON.stringify(lib));
      return true;
    } catch {
      setStatus("offline");
      clearTimeout(retryTimer.current);
      retryTimer.current = setTimeout(() => persistLib(latestLib.current), 4000);
      return false;
    }
  }, []);

  const openDoc = async (id) => {
    setMoveMenuFor(null);
    try {
      const res = await window.storage.get(`writer:doc:${id}`);
      const doc = res ? JSON.parse(res.value) : null;
      if (doc) {
        let html;
        if (looksLikeHtml(doc.body)) {
          html = doc.body || "";
        } else {
          /* migrate plain text: the old separate title becomes line one */
          const t = doc.title && doc.title !== "Untitled" ? doc.title + "\n" : "";
          html = textToHtml(t + (doc.body || ""));
        }
        /* heal drafts saved before the wrap fix: non-breaking spaces the
           browser left behind become ordinary, wrappable spaces */
        html = html.replace(/&nbsp;/g, " ").replace(/\u00A0/g, " ");
        initialHtml.current = html;
        setActiveId(doc.id);
        setBodyHtml(html);
        setTitle(firstLineTitle(html));
        setMode(doc.mode || "prose");
        setStatus("saved");
        setActiveDriveFileId(doc.driveFileId || null);
        const text = htmlToText(html);
        prevWordCount.current = countWordsText(text);
        prevLen.current = text.length;
        setIsEmpty(!text.trim());
        setReviewing(false);
        setDocNonce((n) => n + 1);
      }
    } catch {
      const meta = latestLib.current.docs.find((d) => d.id === id);
      if (meta) {
        initialHtml.current = "";
        setActiveId(id);
        setBodyHtml("");
        setTitle(meta.title);
        setStatus("offline");
        prevWordCount.current = 0;
        prevLen.current = 0;
        setIsEmpty(true);
        setActiveDriveFileId(meta.driveFileId || null);
        setDocNonce((n) => n + 1);
      }
    }
  };

  /* ——— the save engine ——— */
  const persist = useCallback(async (id, html, m) => {
    const now = Date.now();
    setStatus("saving");
    try {
      const meta = latestLib.current.docs.find((d) => d.id === id);
      const t = firstLineTitle(html);
      const doc = { id, title: t, body: html, format: "html", mode: m, folderId: meta?.folderId ?? null, updatedAt: now, driveFileId: meta?.driveFileId ?? null };
      await window.storage.set(`writer:doc:${id}`, JSON.stringify(doc));
      const nextDocs = [
        { id, title: t, updatedAt: now, words: countWordsHtml(html), folderId: meta?.folderId ?? null, driveFileId: meta?.driveFileId ?? null },
        ...latestLib.current.docs.filter((d) => d.id !== id),
      ];
      const ok = await persistLib({ folders: latestLib.current.folders, docs: nextDocs });
      if (!ok) return;
      if (latest.current.id === id && latest.current.html === html) setStatus("saved");
      scheduleDriveSync(id, html);
    } catch {
      setStatus("offline");
      clearTimeout(retryTimer.current);
      retryTimer.current = setTimeout(() => {
        const { id: ci, html: ch } = latest.current;
        if (ci) persist(ci, ch, m);
      }, 4000);
    }
  }, [persistLib]);

  const scheduleSave = (html, m) => {
    setStatus("dirty");
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      const { id } = latest.current;
      if (id) persist(id, html, m ?? mode);
    }, 900);
  };

  const saveNow = () => {
    clearTimeout(saveTimer.current);
    if (activeId) persist(activeId, latest.current.html, mode);
  };

  /* ——— Google Drive live sync ——— */
  const resolveDriveFolder = async (folderId, folder) => {
    if (!folderId) return ensureRootFolder();
    if (folder?.driveFolderId) return folder.driveFolderId;
    const parentDriveId = await ensureRootFolder();
    const driveFolderId = await ensureFolder(folder?.name || "Untitled folder", parentDriveId);
    const nextFolders = latestLib.current.folders.map((f) => (f.id === folderId ? { ...f, driveFolderId } : f));
    await persistLib({ folders: nextFolders, docs: latestLib.current.docs });
    return driveFolderId;
  };

  const attachDriveFileId = async (id, fileId) => {
    const nextDocs = latestLib.current.docs.map((d) => (d.id === id ? { ...d, driveFileId: fileId } : d));
    await persistLib({ folders: latestLib.current.folders, docs: nextDocs });
    try {
      const res = await window.storage.get(`writer:doc:${id}`);
      if (res) {
        const doc = JSON.parse(res.value);
        await window.storage.set(`writer:doc:${id}`, JSON.stringify({ ...doc, driveFileId: fileId }));
      }
    } catch { /* index already carries it */ }
  };

  const syncDocToDrive = useCallback(async (id, html) => {
    if (!isDriveConnected()) return;
    setDriveStatus("syncing");
    try {
      const meta = latestLib.current.docs.find((d) => d.id === id);
      const folder = latestLib.current.folders.find((f) => f.id === meta?.folderId);
      const parentId = await resolveDriveFolder(meta?.folderId ?? null, folder);
      const name = firstLineTitle(html) || "Untitled";
      const fileId = await pushDocToDrive({ driveFileId: meta?.driveFileId || null, name, html, parentId });
      if (!meta?.driveFileId) await attachDriveFileId(id, fileId);
      if (latest.current.id === id) setActiveDriveFileId(fileId);
      setDriveStatus("connected");
    } catch (e) {
      setDriveStatus("error");
      setDriveError(e.message || String(e));
    }
  }, []);

  const scheduleDriveSync = (id, html) => {
    if (!isDriveConnected()) return;
    clearTimeout(driveSyncTimer.current);
    driveSyncTimer.current = setTimeout(() => syncDocToDrive(id, html), 2000);
  };

  /* Pull the library back from Drive — reconciles folders and docs that
     exist there but not locally (a new device, a cleared browser), and
     refreshes any local doc Drive holds a newer copy of. Newest wins,
     mirroring the JSON Restore merge logic. */
  const syncFromDrive = async () => {
    if (!isDriveConnected()) return;
    setDriveStatus("syncing");
    try {
      const rootId = await ensureRootFolder();
      const rootChildren = await listDriveChildren(rootId);
      const driveFolders = rootChildren.filter((f) => f.mimeType === "application/vnd.google-apps.folder");
      const rootDocs = rootChildren.filter((f) => f.mimeType === "application/vnd.google-apps.document");

      let nextFolders = [...latestLib.current.folders];
      const folderIdByDriveId = new Map(nextFolders.filter((f) => f.driveFolderId).map((f) => [f.driveFolderId, f.id]));
      for (const df of driveFolders) {
        if (!folderIdByDriveId.has(df.id)) {
          const localId = uid();
          nextFolders.push({ id: localId, name: df.name, collapsed: false, driveFolderId: df.id });
          folderIdByDriveId.set(df.id, localId);
        }
      }

      const allDriveDocs = rootDocs.map((d) => ({ ...d, localFolderId: null }));
      for (const df of driveFolders) {
        const localFolderId = folderIdByDriveId.get(df.id);
        const children = await listDriveChildren(df.id);
        allDriveDocs.push(...children.filter((c) => c.mimeType === "application/vnd.google-apps.document").map((d) => ({ ...d, localFolderId })));
      }

      let nextDocs = [...latestLib.current.docs];
      const docIdByDriveId = new Map(nextDocs.filter((d) => d.driveFileId).map((d) => [d.driveFileId, d.id]));
      let refreshedActive = false;

      for (const dd of allDriveDocs) {
        const driveModified = new Date(dd.modifiedTime).getTime();
        const localId = docIdByDriveId.get(dd.id);
        const localMeta = localId ? nextDocs.find((d) => d.id === localId) : null;
        if (localMeta && driveModified <= (localMeta.updatedAt || 0)) continue; // local is newer or same — keep it

        const html = await exportDriveDocHtml(dd.id);
        let mode = "prose";
        if (localId) {
          try {
            const res = await window.storage.get(`writer:doc:${localId}`);
            if (res) mode = JSON.parse(res.value).mode || "prose";
          } catch { /* default to prose */ }
        }
        const id = localId || uid();
        const entry = { id, title: dd.name, updatedAt: driveModified, words: countWordsHtml(html), folderId: dd.localFolderId, driveFileId: dd.id };
        nextDocs = localId ? nextDocs.map((d) => (d.id === id ? entry : d)) : [entry, ...nextDocs];
        await window.storage.set(`writer:doc:${id}`, JSON.stringify({ id, title: dd.name, body: html, format: "html", mode, folderId: dd.localFolderId, updatedAt: driveModified, driveFileId: dd.id }));
        if (id === activeId) refreshedActive = true;
      }

      await persistLib({ folders: nextFolders, docs: nextDocs });
      if (refreshedActive) await openDoc(activeId);
      else if (!activeId && nextDocs.length) await openDoc([...nextDocs].sort(byRecent)[0].id);
      setDriveStatus("connected");
    } catch (e) {
      setDriveStatus("error");
      setDriveError(e.message || String(e));
    }
  };

  const handleConnectDrive = async () => {
    setDriveStatus("connecting");
    setDriveError("");
    try {
      await connectDrive();
      await syncFromDrive();
      if (activeId) scheduleDriveSync(activeId, latest.current.html);
    } catch (e) {
      setDriveStatus("error");
      setDriveError(e.message || String(e));
    }
  };

  const handleDisconnectDrive = () => {
    clearTimeout(driveSyncTimer.current);
    disconnectDrive();
    setDriveStatus("disconnected");
    setDriveError("");
  };

  /* ——— caret geometry (contentEditable gives it to us directly) ——— */
  const getCaretRect = () => {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return null;
    const range = sel.getRangeAt(0).cloneRange();
    range.collapse(true);
    let rect = range.getBoundingClientRect();
    if (rect && rect.height > 0) return rect;
    /* empty line — fall back to its containing element */
    let node = range.startContainer;
    if (node.nodeType === 3) node = node.parentNode;
    if (node && node !== editorRef.current && node.getBoundingClientRect) {
      const r = node.getBoundingClientRect();
      return { left: r.left, top: r.top, height: r.height || 26 };
    }
    return null;
  };

  /* ——— typewriter platen: hold the line at the upper third ——— */
  const centerCaret = () => {
    const sc = scrollRef.current;
    const rect = getCaretRect();
    if (!sc || !rect) return;
    const scRect = sc.getBoundingClientRect();
    const caretY = rect.top - scRect.top + sc.scrollTop;
    const target = Math.max(0, caretY - sc.clientHeight * PLATEN);
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
    progScroll.current = true;
    setTimeout(() => { progScroll.current = false; }, 500);
    if (!reduced && Math.abs(sc.scrollTop - target) > 48) {
      sc.scrollTo({ top: target, behavior: "smooth" });
    } else {
      sc.scrollTop = target;
    }
  };
  const recenter = () => { if (focus) requestAnimationFrame(centerCaret); };

  /* THE content rule: React never touches the page. Content is written
     here, imperatively, exactly once per document load — so re-renders
     during typing have nothing they could reset the page with. */
  useEffect(() => {
    const ed = editorRef.current;
    if (ed && activeId != null && ed.innerHTML !== initialHtml.current) {
      ed.innerHTML = initialHtml.current;
    }
  }, [activeId, docNonce]);

  useEffect(() => {
    recenter();
    const t = setTimeout(() => recenter(), 380);
    return () => clearTimeout(t);
  }, [focus, activeId, mode]);

  /* ——— ink bloom: a faint warm glow where the letter just landed ——— */
  const inkBloom = () => {
    try {
      if (window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches) return;
      const bloom = bloomRef.current;
      const rect = getCaretRect();
      if (!bloom || !rect || !bloom.animate) return;
      bloom.style.left = `${rect.left - 17}px`;
      bloom.style.top = `${rect.top + (rect.height || 26) / 2 - 17}px`;
      bloom.animate(
        [
          { opacity: 0.85, transform: "scale(0.4)" },
          { opacity: 0, transform: "scale(1.6)" },
        ],
        { duration: 520, easing: "ease-out" }
      );
    } catch { /* decorative — never allowed to break typing */ }
  };

  /* ——— editing ——— */
  const normalizeFirstLine = (ed) => {
    /* Browsers leave the first line as a bare text node; wrap it in a
       div so the heading style applies. CRITICAL: never move the caret
       unless it was inside that exact text node — and then put it back
       at the same offset, not at the end. (Yanking it to the end was
       trapping the cursor inside the heading on every Enter.) */
    const first = ed.firstChild;
    if (!first || first.nodeType !== 3) return;
    const sel = window.getSelection();
    let offset = null;
    if (sel && sel.rangeCount) {
      const r = sel.getRangeAt(0);
      if (r.startContainer === first) offset = r.startOffset;
    }
    const div = document.createElement("div");
    ed.insertBefore(div, first);
    div.appendChild(first); // the selection elsewhere is untouched by this move
    if (offset !== null && sel) {
      const range = document.createRange();
      range.setStart(first, Math.min(offset, first.length));
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
    }
  };

  const onInput = () => {
    const ed = editorRef.current;
    if (!ed) return;
    normalizeFirstLine(ed);
    const html = ed.innerHTML;
    const text = ed.innerText || "";
    const w = countWordsText(text);
    const delta = w - prevWordCount.current;
    if (delta > 0) setSessionWords((s) => s + delta);
    prevWordCount.current = w;
    const added = text.length > prevLen.current;
    prevLen.current = text.length;
    setBodyHtml(html);
    setTitle(firstLineTitle(html));
    setIsEmpty(!text.trim());
    scheduleSave(html);
    setReviewing(false); // typing locks the platen back in
    recenter();
    if (added) requestAnimationFrame(inkBloom);
  };

  const exec = (cmd) => {
    editorRef.current?.focus();
    try { document.execCommand("styleWithCSS", false, false); } catch { /* older engines */ }
    document.execCommand(cmd, false, null);
    onInput();
  };

  const onEditorKeyDown = (e) => {
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey) {
      const k = e.key.toLowerCase();
      if (k === "b") { e.preventDefault(); exec("bold"); return; }
      if (k === "i") { e.preventDefault(); exec("italic"); return; }
    }
    if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "PageUp", "PageDown", "Home", "End"].includes(e.key)) {
      setReviewing(false);
      requestAnimationFrame(recenter);
    }
  };

  const onPaste = (e) => {
    /* paste as plain text — outside formatting never leaks in */
    e.preventDefault();
    const text = e.clipboardData?.getData("text/plain") || "";
    document.execCommand("insertText", false, text);
  };

  /* scrolling away = reading; the vignette lifts, centering pauses */
  const onUserScrollIntent = () => { if (focus) setReviewing(true); };
  const onScroll = () => { if (focus && !progScroll.current) setReviewing(true); };

  /* ——— draft actions ——— */
  const newDoc = async (folderId = null) => {
    const id = uid();
    const entry = { id, title: "Untitled", updatedAt: Date.now(), words: 0, folderId };
    initialHtml.current = "";
    setActiveId(id);
    setBodyHtml("");
    setTitle("Untitled");
    setMode("prose");
    setIsEmpty(true);
    setActiveDriveFileId(null);
    prevWordCount.current = 0;
    prevLen.current = 0;
    setDocNonce((n) => n + 1);
    setDocs((d) => [entry, ...d]);
    if (folderId) setFolders((f) => f.map((x) => (x.id === folderId ? { ...x, collapsed: false } : x)));
    await persist(id, "", "prose");
    setTimeout(() => editorRef.current?.focus(), 50);
  };

  const deleteDoc = async (id) => {
    setConfirmDelete(null);
    const doc = docs.find((d) => d.id === id);
    const nextDocs = docs.filter((d) => d.id !== id);
    await persistLib({ folders, docs: nextDocs });
    try { await window.storage.delete(`writer:doc:${id}`); } catch { /* reconciled later */ }
    if (isDriveConnected() && doc?.driveFileId) trashDriveFile(doc.driveFileId);
    if (id === activeId) {
      const next = [...nextDocs].sort(byRecent)[0];
      if (next) openDoc(next.id);
      else { setActiveId(null); setBodyHtml(""); setTitle(""); setActiveDriveFileId(null); }
    }
  };

  const moveDoc = async (docId, folderId) => {
    setMoveMenuFor(null);
    const doc = docs.find((d) => d.id === docId);
    const nextDocs = docs.map((d) => (d.id === docId ? { ...d, folderId } : d));
    const nextFolders = folderId
      ? folders.map((f) => (f.id === folderId ? { ...f, collapsed: false } : f))
      : folders;
    await persistLib({ folders: nextFolders, docs: nextDocs });
    setDropFlash(folderId || "loose");
    setTimeout(() => setDropFlash(null), 650);
    try {
      const res = await window.storage.get(`writer:doc:${docId}`);
      if (res) {
        const d = JSON.parse(res.value);
        await window.storage.set(`writer:doc:${docId}`, JSON.stringify({ ...d, folderId }));
      }
    } catch { /* index already carries the move */ }
    if (isDriveConnected() && doc?.driveFileId) {
      try {
        const oldFolder = folders.find((f) => f.id === doc.folderId);
        const newFolder = folders.find((f) => f.id === folderId);
        const newParent = await resolveDriveFolder(folderId, newFolder);
        const oldParent = oldFolder?.driveFolderId || (await ensureRootFolder());
        await moveDriveFile(doc.driveFileId, newParent, oldParent);
      } catch { /* best-effort — content sync will still find it */ }
    }
  };

  /* ——— folder actions ——— */
  const createFolder = async () => {
    const name = newFolderName.trim();
    if (!name) { setNewFolderOpen(false); setNewFolderName(""); return; }
    setNewFolderOpen(false);
    setNewFolderName("");
    await persistLib({ folders: [...folders, { id: uid(), name, collapsed: false }], docs });
  };
  const toggleFolder = (id) => {
    persistLib({ folders: folders.map((f) => (f.id === id ? { ...f, collapsed: !f.collapsed } : f)), docs });
  };
  const renameFolder = async (id) => {
    const name = renameValue.trim();
    setRenamingFolder(null);
    if (!name) return;
    const folder = folders.find((f) => f.id === id);
    await persistLib({ folders: folders.map((f) => (f.id === id ? { ...f, name } : f)), docs });
    if (isDriveConnected() && folder?.driveFolderId) renameDriveFile(folder.driveFolderId, name).catch(() => {});
  };
  const dissolveFolder = async (id) => {
    setConfirmDissolve(null);
    const folder = folders.find((f) => f.id === id);
    const affected = docs.filter((d) => d.folderId === id && d.driveFileId);
    const nextDocs = docs.map((d) => (d.folderId === id ? { ...d, folderId: null } : d));
    await persistLib({ folders: folders.filter((f) => f.id !== id), docs: nextDocs });
    if (isDriveConnected() && folder?.driveFolderId) {
      try {
        const rootId = await ensureRootFolder();
        for (const d of affected) await moveDriveFile(d.driveFileId, rootId, folder.driveFolderId);
        await trashDriveFile(folder.driveFolderId);
      } catch { /* best-effort */ }
    }
  };

  /* ——— prefs / goal ——— */
  const savePrefs = async (patch) => {
    prefsRef.current = { ...prefsRef.current, ...patch };
    try { await window.storage.set("writer:prefs", JSON.stringify(prefsRef.current)); } catch { /* memory only */ }
  };
  const saveGoal = (g) => { setGoal(g); setGoalEditing(false); savePrefs({ goal: g }); };

  /* ——— backup & restore (the Google Drive bridge) ——— */
  const [backupBusy, setBackupBusy] = useState(false);
  const restoreInputRef = useRef(null);

  const backupAll = async () => {
    setBackupBusy(true);
    try {
      if (activeId) await persist(activeId, latest.current.html, mode);
      const fullDocs = [];
      for (const meta of latestLib.current.docs) {
        try {
          const res = await window.storage.get(`writer:doc:${meta.id}`);
          if (res) fullDocs.push(JSON.parse(res.value));
        } catch { /* skip unreadable, export the rest */ }
      }
      const payload = {
        app: "sample-typer", version: 3, exportedAt: new Date().toISOString(),
        folders: latestLib.current.folders, docs: fullDocs,
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `sample-typer-backup-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      const now = Date.now();
      setLastBackupAt(now);
      savePrefs({ lastBackupAt: now });
    } finally {
      setBackupBusy(false);
    }
  };

  const restoreBackup = async (file) => {
    if (!file) return;
    setBackupBusy(true);
    try {
      const data = JSON.parse(await file.text());
      if (data.app !== "sample-typer" || !Array.isArray(data.docs)) return;
      const folderMap = new Map(folders.map((f) => [f.id, f]));
      (data.folders || []).forEach((f) => { if (!folderMap.has(f.id)) folderMap.set(f.id, f); });
      const docMap = new Map(docs.map((d) => [d.id, d]));
      for (const doc of data.docs) {
        const local = docMap.get(doc.id);
        if (!local || (doc.updatedAt || 0) > (local.updatedAt || 0)) {
          await window.storage.set(`writer:doc:${doc.id}`, JSON.stringify(doc));
          const words = looksLikeHtml(doc.body) ? countWordsHtml(doc.body) : countWordsText(doc.body || "");
          docMap.set(doc.id, { id: doc.id, title: doc.title, updatedAt: doc.updatedAt, words, folderId: doc.folderId ?? null });
        }
      }
      await persistLib({ folders: [...folderMap.values()], docs: [...docMap.values()] });
      if (activeId && docMap.has(activeId)) openDoc(activeId);
      else if (!activeId && docMap.size) openDoc([...docMap.values()].sort(byRecent)[0].id);
    } catch { /* unreadable file — library untouched */ }
    finally {
      setBackupBusy(false);
      if (restoreInputRef.current) restoreInputRef.current.value = "";
    }
  };

  /* ——— global keyboard ——— */
  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") { e.preventDefault(); saveNow(); }
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "f") { e.preventDefault(); setFocus((f) => !f); }
      if (e.key === "Escape" && focus) setFocus(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  useEffect(() => { if (focus) { setSidebarOpen(false); setReviewing(false); } }, [focus]);

  /* ——— drag & drop zone helpers ——— */
  const dropZoneStyle = (zoneId) => ({
    outline: dragOver === zoneId ? `1.5px dashed ${T.accent}` : "1.5px dashed transparent",
    outlineOffset: -1,
    background: dropFlash === zoneId ? T.accentGlow : dragOver === zoneId ? T.accentSoft : "transparent",
    borderRadius: 8,
    transition: "background .3s ease",
  });
  const zoneHandlers = (zoneId, folderId) => ({
    onDragOver: (e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; setDragOver(zoneId); },
    onDragLeave: (e) => { if (!e.currentTarget.contains(e.relatedTarget)) setDragOver((z) => (z === zoneId ? null : z)); },
    onDrop: (e) => {
      e.preventDefault();
      setDragOver(null);
      const id = e.dataTransfer.getData("text/plain") || draggingId;
      if (id) {
        const d = docs.find((x) => x.id === id);
        if (d && (d.folderId ?? null) !== folderId) moveDoc(id, folderId);
      }
      setDraggingId(null);
    },
  });

  const plainText = htmlToText(bodyHtml);
  const words = countWordsText(plainText);
  const statusInfo = {
    idle:    { dot: T.inkFaint, label: "" },
    dirty:   { dot: T.warn,     label: "typing…" },
    saving:  { dot: T.warn,     label: "saving…" },
    saved:   { dot: T.good,     label: "saved" },
    offline: { dot: T.accent,   label: "offline — retrying" },
  }[status];

  const looseDocs = docs.filter((d) => !d.folderId || !folders.some((f) => f.id === d.folderId)).sort(byRecent);
  const chromeOpacity = focus && !chromeHover ? 0.06 : 1;
  const activeFolder = folders.find((f) => f.id === docs.find((d) => d.id === activeId)?.folderId);

  /* ——— one draft row ——— */
  const DocRow = ({ d, indent }) => (
    <div style={{ position: "relative" }}>
      <div
        className="st-row"
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData("text/plain", d.id);
          e.dataTransfer.effectAllowed = "move";
          setDraggingId(d.id);
          setMoveMenuFor(null);
          setConfirmDelete(null);
        }}
        onDragEnd={() => { setDraggingId(null); setDragOver(null); }}
        onClick={() => d.id !== activeId && openDoc(d.id)}
        title="Drag onto a folder to file this draft"
        style={{
          padding: "8px 10px", paddingLeft: indent ? 24 : 10,
          borderRadius: 8, marginBottom: 1,
          cursor: draggingId === d.id ? "grabbing" : "pointer",
          opacity: draggingId === d.id ? 0.35 : 1,
          transform: draggingId === d.id ? "scale(.98)" : "none",
          transition: "opacity .15s, transform .15s, background .15s",
          background: d.id === activeId ? T.accentSoft : undefined,
          borderLeft: d.id === activeId ? `2px solid ${T.accent}` : "2px solid transparent",
        }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center" }}>
          <span style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
            <span aria-hidden style={{ color: T.inkFaint, fontSize: 10, cursor: "grab", letterSpacing: "-1px", flexShrink: 0 }}>⠿</span>
            <span style={{
              fontSize: 13.5, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
              color: d.id === activeId ? T.ink : T.inkDim, fontWeight: d.id === activeId ? 500 : 400,
            }}>
              {d.title || "Untitled"}
            </span>
          </span>
          {confirmDelete === d.id ? (
            <span style={{ fontSize: 11, flexShrink: 0 }}>
              <button onClick={(e) => { e.stopPropagation(); deleteDoc(d.id); }}
                style={{ background: "none", border: "none", color: T.accent, cursor: "pointer", fontSize: 11, padding: 0, marginRight: 6 }}>
                delete
              </button>
              <button onClick={(e) => { e.stopPropagation(); setConfirmDelete(null); }}
                style={{ background: "none", border: "none", color: T.inkFaint, cursor: "pointer", fontSize: 11, padding: 0 }}>
                keep
              </button>
            </span>
          ) : (
            <span style={{ display: "flex", gap: 6, flexShrink: 0 }}>
              <button className="st-icon"
                onClick={(e) => { e.stopPropagation(); setMoveMenuFor(moveMenuFor === d.id ? null : d.id); setConfirmDelete(null); }}
                title="Move to folder (no-drag alternative)"
                style={{ fontSize: 11 }}>
                ⇥
              </button>
              <button className="st-icon" onClick={(e) => { e.stopPropagation(); setConfirmDelete(d.id); setMoveMenuFor(null); }}
                title="Delete draft"
                style={{ fontSize: 13 }}>
                ×
              </button>
            </span>
          )}
        </div>
        <div style={{ fontSize: 11, color: T.inkFaint, marginTop: 2, paddingLeft: 16 }}>
          {d.words || 0} words · {timeAgo(d.updatedAt)}
        </div>
      </div>

      {moveMenuFor === d.id && (
        <div style={{
          position: "absolute", right: 8, top: 30, zIndex: 10,
          background: T.bgDeep, border: `1px solid ${T.edge}`, borderRadius: 8,
          padding: 4, minWidth: 150, boxShadow: "0 8px 24px rgba(0,0,0,.5)",
        }}>
          <div style={{ fontSize: 10.5, color: T.inkFaint, padding: "4px 8px", letterSpacing: ".06em", textTransform: "uppercase" }}>
            Move to
          </div>
          {d.folderId && (
            <button onClick={() => moveDoc(d.id, null)}
              style={{ display: "block", width: "100%", textAlign: "left", background: "none", border: "none", color: T.inkDim, fontSize: 12.5, padding: "6px 8px", cursor: "pointer", borderRadius: 5 }}>
              Loose pages
            </button>
          )}
          {folders.filter((f) => f.id !== d.folderId).map((f) => (
            <button key={f.id} onClick={() => moveDoc(d.id, f.id)}
              style={{ display: "block", width: "100%", textAlign: "left", background: "none", border: "none", color: T.ink, fontSize: 12.5, padding: "6px 8px", cursor: "pointer", borderRadius: 5 }}>
              {f.name}
            </button>
          ))}
          {folders.filter((f) => f.id !== d.folderId).length === 0 && !d.folderId && (
            <div style={{ color: T.inkFaint, fontSize: 12, padding: "6px 8px", fontStyle: "italic", fontFamily: SERIF }}>
              No folders yet
            </div>
          )}
        </div>
      )}
    </div>
  );

  if (loading) {
    return (
      <div style={{ minHeight: "100vh", background: T.bg, display: "grid", placeItems: "center", fontFamily: SERIF, color: T.inkDim, fontStyle: "italic" }}>
        opening the notebook…
      </div>
    );
  }

  const editorPadTop = focus ? "33vh" : "64px";
  const editorPadBottom = focus ? "62vh" : "140px";

  return (
    <div
      style={{
        height: "100vh",
        overflow: "hidden", /* the window never scrolls — only the page inside does */
        background: `radial-gradient(1400px 900px at 72% -12%, #1E1915 0%, ${T.bg} 55%, ${T.bgDeep} 100%)`,
        color: T.ink, display: "flex", fontFamily: UI, position: "relative",
      }}
      onClick={() => moveMenuFor && setMoveMenuFor(null)}>

      {/* ——— texture & behavior, kept to a whisper ——— */}
      <style>{`
        @keyframes inkPageIn {
          from { opacity: 0; transform: translateY(6px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        .ink-page { animation: inkPageIn .4s ease both; }
        @keyframes inkBreathe {
          0%, 100% { opacity: 1; }
          50%      { opacity: .35; }
        }
        .ink-dot-busy { animation: inkBreathe 1.4s ease-in-out infinite; }
        @media (prefers-reduced-motion: reduce) {
          .ink-page { animation: none; }
          .ink-dot-busy { animation: none; }
        }
        /* quiet buttons — invisible at rest, warm on approach */
        .st-ghost {
          background: transparent; border: none; color: ${T.inkFaint};
          border-radius: 6px; padding: 4px 9px; font-size: 11.5px;
          cursor: pointer; font-family: ${UI};
          transition: color .15s ease, background .15s ease;
        }
        .st-ghost:hover { color: ${T.accent}; background: ${T.accentSoft}; }
        .st-ghost:disabled { color: ${T.inkFaint}; cursor: wait; background: transparent; }
        .st-icon {
          background: none; border: none; color: ${T.inkFaint};
          cursor: pointer; padding: 0; line-height: 1;
          transition: color .15s ease;
        }
        .st-icon:hover { color: ${T.accent}; }
        .st-row:hover { background: ${T.rowHover}; }
        /* the page's scrollbar: gone, unless your cursor asks for it */
        .st-scroll { scrollbar-width: none; }
        .st-scroll::-webkit-scrollbar { width: 3px; }
        .st-scroll::-webkit-scrollbar-track { background: transparent; }
        .st-scroll::-webkit-scrollbar-thumb { background: transparent; border-radius: 3px; }
        .st-scroll:hover { scrollbar-width: thin; scrollbar-color: rgba(233,226,212,.12) transparent; }
        .st-scroll:hover::-webkit-scrollbar-thumb { background: rgba(233,226,212,.12); }
        /* sidebar scroll: same treatment */
        .st-side-scroll { scrollbar-width: none; }
        .st-side-scroll::-webkit-scrollbar { width: 0; }
        /* the page itself */
        .st-editor {
          outline: none; caret-color: ${T.accent};
          /* pre-wrap: the browser preserves trailing spaces natively, so it
             types REAL spaces instead of non-breaking ones — lines wrap.
             break-word: even an unbroken mega-string folds at the page edge. */
          white-space: pre-wrap;
          overflow-wrap: break-word;
          word-wrap: break-word;
        }
        .st-editor > div { min-height: 1.2em; }
        .st-editor > :first-child {
          font-size: 1.5em; font-weight: 650; letter-spacing: -0.012em;
          color: ${T.inkBright}; margin-bottom: 0.45em; line-height: 1.3;
        }
        .st-editor b, .st-editor strong { font-weight: 700; color: ${T.inkBright}; }
        .st-editor i, .st-editor em { font-style: italic; }
        .st-editor ::selection { background: ${T.accentGlow}; }
      `}</style>

      {/* paper grain — a faint tooth over the whole surface */}
      <div aria-hidden style={{
        position: "fixed", inset: 0, pointerEvents: "none", zIndex: 50,
        opacity: 0.05, mixBlendMode: "overlay",
        backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='180' height='180'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='180' height='180' filter='url(%23n)'/%3E%3C/svg%3E")`,
      }} />

      {/* focus vignette — lifts while you scroll back to re-read,
          returns the moment you type */}
      <div aria-hidden style={{
        position: "fixed", inset: 0, pointerEvents: "none", zIndex: 40,
        background: "radial-gradient(ellipse 72% 58% at 50% 38%, transparent 55%, rgba(10,7,5,0.5) 100%)",
        opacity: focus && !reviewing ? 1 : 0, transition: "opacity .7s ease",
      }} />

      {/* the ink bloom — repositioned and re-lit on every keystroke */}
      <div ref={bloomRef} aria-hidden style={{
        position: "fixed", width: 34, height: 34, borderRadius: "50%",
        background: `radial-gradient(circle, rgba(199,123,82,0.55) 0%, rgba(199,123,82,0.20) 40%, transparent 70%)`,
        pointerEvents: "none", zIndex: 45, opacity: 0,
      }} />

      {/* ———— sidebar ———— */}
      <aside style={{
        width: sidebarOpen ? 284 : 0,
        transition: "width .25s ease",
        overflow: "hidden",
        borderRight: sidebarOpen ? `1px solid ${T.edgeSoft}` : "none",
        background: `linear-gradient(180deg, ${T.panel} 0%, #1A1613 100%)`,
        display: "flex", flexDirection: "column", flexShrink: 0,
      }}>
        <div style={{ padding: "20px 16px 16px", display: "flex", flexDirection: "column", gap: 12, minWidth: 284 }}>
          <span style={{ fontFamily: SERIF, fontSize: 18, letterSpacing: ".02em", whiteSpace: "nowrap" }}>
            Sample <span style={{ color: T.accent }}>Typer</span>
          </span>
          <span style={{ display: "flex", gap: 8 }}>
            <button className="st-ghost"
              onClick={() => { setNewFolderOpen(true); setTimeout(() => document.getElementById("nf-input")?.focus(), 30); }}
              title="New folder"
              style={{ border: `1px solid ${T.edgeSoft}`, padding: "6px 12px" }}>
              + folder
            </button>
            <button className="st-ghost" onClick={() => newDoc(null)} title="New draft"
              style={{ border: `1px solid ${T.edgeSoft}`, padding: "6px 12px" }}>
              + draft
            </button>
          </span>
        </div>

        <div className="st-side-scroll" style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "4px 8px 16px", minWidth: 284 }}>

          {newFolderOpen && (
            <div style={{ padding: "4px 6px 10px" }}>
              <input
                id="nf-input"
                value={newFolderName}
                onChange={(e) => setNewFolderName(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") createFolder(); if (e.key === "Escape") { setNewFolderOpen(false); setNewFolderName(""); } }}
                onBlur={createFolder}
                placeholder="Folder name…"
                style={{
                  width: "100%", boxSizing: "border-box", background: T.bgDeep, color: T.ink,
                  border: `1px solid ${T.accent}`, borderRadius: 6, padding: "6px 9px",
                  fontSize: 13, outline: "none", fontFamily: UI,
                }}
              />
            </div>
          )}

          {folders.map((f) => {
            const inside = docs.filter((d) => d.folderId === f.id).sort(byRecent);
            return (
              <div key={f.id} {...zoneHandlers(f.id, f.id)} style={{ marginBottom: 4, ...dropZoneStyle(f.id) }}>
                <div style={{ display: "flex", alignItems: "center", gap: 4, padding: "6px 6px 4px" }}>
                  <button className="st-icon" onClick={() => toggleFolder(f.id)}
                    style={{ fontSize: 10, width: 12 }}>
                    {f.collapsed ? "▸" : "▾"}
                  </button>
                  {renamingFolder === f.id ? (
                    <input
                      autoFocus
                      value={renameValue}
                      onChange={(e) => setRenameValue(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") renameFolder(f.id); if (e.key === "Escape") setRenamingFolder(null); }}
                      onBlur={() => renameFolder(f.id)}
                      style={{ flex: 1, minWidth: 0, background: T.bgDeep, color: T.ink, border: `1px solid ${T.accent}`, borderRadius: 5, padding: "2px 6px", fontSize: 12, outline: "none", fontFamily: UI }}
                    />
                  ) : (
                    <span
                      onClick={() => toggleFolder(f.id)}
                      onDoubleClick={() => { setRenamingFolder(f.id); setRenameValue(f.name); }}
                      title="Double-click to rename · drop a draft here to file it"
                      style={{
                        flex: 1, minWidth: 0, fontSize: 11.5, letterSpacing: ".07em", textTransform: "uppercase",
                        color: dragOver === f.id ? T.accent : T.inkDim,
                        cursor: "pointer", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                        fontWeight: 600, transition: "color .15s",
                      }}>
                      {f.name} <span style={{ color: T.inkFaint, fontWeight: 400 }}>· {inside.length}</span>
                    </span>
                  )}
                  {confirmDissolve === f.id ? (
                    <span style={{ fontSize: 10.5, flexShrink: 0 }}>
                      <button onClick={() => dissolveFolder(f.id)}
                        style={{ background: "none", border: "none", color: T.accent, cursor: "pointer", fontSize: 10.5, padding: 0, marginRight: 5 }}>
                        dissolve
                      </button>
                      <button onClick={() => setConfirmDissolve(null)}
                        style={{ background: "none", border: "none", color: T.inkFaint, cursor: "pointer", fontSize: 10.5, padding: 0 }}>
                        keep
                      </button>
                    </span>
                  ) : (
                    <span style={{ display: "flex", gap: 5, flexShrink: 0 }}>
                      <button className="st-icon" onClick={() => newDoc(f.id)} title={`New draft in ${f.name}`}
                        style={{ fontSize: 13 }}>
                        +
                      </button>
                      <button className="st-icon" onClick={() => setConfirmDissolve(f.id)} title="Dissolve folder (drafts are kept)"
                        style={{ fontSize: 12 }}>
                        ×
                      </button>
                    </span>
                  )}
                </div>
                {!f.collapsed && inside.map((d) => <DocRow key={d.id} d={d} indent />)}
                {!f.collapsed && inside.length === 0 && (
                  <div style={{ paddingLeft: 24, fontSize: 12, color: T.inkFaint, fontStyle: "italic", fontFamily: SERIF, paddingBottom: 6 }}>
                    {dragOver === f.id ? "release to file it here" : "empty — drop a draft here"}
                  </div>
                )}
              </div>
            );
          })}

          {(looseDocs.length > 0 || folders.length > 0) && (
            <div {...zoneHandlers("loose", null)} style={{ ...dropZoneStyle("loose"), paddingBottom: 4 }}>
              <div style={{
                padding: "8px 6px 4px", fontSize: 11.5, letterSpacing: ".07em", textTransform: "uppercase",
                color: dragOver === "loose" ? T.accent : T.inkFaint, fontWeight: 600, transition: "color .15s",
              }}>
                Loose pages <span style={{ fontWeight: 400 }}>· {looseDocs.length}</span>
              </div>
              {looseDocs.map((d) => <DocRow key={d.id} d={d} />)}
              {looseDocs.length === 0 && (
                <div style={{ paddingLeft: 10, fontSize: 12, color: T.inkFaint, fontStyle: "italic", fontFamily: SERIF, paddingBottom: 6 }}>
                  {dragOver === "loose" ? "release to un-file it" : "drop a draft here to un-file it"}
                </div>
              )}
            </div>
          )}

          {docs.length === 0 && !newFolderOpen && (
            <p style={{ color: T.inkFaint, fontSize: 13, padding: "12px 10px", fontStyle: "italic", fontFamily: SERIF }}>
              Nothing here yet. Start your first draft.
            </p>
          )}
        </div>

        <div style={{ padding: "10px 14px", borderTop: `1px solid ${T.edgeSoft}`, minWidth: 284 }}>

          {driveConfigured() ? (
            <div style={{ marginBottom: 9 }}>
              {driveStatus === "connected" || driveStatus === "syncing" ? (
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <span style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: T.inkDim }}>
                    <span
                      className={driveStatus === "syncing" ? "ink-dot-busy" : ""}
                      style={{ width: 6, height: 6, borderRadius: "50%", background: driveStatus === "syncing" ? T.warn : T.good }} />
                    {driveStatus === "syncing" ? "Syncing to Drive…" : "Synced to Google Drive"}
                  </span>
                  <span style={{ display: "flex", gap: 4 }}>
                    <button className="st-ghost" onClick={syncFromDrive} disabled={driveStatus === "syncing"} title="Pull in anything new from Drive" style={{ fontSize: 10.5 }}>
                      resync
                    </button>
                    <button className="st-ghost" onClick={handleDisconnectDrive} style={{ fontSize: 10.5 }}>
                      disconnect
                    </button>
                  </span>
                </div>
              ) : (
                <button className="st-ghost" onClick={handleConnectDrive} disabled={driveStatus === "connecting"}
                  title="Sign in with Google — drafts sync live as native Google Docs, scoped to files this app creates"
                  style={{ width: "100%", border: `1px solid ${T.edgeSoft}` }}>
                  {driveStatus === "connecting" ? "Connecting…" : driveStatus === "error" ? "Retry Google Drive connection" : "Connect Google Drive"}
                </button>
              )}
              {driveStatus === "error" && driveError && (
                <div style={{ fontSize: 10, color: T.accent, marginTop: 4, lineHeight: 1.4 }}>{driveError}</div>
              )}
            </div>
          ) : (
            <div style={{ fontSize: 10.5, color: T.inkFaint, fontStyle: "italic", marginBottom: 9, lineHeight: 1.5 }}>
              Drive sync needs a Google Client ID — see DRIVE_SETUP.md.
            </div>
          )}

          <div style={{ display: "flex", gap: 4, marginBottom: 7 }}>
            <button className="st-ghost" onClick={backupAll} disabled={backupBusy}
              title="Download the whole library as one .json — a portable local snapshot"
              style={{ flex: 1, border: `1px solid ${T.edgeSoft}` }}>
              {backupBusy ? "Working…" : "Backup all"}
            </button>
            <button className="st-ghost" onClick={() => restoreInputRef.current?.click()} disabled={backupBusy}
              title="Merge a backup file back in — newer drafts win, nothing is deleted"
              style={{ flex: 1, border: `1px solid ${T.edgeSoft}` }}>
              Restore
            </button>
            <input ref={restoreInputRef} type="file" accept=".json,application/json"
              onChange={(e) => restoreBackup(e.target.files?.[0])} style={{ display: "none" }} />
          </div>
          <div style={{ fontSize: 10.5, color: T.inkFaint, lineHeight: 1.5 }}>
            Autosaves to your Claude account as you type.
            {lastBackupAt ? ` Last manual backup ${timeAgo(lastBackupAt)}.` : " No manual backup yet."}
          </div>
        </div>
      </aside>

      {/* ———— main ———— */}
      <main style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0, minHeight: 0 }}>

        {/* top bar — fades in focus mode, hover to reveal */}
        <div
          onMouseEnter={() => setChromeHover(true)}
          onMouseLeave={() => setChromeHover(false)}
          style={{
            display: "flex", alignItems: "center", gap: 10, padding: "12px 20px",
            borderBottom: `1px solid ${T.edgeSoft}`,
            opacity: chromeOpacity, transition: "opacity .35s ease",
          }}>
          <button className="st-ghost" onClick={() => { setSidebarOpen((v) => !v); if (focus) setFocus(false); }}
            title={sidebarOpen ? "Hide library" : "Show library"}
            style={{ border: `1px solid ${T.edgeSoft}`, width: 28, height: 28, padding: 0, fontSize: 13 }}>
            {sidebarOpen ? "‹" : "›"}
          </button>

          {activeId && (
            <>
              {/* breadcrumb — the title lives in line one of the page now */}
              <span style={{
                flex: 1, minWidth: 0, fontFamily: SERIF, fontSize: 14.5, color: T.inkDim,
                whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
              }}
                title="Rename by editing the first line of the page">
                {activeFolder ? <span style={{ color: T.inkFaint }}>{activeFolder.name} · </span> : null}
                {title || "Untitled"}
              </span>

              {/* formatting */}
              <span style={{ display: "flex", gap: 2, flexShrink: 0 }}>
                <button className="st-ghost" title="Bold (⌘B / Ctrl+B)"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => exec("bold")}
                  style={{ fontWeight: 700, fontFamily: SERIF, fontSize: 13, width: 28, padding: "4px 0" }}>
                  B
                </button>
                <button className="st-ghost" title="Italic (⌘I / Ctrl+I)"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => exec("italic")}
                  style={{ fontStyle: "italic", fontFamily: SERIF, fontSize: 13, width: 28, padding: "4px 0" }}>
                  I
                </button>
              </span>

              <div style={{ display: "flex", border: `1px solid ${T.edgeSoft}`, borderRadius: 6, overflow: "hidden", flexShrink: 0 }}>
                {["prose", "screenplay"].map((m) => (
                  <button key={m}
                    onClick={() => { setMode(m); scheduleSave(bodyHtml, m); }}
                    style={{
                      background: mode === m ? T.accentSoft : "transparent",
                      color: mode === m ? T.accent : T.inkFaint,
                      border: "none", padding: "5px 10px", fontSize: 11.5, cursor: "pointer",
                      fontFamily: m === "screenplay" ? MONO : SERIF,
                      transition: "color .15s, background .15s",
                    }}>
                    {m === "prose" ? "Prose" : "Script"}
                  </button>
                ))}
              </div>

              <button className="st-ghost" onClick={() => setFocus((f) => !f)}
                title="Focus mode — everything but the page fades away (⌘⇧F, Esc to exit)"
                style={{
                  border: `1px solid ${focus ? T.accent : T.edgeSoft}`,
                  color: focus ? T.accent : undefined,
                  background: focus ? T.accentSoft : undefined,
                }}>
                Focus
              </button>

              <button className="st-ghost"
                onClick={() => {
                  const text = `${htmlToText(bodyHtml)}`;
                  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement("a");
                  a.href = url;
                  a.download = `${(title || "untitled").replace(/[^\w\- ]+/g, "").trim() || "untitled"}.txt`;
                  a.click();
                  URL.revokeObjectURL(url);
                }}
                title="Download this page as .txt"
                style={{ border: `1px solid ${T.edgeSoft}` }}>
                Export
              </button>

              {activeDriveFileId && (
                <a href={`https://docs.google.com/document/d/${activeDriveFileId}/edit`}
                  target="_blank" rel="noreferrer"
                  className="st-ghost"
                  title="Open this draft in Google Docs"
                  style={{ border: `1px solid ${T.edgeSoft}`, textDecoration: "none", display: "inline-flex", alignItems: "center" }}>
                  Docs ↗
                </a>
              )}

              <span title="Autosave status" style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11.5, color: T.inkDim, minWidth: 88, justifyContent: "flex-end", flexShrink: 0 }}>
                <span
                  className={["dirty", "saving", "offline"].includes(status) ? "ink-dot-busy" : ""}
                  style={{ width: 7, height: 7, borderRadius: "50%", background: statusInfo.dot, transition: "background .3s" }} />
                {statusInfo.label}
              </span>
            </>
          )}
        </div>

        {/* editor */}
        {activeId ? (
          <div
            ref={scrollRef}
            className="st-scroll"
            onWheel={onUserScrollIntent}
            onTouchMove={onUserScrollIntent}
            onScroll={onScroll}
            style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
            <div style={{ position: "relative", width: "100%", maxWidth: mode === "screenplay" ? 780 : 700, margin: "0 auto" }}>
              {isEmpty && (
                <div aria-hidden style={{
                  position: "absolute", left: 36, top: editorPadTop, pointerEvents: "none",
                  color: T.inkFaint, fontFamily: mode === "screenplay" ? MONO : SERIF,
                  fontSize: mode === "screenplay" ? "1.4em" : "1.6em", fontWeight: 600,
                  transition: "top .3s ease",
                }}>
                  {mode === "screenplay" ? "FADE IN:" : "Title your page…"}
                </div>
              )}
              <div
                key={`${activeId}:${docNonce}`}
                ref={editorRef}
                className="st-editor ink-page"
                contentEditable
                spellCheck
                onInput={onInput}
                onKeyDown={onEditorKeyDown}
                onPaste={onPaste}
                onBlur={saveNow}
                onClick={() => { setReviewing(false); recenter(); }}
                style={{
                  boxSizing: "border-box",
                  padding: `${editorPadTop} 36px ${editorPadBottom}`,
                  color: T.ink,
                  fontFamily: mode === "screenplay" ? MONO : SERIF,
                  fontSize: (mode === "screenplay" ? 15.5 : 18) + (focus ? 1 : 0),
                  lineHeight: mode === "screenplay" ? 1.65 : 1.8,
                  transition: "padding .3s ease, font-size .3s ease",
                }}
              />
            </div>
          </div>
        ) : (
          <div style={{ flex: 1, display: "grid", placeItems: "center" }}>
            <div style={{ textAlign: "center", fontFamily: SERIF }}>
              <p style={{ color: T.inkDim, fontSize: 18, fontStyle: "italic", marginBottom: 18 }}>
                A blank page — the good kind.
              </p>
              <button onClick={() => newDoc(null)}
                style={{ background: T.accent, color: T.bgDeep, border: "none", borderRadius: 8, padding: "10px 22px", fontSize: 14.5, cursor: "pointer", fontFamily: UI }}>
                Start a draft
              </button>
            </div>
          </div>
        )}

        {/* footer strip */}
        {activeId && (
          <div
            onMouseEnter={() => setChromeHover(true)}
            onMouseLeave={() => setChromeHover(false)}
            style={{ opacity: chromeOpacity, transition: "opacity .35s ease" }}>
            {goal && (
              <div style={{ height: 2, background: T.edgeSoft }}>
                <div style={{
                  height: "100%", background: sessionWords >= goal ? T.good : T.accent,
                  width: `${Math.min(100, (sessionWords / goal) * 100)}%`,
                  transition: "width .4s ease, background .4s",
                }} />
              </div>
            )}
            <div style={{
              display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 20px",
              borderTop: goal ? "none" : `1px solid ${T.edgeSoft}`, fontSize: 11.5, color: T.inkFaint,
            }}>
              <span>{words.toLocaleString()} words · {plainText.length.toLocaleString()} characters</span>
              {goalEditing ? (
                <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <input
                    autoFocus
                    value={goalInput}
                    onChange={(e) => setGoalInput(e.target.value.replace(/\D/g, ""))}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") saveGoal(parseInt(goalInput, 10) || null);
                      if (e.key === "Escape") setGoalEditing(false);
                    }}
                    onBlur={() => saveGoal(parseInt(goalInput, 10) || null)}
                    placeholder="e.g. 500"
                    style={{ width: 70, background: T.panel, color: T.ink, border: `1px solid ${T.accent}`, borderRadius: 5, padding: "3px 7px", fontSize: 11.5, outline: "none", fontFamily: UI }}
                  />
                  <span>words per sitting (blank to clear)</span>
                </span>
              ) : (
                <button
                  onClick={() => { setGoalEditing(true); setGoalInput(goal ? String(goal) : ""); }}
                  title="Set a session word goal"
                  style={{ background: "none", border: "none", color: goal && sessionWords >= goal ? T.good : T.inkFaint, cursor: "pointer", fontSize: 11.5, padding: 0, fontFamily: UI }}>
                  {goal
                    ? `session: ${sessionWords.toLocaleString()} / ${goal.toLocaleString()}${sessionWords >= goal ? " — done ✓" : ""}`
                    : `session: ${sessionWords.toLocaleString()} words · set a goal`}
                </button>
              )}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
