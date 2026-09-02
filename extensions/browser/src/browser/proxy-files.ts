import { canonicalizeBase64 } from "openclaw/plugin-sdk/media-runtime";
import { saveMediaBuffer } from "../media/store.js";

export type BrowserProxyFile = {
  path: string;
  base64: string;
  mimeType?: string;
};

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/**
 * Canonical base64 leaves the unused trailing bits of the final data character
 * at zero. `Buffer.from(..., "base64")` silently drops those bits instead of
 * failing, so check them explicitly to keep the encoding round-trippable.
 */
function hasCanonicalPaddingBits(canonicalBase64: string): boolean {
  const paddingLength = canonicalBase64.endsWith("==") ? 2 : canonicalBase64.endsWith("=") ? 1 : 0;
  if (paddingLength === 0) {
    return true;
  }
  const lastDataChar = canonicalBase64[canonicalBase64.length - paddingLength - 1];
  const value = BASE64_ALPHABET.indexOf(lastDataChar ?? "");
  if (value < 0) {
    return false;
  }
  // Two padding chars keep 8 of 12 bits; one padding char keeps 16 of 18 bits.
  const unusedBitsMask = paddingLength === 2 ? 0b001111 : 0b000011;
  return (value & unusedBitsMask) === 0;
}

/**
 * Decode a proxy-returned payload, rejecting anything that is not valid base64.
 * `Buffer.from(x, "base64")` silently ignores characters outside the alphabet,
 * so a malformed payload would otherwise be persisted as a corrupted file with
 * no error surfaced to the caller.
 */
function decodeBrowserProxyFileBase64(base64: string): Buffer {
  // The shared validator rejects empty input, but zero-byte downloads are valid files.
  if (base64 === "") {
    return Buffer.alloc(0);
  }
  // Strict on purpose: the only producer is our own node relay, which always
  // emits padded output via Buffer#toString("base64"). Repairing padding here
  // would let inputs with a wrong padding count slip past the malformed check.
  const canonicalBase64 = canonicalizeBase64(base64);
  if (canonicalBase64 === undefined || !hasCanonicalPaddingBits(canonicalBase64)) {
    throw new Error("browser proxy file contains malformed base64 data");
  }
  return Buffer.from(canonicalBase64, "base64");
}

export async function persistBrowserProxyFiles(files: BrowserProxyFile[] | undefined) {
  if (!files || files.length === 0) {
    return new Map<string, string>();
  }
  // Decode every payload up front so one malformed file cannot leave earlier
  // files already persisted in the media store.
  const decoded = files.map((file) => ({
    file,
    buffer: decodeBrowserProxyFileBase64(file.base64),
  }));
  const mapping = new Map<string, string>();
  for (const { file, buffer } of decoded) {
    const saved = await saveMediaBuffer(buffer, file.mimeType, "browser");
    mapping.set(file.path, saved.path);
  }
  return mapping;
}

export function applyBrowserProxyPaths(result: unknown, mapping: Map<string, string>) {
  if (!result || typeof result !== "object") {
    return;
  }
  const obj = result as Record<string, unknown>;
  if (typeof obj.path === "string" && mapping.has(obj.path)) {
    obj.path = mapping.get(obj.path);
  }
  if (typeof obj.imagePath === "string" && mapping.has(obj.imagePath)) {
    obj.imagePath = mapping.get(obj.imagePath);
  }
  const download = obj.download;
  if (download && typeof download === "object") {
    const d = download as Record<string, unknown>;
    if (typeof d.path === "string" && mapping.has(d.path)) {
      d.path = mapping.get(d.path);
    }
  }
}
