export const UPLOAD_LIMIT = 10 * 1024 * 1024;
export const UPLOAD_TEXT_LIMIT = 64 * 1024;
export const uploadTypes: Record<string, string> = {
  txt: "text/plain", md: "text/markdown", markdown: "text/markdown", csv: "text/csv",
  pdf: "application/pdf", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp",
  gif: "image/gif", bmp: "image/bmp", tif: "image/tiff", tiff: "image/tiff",
};
export const uploadAccept = Object.keys(uploadTypes).map((extension) => `.${extension}`).join(",");
export type UploadState = "pending" | "extracting" | "indexing" | "indexed" | "needs_review" | "failed";
export const uploadStateLabels: Record<UploadState, string> = {
  pending: "Pending", extracting: "Extracting", indexing: "Indexing", indexed: "Indexed",
  needs_review: "Needs review", failed: "Failed",
};
export interface PrivateSource {
  id: string;
  name: string;
  mimeType: string;
  caseId: string | null;
  notes: string;
  size: number;
  sha256: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  state: UploadState;
  hasText: boolean;
  textKind: "native_text" | "converted_text" | "visual_interpretation";
  chunkCount: number;
  warning: string | null;
  error: string | null;
  activity: { at: string; state: UploadState; message: string }[];
}
export interface PrivateSourceDetail extends PrivateSource { text: string | null }
export interface PrivateSearchMatch { sourceId: string; name: string; chunk: number; excerpt: string }
export type SourceIndexStatus = "indexed" | "partial" | "pending" | "unavailable";

export function isPrivateSource(value: unknown): value is PrivateSource {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Record<string, unknown>;
  return typeof item.id === "string" && /^[a-f0-9-]{36}$/u.test(item.id)
    && typeof item.name === "string" && typeof item.mimeType === "string"
    && (item.caseId === null || (typeof item.caseId === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/u.test(item.caseId)))
    && typeof item.notes === "string" && item.notes.length <= 4000
    && typeof item.size === "number" && Number.isSafeInteger(item.size) && item.size > 0 && item.size <= UPLOAD_LIMIT
    && typeof item.sha256 === "string" && /^[a-f0-9]{64}$/u.test(item.sha256)
    && [item.createdAt, item.updatedAt, item.expiresAt].every((date) => typeof date === "string" && Number.isFinite(Date.parse(date)))
    && typeof item.state === "string" && Object.hasOwn(uploadStateLabels, item.state)
    && typeof item.hasText === "boolean" && ["native_text", "converted_text", "visual_interpretation"].includes(item.textKind as string)
    && typeof item.chunkCount === "number" && Number.isSafeInteger(item.chunkCount) && item.chunkCount >= 0 && item.chunkCount <= 128
    && [item.warning, item.error].every((text) => text === null || typeof text === "string")
    && Array.isArray(item.activity) && item.activity.length <= 40 && item.activity.every((entry: unknown) => {
      if (typeof entry !== "object" || entry === null) return false;
      const event = entry as Record<string, unknown>;
      return typeof event.at === "string" && Number.isFinite(Date.parse(event.at))
        && typeof event.state === "string" && Object.hasOwn(uploadStateLabels, event.state) && typeof event.message === "string";
    });
}
