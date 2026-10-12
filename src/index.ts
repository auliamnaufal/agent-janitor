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
export {
  act,
  buildPlan,
  restore,
  restoreItems,
  restoreQuery,
  type ActResult,
  type RestoreOptions,
  type RestoreResult,
} from "./engine/act.js";
export {
  classifyRestoreTarget,
  listArchived,
  listManifests,
  matchArchived,
  type ArchivedItem,
  type RestoreTarget,
} from "./engine/catalog.js";
export { aggregate, renderPlan, renderScan, scanJson, totals } from "./engine/report.js";
export { guard, desiredAction, planFindings, isProtectedPath, PRUNEABLE, DEFAULT_RETENTION_DAYS } from "./engine/safety.js";
export { enrichSecrets, scanFileForSecrets, scanTextForSecrets, riskFromHits, type FileScanOptions } from "./engine/secrets.js";
export { writeTarGz, extractTarGz, safeTarget } from "./engine/archive.js";
export { DRIVERS, getDriver } from "./drivers/registry.js";
export {
  changedFiles,
  defaultChanged,
  gitHooksDir,
  prePushHookScript,
  runGuard,
  type GuardIssue,
  type GuardResult,
} from "./engine/guard.js";
export { buildSchedule, runActivation, type SchedulePlan } from "./triggers/schedule.js";
export { renderPrompt } from "./triggers/shell.js";
export { VERSION } from "./version.js";
