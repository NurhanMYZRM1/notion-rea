import * as DocumentPicker from "expo-document-picker";
import { Directory, File } from "expo-file-system";
import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import * as ImagePicker from "expo-image-picker";
import * as Sharing from "expo-sharing";
import { api, API_URL, authHeaders } from "./api";
import { attachmentId, type UploadedFile } from "./bridge";
import { ATTACHMENTS_DIR } from "./session";

export const MAX_IMAGE_EDGE = 2048;
const WEB_IMAGE = /^image\/(png|jpeg|gif|webp)$/;

/**
 * Attachment bytes cached per id under the OS cache dir. Downloaded natively with the session cookie,
 * so the WebView only ever sees a local URI. Throws when uncached and the download fails (offline).
 */
async function cachedAttachment(id: string): Promise<File> {
  const dir = new Directory(ATTACHMENTS_DIR(), id);
  const hit = dir.exists ? dir.list().find((f): f is File => f instanceof File && f.size > 0) : undefined;
  if (hit) return hit;
  dir.create({ intermediates: true, idempotent: true });
  try {
    // A directory destination keeps the server's filename (Content-Disposition), hence a real extension.
    return await File.downloadFileAsync(`${API_URL}/api/attachments/${id}`, dir, { headers: await authHeaders(), idempotent: true });
  } catch (err) {
    if (dir.exists) dir.delete();
    throw err;
  }
}

const MIME_BY_EXT: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif" };

export async function resolveSrc(src: string): Promise<string> {
  if (/^https:\/\//i.test(src)) return src; // external image: the WebView loads it without credentials
  const id = attachmentId(src);
  if (!id) throw new Error("Unsupported image source");
  const file = await cachedAttachment(id);
  // Dev builds load the editor from the Metro server (http origin), which may not read file:// URIs.
  if (__DEV__) return `data:${MIME_BY_EXT[file.extension.replace(".", "").toLowerCase()] ?? "image/png"};base64,${await file.base64()}`;
  return file.uri;
}

export async function openFile(src: string): Promise<void> {
  const id = attachmentId(src);
  if (!id) throw new Error("Unsupported file");
  const file = await cachedAttachment(id);
  if (await file.canPreview().catch(() => false)) await file.preview();
  else await Sharing.shareAsync(file.uri);
}

/** System picker → (images: downscale >2048px, normalize HEIC to JPEG) → upload. Null when cancelled. */
export async function pickAndUpload(pageId: string, kind: "image" | "file"): Promise<UploadedFile | null> {
  let uri: string;
  let name: string;
  let type: string;
  if (kind === "image") {
    const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], quality: 1, exif: false });
    const a = res.canceled ? undefined : res.assets[0];
    if (!a) return null;
    uri = a.uri;
    name = a.fileName ?? "image.jpg";
    type = a.mimeType ?? "image/jpeg";
    const big = Math.max(a.width, a.height) > MAX_IMAGE_EDGE;
    if (big || !WEB_IMAGE.test(type)) {
      const ctx = ImageManipulator.manipulate(uri);
      if (big) ctx.resize(a.width >= a.height ? { width: MAX_IMAGE_EDGE } : { height: MAX_IMAGE_EDGE });
      const png = type === "image/png";
      const out = await (await ctx.renderAsync()).saveAsync({ format: png ? SaveFormat.PNG : SaveFormat.JPEG, compress: 0.85 });
      uri = out.uri;
      type = png ? "image/png" : "image/jpeg";
      name = `${name.replace(/\.[^.]+$/, "")}.${png ? "png" : "jpg"}`;
    }
  } else {
    const res = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true, multiple: false });
    const a = res.canceled ? undefined : res.assets[0];
    if (!a) return null;
    uri = a.uri;
    name = a.name;
    type = a.mimeType ?? "application/octet-stream";
  }
  const local = new File(uri);
  const body = await local.bytes();
  const up = await api.upload(pageId, { name, type, size: body.byteLength, body });
  // Seed the cache so the new attachment renders offline without a round trip.
  try {
    const id = attachmentId(up.src);
    if (id) {
      const dir = new Directory(ATTACHMENTS_DIR(), id);
      dir.create({ intermediates: true, idempotent: true });
      local.copy(new File(dir, up.name || name));
    }
  } catch {
    /* cache seeding is best effort */
  }
  return { src: up.src, name: up.name, mimeType: up.mimeType, size: up.size };
}
