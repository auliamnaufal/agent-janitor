import { DRIVERS, getDriver } from "../drivers/registry.js";
import { enrichSecrets } from "./secrets.js";
import type { Driver, Env, Finding } from "./types.js";

export interface DriverStatus {
  id: string;
  name: string;
  detected: boolean;
  count: number;
  error?: string;
}

export interface ScanResult {
  findings: Finding[];
  drivers: DriverStatus[];
}

export async function scan(
  env: Env,
  opts: { only?: string[]; secrets?: boolean; scanBytes?: number } = {},
): Promise<ScanResult> {
  let drivers: Driver[] = DRIVERS;
  if (opts.only && opts.only.length > 0) {
    // A typo in --only would otherwise scan nothing and report a clean machine.
    const unknown = opts.only.filter((id) => !DRIVERS.some((d) => d.id === id));
    if (unknown.length > 0) {
      throw new Error(
        `unknown driver(s): ${unknown.join(", ")} — available: ${DRIVERS.map((d) => d.id).join(", ")}`,
      );
    }
    drivers = opts.only.map(getDriver).filter((d): d is Driver => d !== undefined);
  }

  const findings: Finding[] = [];
  const statuses: DriverStatus[] = [];

  for (const driver of drivers) {
    let items: Finding[] = [];
    let error: string | undefined;
    let detected = false;
    try {
      detected = await driver.detect(env);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    if (detected && !error) {
      try {
        items = (await driver.scan(env)).filter((f) => f.bytes > 0);
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
        items = [];
      }
    }
    findings.push(...items);
    statuses.push({
      id: driver.id,
      name: driver.name,
      detected,
      count: items.length,
      ...(error ? { error } : {}),
    });
  }

  const enriched =
    opts.secrets === false
      ? findings
      : await enrichSecrets(
          findings,
          opts.scanBytes !== undefined
            ? { maxBytes: opts.scanBytes, tailBytes: opts.scanBytes }
            : {},
        );
  return { findings: enriched, drivers: statuses };
}
