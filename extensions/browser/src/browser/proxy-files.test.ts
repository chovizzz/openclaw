import fs from "node:fs/promises";
import path from "node:path";
import { MEDIA_MAX_BYTES } from "openclaw/plugin-sdk/media-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTempHomeEnv, type TempHomeEnv } from "../../test-support.js";
import { persistBrowserProxyFiles } from "./proxy-files.js";

describe("persistBrowserProxyFiles", () => {
  let tempHome: TempHomeEnv;

  beforeEach(async () => {
    tempHome = await createTempHomeEnv("openclaw-browser-proxy-files-");
  });

  afterEach(async () => {
    await tempHome.restore();
  });

  it("persists browser proxy files under the shared media store", async () => {
    const sourcePath = "/tmp/proxy-file.txt";
    const mapping = await persistBrowserProxyFiles([
      {
        path: sourcePath,
        base64: Buffer.from("hello from browser proxy").toString("base64"),
        mimeType: "text/plain",
      },
    ]);

    const savedPath = mapping.get(sourcePath);
    expect(typeof savedPath).toBe("string");
    expect(path.normalize(savedPath ?? "")).toContain(
      `${path.sep}.openclaw${path.sep}media${path.sep}browser${path.sep}`,
    );
    await expect(fs.readFile(savedPath ?? "", "utf8")).resolves.toBe("hello from browser proxy");
  });

  it("persists legitimate empty browser proxy downloads", async () => {
    const sourcePath = "/tmp/empty-browser-download.bin";
    const mapping = await persistBrowserProxyFiles([
      { path: sourcePath, base64: "", mimeType: "application/octet-stream" },
    ]);

    const savedPath = mapping.get(sourcePath);
    expect(typeof savedPath).toBe("string");
    await expect(fs.stat(savedPath ?? "")).resolves.toMatchObject({ size: 0 });
    await expect(fs.readFile(savedPath ?? "")).resolves.toHaveLength(0);
  });

  it.each([{ name: "valid whitespace-separated base64", base64: " aG Vs bG8= \n" }])(
    "persists $name without corrupting the download",
    async ({ base64 }) => {
      const sourcePath = "/tmp/normalized-browser-download.txt";
      const mapping = await persistBrowserProxyFiles([
        { path: sourcePath, base64, mimeType: "text/plain" },
      ]);

      await expect(fs.readFile(mapping.get(sourcePath) ?? "", "utf8")).resolves.toBe("hello");
    },
  );

  it.each([
    { name: "invalid alphabet", base64: "aGVsbG8$" },
    { name: "invalid padding", base64: "aGVsbG8===" },
    { name: "missing padding", base64: "aGVsbG8" },
    { name: "short padding", base64: "QQ=" },
    { name: "nonzero padding bits", base64: "ZE==" },
    { name: "nonzero trailing bits with single padding", base64: "aGV=" },
    { name: "impossible unpadded length", base64: "S" },
    { name: "whitespace without encoded data", base64: " \n\t" },
  ])("rejects $name before creating the media directory", async ({ base64 }) => {
    await expect(
      persistBrowserProxyFiles([
        {
          path: "/tmp/malformed-browser-download.bin",
          base64,
          mimeType: "application/octet-stream",
        },
      ]),
    ).rejects.toThrow("browser proxy file contains malformed base64 data");

    await expect(
      fs.stat(path.join(tempHome.home, ".openclaw", "media", "browser")),
    ).rejects.toHaveProperty("code", "ENOENT");
  });

  it("rejects a later malformed file without persisting an earlier valid file", async () => {
    await expect(
      persistBrowserProxyFiles([
        {
          path: "/tmp/valid-browser-download.txt",
          base64: Buffer.from("valid browser download").toString("base64"),
          mimeType: "text/plain",
        },
        { path: "/tmp/malformed-browser-download.bin", base64: "ZE==" },
      ]),
    ).rejects.toThrow("browser proxy file contains malformed base64 data");

    await expect(
      fs.stat(path.join(tempHome.home, ".openclaw", "media", "browser")),
    ).rejects.toHaveProperty("code", "ENOENT");
  });

  it("rejects browser proxy files that exceed the shared media size limit", async () => {
    const oversized = Buffer.alloc(MEDIA_MAX_BYTES + 1, 0x41);

    await expect(
      persistBrowserProxyFiles([
        {
          path: "/tmp/oversized.bin",
          base64: oversized.toString("base64"),
          mimeType: "application/octet-stream",
        },
      ]),
    ).rejects.toThrow("Media exceeds 5MB limit");

    await expect(
      fs.stat(path.join(tempHome.home, ".openclaw", "media", "browser")),
    ).rejects.toThrow();
  });
});
