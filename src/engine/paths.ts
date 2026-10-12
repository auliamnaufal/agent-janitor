import path from "node:path";

export function stateDir(home: string): string {
  return path.join(home, ".agent-gc");
}

export function archiveDir(home: string): string {
  return path.join(stateDir(home), "archive");
}

export function manifestDir(home: string): string {
  return path.join(stateDir(home), "manifests");
}

export function cacheFile(home: string): string {
  return path.join(stateDir(home), "summary.json");
}
