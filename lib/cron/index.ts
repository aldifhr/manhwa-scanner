/**
 * Cron job module - execution and orchestration
 * 
 * Domain-organized exports:
 * - lock: Cron locking mechanism
 * - inputs: Input loading (whitelist, guilds, health)
 * - validation: Guild channel validation
 * - scrape: Scrape phase orchestration
 * - dispatch: Notification dispatch
 * - short-circuit: Early exit handlers
 * - status-builder: Status payload building
 * - helpers: Utility functions
 * - status: Status reading
 * - cleanup: Maintenance tasks
 */

// Lock
export {
  acquireCronLock,
  forceReleaseCronLock,
  isCronLocked,
  type LockResult,
} from "./lock.js";

// Inputs
export {
  loadCronInputs,
  validateCronInputs,
  type CronInputs,
  type QueueHealth,
  type LoadInputsOptions,
  type ValidationResult,
} from "./inputs.js";

// Validation (from existing file)
export { loadValidatedGuilds } from "./validation.js";

// Scrape (from existing file)
export { runScrapePhase } from "./scrape.js";

// Dispatch (from existing file)
export { runDispatch } from "./qstash-dispatch.js";

// Short-circuit
export {
  buildShortCircuitStatus,
  handleShortCircuit,
  isShortCircuitResult,
  type ShortCircuitOptions,
  type ShortCircuitResult,
} from "./short-circuit.js";

// Status builder
export {
  buildSuccessStatus,
  buildErrorStatus,
  writeSuccessStatus,
  writeErrorStatus,
  type StatusBuildOptions,
  type ErrorStatusOptions,
} from "./status-builder.js";

// Helpers
export {
  limitObjectArrays,
  shouldRunChannelValidation,
  buildShortCircuitStatus as buildShortCircuitStatusHelper,
  roundTimingMs,
  finalizeTimingMetrics,
  cleanupOldLogs,
} from "./helpers.js";

// Status
export { readCronStatusWithHealth } from "./status.js";

// Cleanup
export { runCleanupTasks } from "./cleanup.js";
