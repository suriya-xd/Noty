import { NoeticBridge } from "../services/noeticBridge";
import { ASSETS_FOLDER } from "./assets";

/**
 * Saving images that are pasted, dropped or uploaded into the notes folder's `assets` folder.
 */

const EXT_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "image/bmp": "bmp",
  "image/avif": "avif",
};

export const isImageFile = (file: File) =>
  file.type.startsWith("image/") || /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i.test(file.name);

/** The image in a paste or drop, if there is one. */
export function imageFromDataTransfer(dt: DataTransfer | null | undefined): File | null {
  if (!dt) return null;
  for (const item of Array.from(dt.items ?? [])) {
    if (item.kind === "file" && item.type.startsWith("image/")) {
      const file = item.getAsFile();
      if (file) return file;
    }
  }
  return Array.from(dt.files ?? []).find(isImageFile) ?? null;
}

/**
 * Reads an image from the system clipboard. Null when there is none or the clipboard can't be
 * read (no permission, or the platform doesn't allow it). Call it from a tap or click.
 */
export async function readClipboardImage(): Promise<File | null> {
  const fromApp = readAndroidClipboardImage();
  if (fromApp !== undefined) return fromApp;
  try {
    if (!navigator.clipboard?.read) return null;
    const items = await navigator.clipboard.read();
    for (const item of items) {
      const type = item.types.find((t) => t.startsWith("image/"));
      if (type) {
        const blob = await item.getType(type);
        return new File([blob], `image.${EXT_BY_MIME[type] ?? "png"}`, { type });
      }
    }
  } catch {
    // Not allowed or not available.
  }
  return null;
}

interface AndroidBridge {
  readClipboardImage(): string;
}

/**
 * In the Android app the web clipboard API is blocked, so the app reads the clipboard itself
 * (MainActivity.kt). Undefined when not running in the Android app.
 */
export function readAndroidClipboardImage(
  bridge = (globalThis as { NoeticAndroid?: AndroidBridge }).NoeticAndroid
): File | null | undefined {
  if (!bridge?.readClipboardImage) return undefined;
  try {
    const raw = bridge.readClipboardImage();
    const sep = raw.indexOf(";");
    if (sep <= 0) return null;
    const type = raw.slice(0, sep);
    const bin = atob(raw.slice(sep + 1));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new File([bytes], `image.${EXT_BY_MIME[type] ?? "png"}`, { type });
  } catch {
    return null;
  }
}

/**
 * Reads the clipboard only if that won't prompt the user, e.g. when a dialog opens. Null when it
 * would need asking first.
 */
export async function peekClipboardImage(): Promise<File | null> {
  // The Android app can read it without asking.
  const fromApp = readAndroidClipboardImage();
  if (fromApp !== undefined) return fromApp;
  try {
    const status = await navigator.permissions?.query({ name: "clipboard-read" as PermissionName });
    if (status?.state !== "granted") return null;
  } catch {
    return null;
  }
  return readClipboardImage();
}

/** Names that clipboards and screenshots give every image, which would overwrite each other. */
const GENERIC_NAME = /^(image|blob|pasted|clipboard|untitled|screenshot)?$/i;

/**
 * A free path in the assets folder for `file`. Pasted images get a dated name; a name that's
 * already taken gets a number added, so an image is never silently replaced.
 */
export function assetPathFor(file: File, existingPaths: Iterable<string>, now = new Date()): string {
  const taken = new Set(Array.from(existingPaths, (p) => p.toLowerCase()));
  const dot = file.name.lastIndexOf(".");
  let base = dot > 0 ? file.name.slice(0, dot) : file.name;
  let ext = (dot > 0 ? file.name.slice(dot + 1) : "") || EXT_BY_MIME[file.type] || "png";
  ext = ext.toLowerCase().replace(/[^a-z0-9]/g, "") || "png";

  base = base.replace(/[^a-zA-Z0-9._-]/g, "_").replace(/^[._]+|[._]+$/g, "");
  if (GENERIC_NAME.test(base)) {
    const pad = (n: number) => String(n).padStart(2, "0");
    base = `pasted-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(
      now.getMinutes()
    )}${pad(now.getSeconds())}`;
  }

  let candidate = `${ASSETS_FOLDER}/${base}.${ext}`;
  for (let n = 2; taken.has(candidate.toLowerCase()); n++) candidate = `${ASSETS_FOLDER}/${base}-${n}.${ext}`;
  return candidate;
}

function readAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/** Saves `file` into the assets folder under a free name and returns its path in the notes folder. */
export async function saveImageToAssets(
  vaultPath: string,
  file: File,
  existingPaths: Iterable<string>
): Promise<string> {
  const relPath = assetPathFor(file, existingPaths);
  // Sent once, as base64: a list of byte values is several times larger to build and to parse.
  await NoeticBridge.saveImageFile(vaultPath, relPath, await readAsDataUrl(file));
  return relPath;
}

/** The alt text for an image: its file name without extension, or "Image" for pasted ones. */
export function altTextFor(file: File): string {
  const base = file.name.replace(/\.[^/.]+$/, "");
  return GENERIC_NAME.test(base) ? "Image" : base;
}
