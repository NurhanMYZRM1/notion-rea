import { newId } from "@workspace/core";
import { AppError, notFound } from "../errors";
import { type Actor, requireAccess, requirePageAccess } from "./access";

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const ALLOWED = /^(image\/(png|jpeg|gif|webp|avif)|application\/pdf|text\/plain|text\/csv|text\/markdown|application\/zip|application\/json|application\/vnd\.openxmlformats-officedocument\.[a-z.]+|audio\/(mpeg|mp4|wav)|video\/(mp4|webm))$/;
// Types we serve inline; everything else is forced to download (no HTML/SVG/script rendering on our origin).
const INLINE = /^(image\/(png|jpeg|gif|webp|avif)|application\/pdf|audio\/|video\/)/;

export async function upload(
  env: Env,
  actor: Actor,
  pageId: string,
  file: { name: string; type: string; size: number; body: ReadableStream | ArrayBuffer },
): Promise<{ id: string; src: string; name: string; mimeType: string; size: number }> {
  const access = await requirePageAccess(env, actor, pageId, "write");
  if (access.page.state !== "active") throw new AppError("conflict", "Page is in the trash");
  if (!file.size || file.size > MAX_UPLOAD_BYTES) throw new AppError("too_large", `Files must be between 1 byte and ${MAX_UPLOAD_BYTES / 1024 / 1024} MB`);
  const type = file.type.toLowerCase().split(";")[0]!.trim();
  if (!ALLOWED.test(type)) throw new AppError("unsupported", `File type ${type || "unknown"} is not allowed`);
  const name = file.name.replace(/[\u0000-\u001f\\/]/g, "_").slice(0, 200) || "file";
  const id = newId("at");
  const key = `ws/${access.workspaceId}/${id}`;
  const stored = await env.FILES.put(key, file.body, { httpMetadata: { contentType: type } });
  if (!stored || stored.size !== file.size) {
    await env.FILES.delete(key);
    throw new AppError("invalid_input", "Upload size did not match the declared size");
  }
  await env.DB.prepare(
    "INSERT INTO attachments (id, workspace_id, page_id, r2_key, name, mime_type, size, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(id, access.workspaceId, pageId, key, name, type, file.size, actor.userId, Date.now())
    .run();
  return { id, src: `/api/attachments/${id}`, name, mimeType: type, size: file.size };
}

/** Authorized download. Every request re-checks membership of the attachment's workspace. */
export async function download(env: Env, actor: Actor, attachmentId: string, range: string | null): Promise<Response> {
  const row = await env.DB.prepare("SELECT workspace_id, page_id, r2_key, name, mime_type FROM attachments WHERE id = ?")
    .bind(attachmentId)
    .first<{ workspace_id: string; page_id: string; r2_key: string; name: string; mime_type: string }>();
  if (!row) throw notFound("File");
  try {
    await requireAccess(env, actor, row.workspace_id, "read");
  } catch {
    throw notFound("File");
  }
  const page = await env.DB.prepare("SELECT state FROM pages WHERE id = ?").bind(row.page_id).first<{ state: string }>();
  if (!page || page.state === "deleted") throw notFound("File");
  const object = await env.FILES.get(row.r2_key, range ? { range: parseRange(range) } : undefined);
  if (!object) throw notFound("File");
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("Content-Type", row.mime_type);
  headers.set("Cache-Control", "private, max-age=3600");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Content-Security-Policy", "default-src 'none'; sandbox");
  headers.set("Content-Disposition", `${INLINE.test(row.mime_type) ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(row.name)}`);
  headers.set("ETag", object.httpEtag);
  return new Response(object.body, { headers });
}

function parseRange(header: string): R2Range | undefined {
  const m = /^bytes=(\d+)-(\d*)$/.exec(header);
  if (!m) return undefined;
  const offset = Number(m[1]);
  return m[2] ? { offset, length: Number(m[2]) - offset + 1 } : { offset };
}
