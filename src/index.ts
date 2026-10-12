export type {
  Action,
  Driver,
  Env,
  Finding,
  FindingKind,
  Manifest,
  ManifestEntry,
  Plan,
  PlannedFinding,
  SecretRisk,
  Summary,
  Verdict,
} from "./engine/types.js";

export { scan, type ScanResult, type DriverStatus } from "./engine/scan.js";
export { act, buildPlan, restore, type ActResult, type RestoreResult } from "./engine/act.js";
export { aggregate, renderPlan, renderScan, scanJson, totals } from "./engine/report.js";
export { guard, desiredAction, planFindings, isProtectedPath, PRUNEABLE, DEFAULT_RETENTION_DAYS } from "./engine/safety.js";
export { enrichSecrets, scanTextForSecrets, riskFromHits } from "./engine/secrets.js";
export { writeTarGz, extractTarGz, safeTarget } from "./engine/archive.js";
export { DRIVERS, getDriver } from "./drivers/registry.js";
export { buildSchedule, type SchedulePlan } from "./triggers/schedule.js";
export { renderPrompt } from "./triggers/shell.js";
export { VERSION } from "./version.js";
