import { promises as fs } from "node:fs";
import type { Finding, SecretRisk } from "./types.js";

interface SecretPattern {
  label: string;
  re: RegExp;
  /** Strong patterns alone imply "likely"; weak ones imply "possible". */
  strong: boolean;
}

/**
 * Heuristic secret patterns. This is a surface-level detector, not a scanner —
 * it favours precision on well-known credential shapes to keep false positives low.
 */
export const SECRET_PATTERNS: SecretPattern[] = [
  { label: "private-key", re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/, strong: true },
  { label: "aws-access-key", re: /\bAKIA[0-9A-Z]{16}\b/, strong: true },
  { label: "anthropic-key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}/, strong: true },
  { label: "openai-key", re: /\bsk-[A-Za-z0-9]{20,}/, strong: true },
  { label: "github-token", re: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/, strong: true },
  { label: "google-api-key", re: /\bAIza[0-9A-Za-z_-]{35}\b/, strong: true },
  { label: "slack-token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/, strong: true },
  { label: "stripe-key", re: /\b(?:sk|pk)_(?:live|test)_[A-Za-z0-9]{16,}/, strong: true },
  { label: "jwt", re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, strong: false },
  {
    label: "generic-credential",
    re: /(?:api[_-]?key|secret|token|passwd|password)["'\s]*[:=]\s*["']?[A-Za-z0-9_\-]{16,}/i,
    strong: false,
  },
];

export function scanTextForSecrets(text: string): string[] {
  const hits: string[] = [];
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.re.test(text)) hits.push(pattern.label);
  }
  return hits;
}

export function riskFromHits(hits: string[]): SecretRisk {
  if (hits.length === 0) return "none";
  const strong = new Set(SECRET_PATTERNS.filter((p) => p.strong).map((p) => p.label));
  return hits.some((h) => strong.has(h)) ? "likely" : "possible";
}

async function readRange(filePath: string, start: number, length: number): Promise<string> {
  if (length <= 0) return "";
  const handle = await fs.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

export interface FileScanOptions {
  /** Bytes read from the head. Default 1 MB. */
  maxBytes?: number;
  /** Bytes read from the tail when the file is larger than maxBytes. Default 256 KB. */
  tailBytes?: number;
}

const DEFAULT_HEAD_BYTES = 1024 * 1024;
const DEFAULT_TAIL_BYTES = 256 * 1024;

/**
 * Scan a file for secrets by reading its head and — for files larger than the
 * head window — its tail too. Bounded and fast; a secret buried in the middle of
 * a very large file can still be missed (raise `maxBytes` to widen the window).
 */
export async function scanFileForSecrets(
  filePath: string,
  opts: FileScanOptions = {},
): Promise<string[]> {
  const head = opts.maxBytes ?? DEFAULT_HEAD_BYTES;
  const tail = opts.tailBytes ?? DEFAULT_TAIL_BYTES;
  const { size } = await fs.stat(filePath);
  const hits = new Set<string>();

  for (const label of scanTextForSecrets(await readRange(filePath, 0, Math.min(size, head)))) {
    hits.add(label);
  }
  if (size > head) {
    const start = Math.max(head, size - tail);
    for (const label of scanTextForSecrets(await readRange(filePath, start, size - start))) {
      hits.add(label);
    }
  }
  return [...hits];
}

const CONTENT_KINDS = new Set(["transcript", "scratch", "log", "trace"]);

async function enrichOne(finding: Finding, opts: FileScanOptions): Promise<Finding> {
  if (!CONTENT_KINDS.has(finding.kind)) return finding;
  try {
    const hits = await scanFileForSecrets(finding.path, opts);
    return {
      ...finding,
      secretRisk: riskFromHits(hits),
      ...(hits.length > 0 ? { secretHits: hits } : {}),
    };
  } catch {
    return finding;
  }
}

/**
 * Replaces the name-based secretRisk with a content-based one for scannable kinds.
 * Runs with bounded concurrency and only reads the head (and tail) of each file.
 */
export async function enrichSecrets(
  findings: Finding[],
  opts: FileScanOptions & { concurrency?: number } = {},
): Promise<Finding[]> {
  const scanOpts: FileScanOptions = {};
  if (opts.maxBytes !== undefined) scanOpts.maxBytes = opts.maxBytes;
  if (opts.tailBytes !== undefined) scanOpts.tailBytes = opts.tailBytes;

  const concurrency = Math.min(opts.concurrency ?? 16, Math.max(1, findings.length));
  const results: Finding[] = new Array(findings.length);
  let cursor = 0;

  const worker = async (): Promise<void> => {
    while (cursor < findings.length) {
      const index = cursor++;
      const finding = findings[index];
      if (!finding) continue;
      results[index] = await enrichOne(finding, scanOpts);
    }
  };

  await Promise.all(Array.from({ length: concurrency }, worker));
  return results;
}
