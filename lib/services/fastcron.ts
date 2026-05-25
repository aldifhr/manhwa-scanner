import { getLogger } from "../logger.js";
import { env } from "../config/env.js";

const logger = getLogger({ scope: "fastcron" });

// FastCron API Configuration
const FASTCRON_API_BASE = "https://app.fastcron.com/api/v1";

/**
 * FastCron cronjob data structure
 */
export interface FastCronJob {
  id: number;
  group: number | null;
  expression: string;
  timezone: string;
  url: string;
  postData: string;
  fail: number;
  status: number; // 0 = active
  name: string;
  notify: boolean;
  points: number;
  timeout?: number;
  httpMethod?: string;
  httpHeaders?: string;
}

/**
 * FastCron execution log result
 */
export interface FastCronExecutionResult {
  result: {
    output: string;
    downloaded: number;
    httpStatus: number;
    error: string;
    time: number; // Unix timestamp
    executionTime: number; // in seconds (decimal)
    status: number; // 0 = success
  };
}

/**
 * Next run info with minutes remaining
 */
export interface NextRunInfo {
  nextRunTimestamp: number;
  nextRunDate: Date;
  minutesRemaining: number;
  formattedTime: string;
}

/**
 * Latest execution info with response time
 */
export interface LatestExecutionInfo {
  lastRunTimestamp: number;
  lastRunDate: Date;
  responseTimeMs: number;
  httpStatus: number;
  success: boolean;
  error?: string;
}

/**
 * Make authenticated request to FastCron API
 */
async function fastCronRequest<T>(
  endpoint: string,
  params: Record<string, string | number>
): Promise<T | null> {
  const token = env.FASTCRON_API_TOKEN;
  if (!token) {
    logger.debug("FastCron API token not configured");
    return null;
  }

  const url = new URL(`${FASTCRON_API_BASE}/${endpoint}`);
  url.searchParams.append("token", token);
  
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null) {
      url.searchParams.append(key, String(value));
    }
  });

  try {
    const response = await fetch(url.toString(), {
      method: "GET",
      headers: {
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      logger.warn({
        endpoint,
        status: response.status,
        statusText: response.statusText,
      }, "FastCron API request failed");
      return null;
    }

    const data = await response.json() as { status?: string; code?: string; message?: string; data?: T };
    
    if (data.status === "error") {
      logger.warn({
        endpoint,
        code: data.code,
        message: data.message,
      }, "FastCron API returned error");
      return null;
    }

    return data.data || (data as T);
  } catch (err: unknown) {
    logger.error({
      endpoint,
      err: err instanceof Error ? err.message : String(err),
    }, "FastCron API request error");
    return null;
  }
}

/**
 * Get cronjob by name or URL pattern
 */
export async function findCronJob(
  pattern: string
): Promise<FastCronJob | null> {
  const jobs = await fastCronRequest<FastCronJob[]>("cron_list", {});
  if (!jobs) return null;

  return jobs.find(
    (job) =>
      job.name.toLowerCase().includes(pattern.toLowerCase()) ||
      job.url.toLowerCase().includes(pattern.toLowerCase())
  ) || null;
}

/**
 * Get next execution times for a cronjob
 */
export async function getCronNextRuns(
  cronId: number,
  limit: number = 1
): Promise<number[] | null> {
  return fastCronRequest<number[]>("cron_next", { id: cronId });
}

/**
 * Calculate next run info with minutes remaining
 */
export function calculateNextRunInfo(
  timestamps: number[] | null
): NextRunInfo | null {
  if (!timestamps || timestamps.length === 0) return null;

  const nextRunTimestamp = timestamps[0];
  const nextRunDate = new Date(nextRunTimestamp * 1000);
  const now = Date.now();
  const diffMs = nextRunDate.getTime() - now;
  const minutesRemaining = Math.max(0, Math.round(diffMs / 60000));

  // Format time based on how far in the future
  let formattedTime: string;
  if (minutesRemaining < 1) {
    formattedTime = "Soon";
  } else if (minutesRemaining < 60) {
    formattedTime = `${minutesRemaining}m`;
  } else if (minutesRemaining < 1440) {
    const hours = Math.floor(minutesRemaining / 60);
    const mins = minutesRemaining % 60;
    formattedTime = mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
  } else {
    const days = Math.floor(minutesRemaining / 1440);
    const hours = Math.floor((minutesRemaining % 1440) / 60);
    formattedTime = hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  }

  return {
    nextRunTimestamp,
    nextRunDate,
    minutesRemaining,
    formattedTime,
  };
}

/**
 * Get latest execution logs for a cronjob
 */
export async function getCronLogs(
  cronId: number,
  limit: number = 1
): Promise<FastCronExecutionResult[] | null> {
  return fastCronRequest<FastCronExecutionResult[]>("cron_logs", {
    id: cronId,
  });
}

/**
 * Get latest execution info with response time
 */
export async function getLatestExecutionInfo(
  cronId: number
): Promise<LatestExecutionInfo | null> {
  const logs = await getCronLogs(cronId, 1);
  if (!logs || logs.length === 0) return null;

  const latest = logs[0];
  const result = latest.result;

  return {
    lastRunTimestamp: result.time,
    lastRunDate: new Date(result.time * 1000),
    responseTimeMs: Math.round(result.executionTime * 1000),
    httpStatus: result.httpStatus,
    success: result.status === 0 && result.httpStatus === 200,
    error: result.error || undefined,
  };
}

/**
 * Get comprehensive cronjob status including next run and latest execution
 */
export interface CronJobStatus {
  job: FastCronJob | null;
  nextRun: NextRunInfo | null;
  latestExecution: LatestExecutionInfo | null;
}

export async function getCronJobStatus(
  pattern: string
): Promise<CronJobStatus> {
  const job = await findCronJob(pattern);
  if (!job) {
    return { job: null, nextRun: null, latestExecution: null };
  }

  const [nextRuns, latestExecution] = await Promise.all([
    getCronNextRuns(job.id),
    getLatestExecutionInfo(job.id),
  ]);

  return {
    job,
    nextRun: calculateNextRunInfo(nextRuns),
    latestExecution,
  };
}

/**
 * Format response time for display (ms or s)
 */
export function formatFastCronResponseTime(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "-";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}
