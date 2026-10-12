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

/** Read up to `maxBytes` from the head of a file as UTF-8. */
export async function readHead(filePath: string, maxBytes: number): Promise<string> {
  const handle = await fs.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

const CONTENT_KINDS = new Set(["transcript", "scratch", "log", "trace"]);

async function enrichOne(finding: Finding, maxBytes: number): Promise<Finding> {
  if (!CONTENT_KINDS.has(finding.kind)) return finding;
  try {
    const text = await readHead(finding.path, maxBytes);
    const hits = scanTextForSecrets(text);
    return { ...finding, secretRisk: riskFromHits(hits), ...(hits.length > 0 ? { secretHits: hits } : {}) };
  } catch {
    return finding;
  }
}

/**
 * Replaces the name-based secretRisk with a content-based one for scannable kinds.
 * Runs with bounded concurrency and only reads the head of each file.
 */
export async function enrichSecrets(
  findings: Finding[],
  opts: { maxBytes?: number; concurrency?: number } = {},
): Promise<Finding[]> {
  const maxBytes = opts.maxBytes ?? 256 * 1024;
  const concurrency = Math.min(opts.concurrency ?? 16, Math.max(1, findings.length));
  const results: Finding[] = new Array(findings.length);
  let cursor = 0;

  const worker = async (): Promise<void> => {
    while (cursor < findings.length) {
      const index = cursor++;
      const finding = findings[index];
      if (!finding) continue;
      results[index] = await enrichOne(finding, maxBytes);
    }
  };

  await Promise.all(Array.from({ length: concurrency }, worker));
  return results;
}
