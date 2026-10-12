import { promises as fs } from "node:fs";
import { readJson, writeJson } from "../util/fs.js";
import type { Manifest } from "./types.js";

export async function writeManifest(filePath: string, manifest: Manifest): Promise<void> {
  await writeJson(filePath, manifest);
}

export async function readManifest(filePath: string): Promise<Manifest | null> {
  const data = await readJson<Manifest>(filePath);
  if (!data || data.version !== 1 || !Array.isArray(data.entries)) return null;
  return data;
}

export async function removePath(p: string): Promise<void> {
  await fs.rm(p, { recursive: true, force: true });
}
