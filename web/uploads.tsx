import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "@base-ui/react/button";
import { isPrivateSource, UPLOAD_LIMIT, uploadAccept, uploadStateLabels, uploadTypes, type PrivateSource, type PrivateSourceDetail } from "../src/shared/uploads";

const STORAGE_KEY = "memory-bank.uploads.v1";
interface UploadLibrary {
  sources: PrivateSource[];
  token: string | null;
  error: string | null;
  uploading: string | null;
  focusedId: string | null;
  setFocusedId: (id: string | null) => void;
  refresh: () => Promise<void>;
  upload: (files: File[]) => Promise<void>;
  process: (id: string) => Promise<void>;
  detail: (id: string, signal?: AbortSignal) => Promise<PrivateSourceDetail>;
  download: (source: PrivateSource, open?: boolean) => Promise<void>;
  update: (id: string, changes: { caseId?: string | null; notes?: string; previousNotes?: string }) => Promise<void>;
  remove: (id: string) => Promise<void>;
}
const UploadContext = createContext<UploadLibrary | null>(null);

function readToken(): string | null {
  const token = window.localStorage.getItem(STORAGE_KEY);
  if (token === null) return null;
  if (!/^[A-Za-z0-9_-]{43}$/u.test(token)) throw new Error("Private upload access in browser storage is invalid. Do not clear storage if you need existing uploads; use another browser profile for a new library.");
  return token;
}

async function uploadResponse(response: Response): Promise<unknown> {
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const reasons: Record<string, string> = {
      UPLOAD_TOO_LARGE: "The file exceeds 10 MiB.", UPLOAD_LIBRARY_FULL: "This browser has 20 retained files. Delete an unneeded file or wait for its seven-day expiry.",
      UPLOAD_TYPE_NOT_SUPPORTED: "Choose DOCX, PDF, PPTX, XLSX, an image, UTF-8 Markdown, plain text, or CSV.",
      UPLOAD_FORMAT_MISMATCH: "The file content does not match its extension.", UPLOAD_UTF8_REQUIRED: "Text and CSV files must use UTF-8 without binary content.",
      UPLOAD_RATE_LIMITED: "The upload request limit was reached. Wait a minute before trying again.",
      UPLOAD_PROCESSING: "This file is already processing. Its status will refresh automatically.",
      UPLOAD_NOT_FOUND: "This private upload is missing, expired, or belongs to another browser.",
      UPLOAD_CHANGED: "This source changed in another request. Refresh and try again.",
      CASE_NOT_FOUND: "That case is no longer available. Refresh the source library.",
    };
    const code = body && typeof body === "object" && "error" in body && typeof body.error === "object" && body.error !== null && "code" in body.error ? String(body.error.code) : "";
    throw new Error(reasons[code] ?? `The upload service could not complete this request (HTTP ${response.status}). No automatic retry was made.`);
  }
  return body;
}

export function PrivateUploadsProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState<string | null>(null);
  const tokenRef = useRef<string | null>(null);
  const [sources, setSources] = useState<PrivateSource[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState<string | null>(null);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const busy = useRef(false);
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    const key = tokenRef.current;
    if (!key) return;
    const current = ++generation.current;
    try {
      const body = await uploadResponse(await fetch("/api/uploads", { headers: { Authorization: `Bearer ${key}` } }));
      if (!body || typeof body !== "object" || !("sources" in body) || !Array.isArray(body.sources) || !body.sources.every(isPrivateSource)) throw new Error("The private source inventory could not be verified.");
      if (key === tokenRef.current && current === generation.current) {
        setSources(body.sources.filter((source) => Date.parse(source.expiresAt) > Date.now()));
        setError(null);
      }
    } catch (failure) {
      if (key === tokenRef.current && current === generation.current) setError(failure instanceof Error ? failure.message : "Private sources could not be loaded.");
    }
  }, []);
  useEffect(() => {
    const sync = () => {
      try {
        const key = readToken();
        if (key !== tokenRef.current) { generation.current++; setSources([]); setFocusedId(null); }
        tokenRef.current = key;
        setToken(key);
        setSources((items) => items.filter((source) => Date.parse(source.expiresAt) > Date.now()));
        void refresh();
      } catch (failure) {
        tokenRef.current = null;
        setToken(null);
        setSources([]);
        setError(failure instanceof Error ? failure.message : "Browser storage is unavailable; private uploads are disabled.");
      }
    };
    sync();
    window.addEventListener("storage", sync);
    window.addEventListener("focus", sync);
    document.addEventListener("visibilitychange", sync);
    return () => { generation.current++; window.removeEventListener("storage", sync); window.removeEventListener("focus", sync); document.removeEventListener("visibilitychange", sync); };
  }, [refresh]);
  useEffect(() => {
    const expiry = sources.map((source) => Date.parse(source.expiresAt));
    const timer = expiry.length ? window.setTimeout(() => {
      setSources((items) => items.filter((source) => Date.parse(source.expiresAt) > Date.now()));
      void refresh();
    }, Math.max(0, Math.min(...expiry) - Date.now())) : undefined;
    const poll = sources.some((source) => ["pending", "extracting", "indexing"].includes(source.state))
      ? window.setInterval(() => { if (!document.hidden) void refresh(); }, 3000) : undefined;
    return () => { window.clearTimeout(timer); window.clearInterval(poll); };
  }, [sources, refresh]);

  async function process(id: string): Promise<void> {
    try {
      await uploadResponse(await fetch(`/api/uploads/${encodeURIComponent(id)}/process`, { method: "POST", headers: { Authorization: `Bearer ${tokenRef.current}` } }));
      await refresh();
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Processing was not confirmed. Choose Process again to try explicitly."); }
  }
  async function upload(files: File[]): Promise<void> {
    if (busy.current || !files.length) return;
    busy.current = true;
    setError(null);
    try {
      if (files.length > 5) throw new Error("Choose at most five files per upload.");
      let key = readToken();
      if (!key) {
        key = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
        window.localStorage.setItem(STORAGE_KEY, key);
        if (readToken() !== key) throw new Error("Browser storage did not retain private access. No file was uploaded.");
        tokenRef.current = key;
        setToken(key);
      }
      for (const [index, file] of files.entries()) {
        if (!file.size || file.size > UPLOAD_LIMIT) throw new Error(`${file.name}: choose a non-empty file up to 10 MiB.`);
        if (!uploadTypes[file.name.split(".").pop()!.toLowerCase()]) throw new Error(`${file.name}: this file type is not supported.`);
        setUploading(`Uploading ${file.name} (${index + 1} of ${files.length})…`);
        const source = await uploadResponse(await fetch("/api/uploads", { method: "POST", body: file, headers: { Authorization: `Bearer ${key}`, "X-File-Name": encodeURIComponent(file.name), "Content-Type": "application/octet-stream" } }));
        if (!isPrivateSource(source)) throw new Error("The upload receipt could not be verified. Reload Sources before trying again.");
        generation.current++;
        setSources((items) => [source, ...items]);
        setFocusedId(source.id);
        await process(source.id);
      }
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Upload failed. Already confirmed files remain in Sources."); }
    finally { busy.current = false; setUploading(null); }
  }
  async function detail(id: string, signal?: AbortSignal): Promise<PrivateSourceDetail> {
    const source = await uploadResponse(await fetch(`/api/uploads/${encodeURIComponent(id)}`, { headers: { Authorization: `Bearer ${tokenRef.current}` }, signal }));
    if (!isPrivateSource(source) || source.id !== id || !("text" in source) || !(source.text === null || typeof source.text === "string")) throw new Error("Private source content could not be verified.");
    return source as PrivateSourceDetail;
  }
  async function update(id: string, changes: { caseId?: string | null; notes?: string; previousNotes?: string }): Promise<void> {
    const key = tokenRef.current;
    const source = await uploadResponse(await fetch(`/api/uploads/${encodeURIComponent(id)}`, { method: "PATCH", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify(changes) }));
    if (!isPrivateSource(source) || source.id !== id || key !== tokenRef.current) throw new Error("The source update could not be verified. Refresh and try again.");
    generation.current++;
    setSources((items) => items.map((item) => item.id === id ? source : item));
  }
  async function remove(id: string): Promise<void> {
    const key = tokenRef.current;
    await uploadResponse(await fetch(`/api/uploads/${encodeURIComponent(id)}`, { method: "DELETE", headers: { Authorization: `Bearer ${key}` } }));
    if (key !== tokenRef.current) return;
    generation.current++;
    setSources((items) => items.filter((item) => item.id !== id));
    setFocusedId((current) => current === id ? null : current);
  }
  async function download(source: PrivateSource, open = false): Promise<void> {
    const preview = open ? window.open("about:blank", "_blank") : null;
    if (preview) preview.opener = null;
    try {
      const response = await fetch(`/api/uploads/${encodeURIComponent(source.id)}/original`, { headers: { Authorization: `Bearer ${tokenRef.current}` } });
      if (!response.ok) { await uploadResponse(response); return; }
      const url = URL.createObjectURL(await response.blob());
      if (open) {
        if (!preview) { URL.revokeObjectURL(url); throw new Error("Allow pop-ups to open the original, or use Download."); }
        preview.location.replace(url);
      } else {
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = source.name;
        anchor.click();
      }
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (failure) { preview?.close(); setError(failure instanceof Error ? failure.message : "The exact original could not be downloaded."); }
  }
  return <UploadContext.Provider value={{ sources, token, error, uploading, focusedId, setFocusedId, refresh, upload, process, detail, download, update, remove }}>{children}</UploadContext.Provider>;
}

export function usePrivateUploads(): UploadLibrary {
  const library = useContext(UploadContext);
  if (!library) throw new Error("Private upload provider is missing.");
  return library;
}

export function UploadPicker() {
  const library = usePrivateUploads();
  const input = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  return <section className="upload-picker" data-dragging={dragging || undefined} aria-label="Upload private files"
    onDragOver={(event) => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)}
    onDrop={(event) => { event.preventDefault(); setDragging(false); void library.upload(Array.from(event.dataTransfer.files)); }}>
    <svg className="upload-drop-icon" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M12 16V3m-5 5 5-5 5 5M4 15v5h16v-5" /></svg>
    <div className="upload-picker-heading"><div><strong>Add private files</strong><p>Drop files here or choose from your device.</p></div>
      <Button className="secondary-button" type="button" disabled={Boolean(library.uploading)} onClick={() => input.current?.click()}>Upload files</Button>
      <input ref={input} className="visually-hidden" type="file" aria-label="Choose private files" accept={uploadAccept} multiple disabled={Boolean(library.uploading)} onChange={(event) => { void library.upload(Array.from(event.currentTarget.files ?? [])); event.currentTarget.value = ""; }} /></div>
    <p className="field-hint">DOCX, PDF, PPTX, XLSX, images, UTF-8 Markdown, text and CSV · 10 MiB/file · 5 files at a time.</p>
    <p className="field-hint">Private access is saved only in this browser. Cloudflare stores and processes files; application access expires after seven days, with background content cleanup. Files never enter the public corpus. Conversion/embedding may use Workers AI. <a href="https://developers.cloudflare.com/workers-ai/platform/data-usage/">Platform data policies</a> govern upstream copies, not this expiry. Do not upload sensitive data.</p>
    {library.uploading && <p role="status">{library.uploading}</p>}
    {library.error && <p className="notice notice-error" role="alert">{library.error}</p>}
  </section>;
}

export function RequestAttachments({ selected, onChange }: { selected: string[]; onChange: (ids: string[]) => void }) {
  const library = usePrivateUploads();
  return <section className="request-attachments" aria-labelledby="attachments-title"><h3 id="attachments-title">Attach client context</h3>
    <UploadPicker />
    {library.sources.length > 0 && <fieldset className="attachment-options"><legend>Include reviewed file text in this request (up to five)</legend>
      {library.sources.map((source) => <div className="attachment-option" key={source.id}>
        <label><input type="checkbox" checked={selected.includes(source.id)} disabled={!source.hasText || (!selected.includes(source.id) && selected.length >= 5)}
          onChange={(event) => onChange(event.currentTarget.checked ? [...selected, source.id] : selected.filter((id) => id !== source.id))} />
          <span>{source.name}<small>{uploadStateLabels[source.state]}{source.hasText ? " · unreviewed client context" : " · waiting for extracted content"}</small></span></label>
        <a href="/?sources" onClick={() => library.setFocusedId(source.id)}>Review</a>
      </div>)}
    </fieldset>}
    {selected.some((id) => !library.sources.some((source) => source.id === id)) && <p className="notice notice-warning" role="alert">A selected file is no longer available in this browser. No request can be sent with it. <Button type="button" className="text-button" onClick={() => onChange(selected.filter((id) => library.sources.some((source) => source.id === id)))}>Remove unavailable attachments</Button></p>}
    <p className="field-hint">Selected text is sent with your request to the configured model, within the existing 16 KiB combined limit. Submitted text follows that job’s original seven-day expiry, independently of the file’s expiry. Files are client context, not checked historical evidence. <a href="/?sources">Manage Sources</a></p>
  </section>;
}
