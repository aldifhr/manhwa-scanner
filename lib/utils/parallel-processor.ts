/**
 * Advanced Parallel Processing Optimization
 * Worker pool pattern, task scheduling, and load balancing
 */

import { getLogger } from "../logger.js";
import pLimit from "p-limit";

const logger = getLogger({ scope: "parallel-processor" });

/**
 * Task priority levels
 */
export enum TaskPriority {
  CRITICAL = 0,
  HIGH = 1,
  NORMAL = 2,
  LOW = 3,
}

/**
 * Task interface
 */
export interface Task<T = any> {
  id: string;
  priority: TaskPriority;
  fn: () => Promise<T>;
  timeout?: number;
  retries?: number;
}

/**
 * Task result
 */
export interface TaskResult<T = any> {
  id: string;
  success: boolean;
  data?: T;
  error?: string;
  duration: number;
  retries: number;
}

/**
 * Worker pool for parallel task execution
 */
export class WorkerPool<T = any> {
  private concurrency: number;
  private queue: Task<T>[];
  private running: number;
  private limiter: ReturnType<typeof pLimit>;
  private results: Map<string, TaskResult<T>>;
  private stats: {
    completed: number;
    failed: number;
    totalDuration: number;
  };

  constructor(concurrency: number = 5) {
    this.concurrency = concurrency;
    this.queue = [];
    this.running = 0;
    this.limiter = pLimit(concurrency);
    this.results = new Map();
    this.stats = {
      completed: 0,
      failed: 0,
      totalDuration: 0,
    };
  }

  /**
   * Add task to queue
   */
  addTask(task: Task<T>): void {
    this.queue.push(task);
    // Sort by priority (lower number = higher priority)
    this.queue.sort((a, b) => a.priority - b.priority);
  }

  /**
   * Add multiple tasks
   */
  addTasks(tasks: Task<T>[]): void {
    tasks.forEach(task => this.addTask(task));
  }

  /**
   * Execute all tasks in parallel with priority
   */
  async executeAll(): Promise<TaskResult<T>[]> {
    if (this.queue.length === 0) {
      return [];
    }

    logger.info(
      { 
        queueSize: this.queue.length, 
        concurrency: this.concurrency 
      },
      "Starting parallel execution"
    );

    const promises = this.queue.map(task => 
      this.limiter(() => this.executeTask(task))
    );

    const results = await Promise.all(promises);
    
    logger.info(
      {
        completed: this.stats.completed,
        failed: this.stats.failed,
        avgDuration: this.stats.totalDuration / (this.stats.completed + this.stats.failed),
      },
      "Parallel execution completed"
    );

    return results;
  }

  /**
   * Execute single task with retry logic
   */
  private async executeTask(task: Task<T>): Promise<TaskResult<T>> {
    const startTime = Date.now();
    let retries = 0;
    const maxRetries = task.retries || 0;

    while (retries <= maxRetries) {
      try {
        this.running++;
        
        // Execute with timeout if specified
        const data = task.timeout
          ? await this.executeWithTimeout(task.fn, task.timeout)
          : await task.fn();

        const duration = Date.now() - startTime;
        
        this.stats.completed++;
        this.stats.totalDuration += duration;
        this.running--;

        const result: TaskResult<T> = {
          id: task.id,
          success: true,
          data,
          duration,
          retries,
        };

        this.results.set(task.id, result);
        return result;

      } catch (error) {
        retries++;
        
        if (retries > maxRetries) {
          const duration = Date.now() - startTime;
          
          this.stats.failed++;
          this.stats.totalDuration += duration;
          this.running--;

          const result: TaskResult<T> = {
            id: task.id,
            success: false,
            error: error instanceof Error ? error.message : String(error),
            duration,
            retries: retries - 1,
          };

          this.results.set(task.id, result);
          
          logger.warn(
            { taskId: task.id, error: result.error, retries: retries - 1 },
            "Task failed after retries"
          );

          return result;
        }

        // Wait before retry with exponential backoff
        const backoff = Math.min(1000 * Math.pow(2, retries - 1), 5000);
        await new Promise(resolve => setTimeout(resolve, backoff));
      }
    }

    // Should never reach here
    throw new Error("Unexpected task execution state");
  }

  /**
   * Execute function with timeout
   */
  private async executeWithTimeout<R>(
    fn: () => Promise<R>,
    timeoutMs: number
  ): Promise<R> {
    return Promise.race([
      fn(),
      new Promise<R>((_, reject) =>
        setTimeout(() => reject(new Error("Task timeout")), timeoutMs)
      ),
    ]);
  }

  /**
   * Get task result by ID
   */
  getResult(taskId: string): TaskResult<T> | undefined {
    return this.results.get(taskId);
  }

  /**
   * Get all results
   */
  getAllResults(): TaskResult<T>[] {
    return Array.from(this.results.values());
  }

  /**
   * Get statistics
   */
  getStats() {
    return {
      ...this.stats,
      queueSize: this.queue.length,
      running: this.running,
      successRate: this.stats.completed / (this.stats.completed + this.stats.failed),
    };
  }

  /**
   * Clear queue and results
   */
  clear(): void {
    this.queue = [];
    this.results.clear();
    this.stats = {
      completed: 0,
      failed: 0,
      totalDuration: 0,
    };
  }

  /**
   * Update concurrency dynamically
   */
  setConcurrency(concurrency: number): void {
    this.concurrency = concurrency;
    this.limiter = pLimit(concurrency);
    logger.info({ concurrency }, "Updated worker pool concurrency");
  }
}

/**
 * Batch processor for processing items in parallel batches
 */
export class BatchProcessor<T, R> {
  private batchSize: number;
  private concurrency: number;
  private processor: (batch: T[]) => Promise<R[]>;

  constructor(
    batchSize: number,
    concurrency: number,
    processor: (batch: T[]) => Promise<R[]>
  ) {
    this.batchSize = batchSize;
    this.concurrency = concurrency;
    this.processor = processor;
  }

  /**
   * Process items in parallel batches
   */
  async process(items: T[]): Promise<R[]> {
    if (items.length === 0) {
      return [];
    }

    // Split into batches
    const batches: T[][] = [];
    for (let i = 0; i < items.length; i += this.batchSize) {
      batches.push(items.slice(i, i + this.batchSize));
    }

    logger.info(
      { 
        totalItems: items.length, 
        batches: batches.length, 
        batchSize: this.batchSize,
        concurrency: this.concurrency 
      },
      "Starting batch processing"
    );

    // Process batches in parallel
    const limit = pLimit(this.concurrency);
    const results = await Promise.all(
      batches.map((batch, index) =>
        limit(async () => {
          const startTime = Date.now();
          try {
            const result = await this.processor(batch);
            const duration = Date.now() - startTime;
            
            logger.debug(
              { batchIndex: index, items: batch.length, duration },
              "Batch processed"
            );
            
            return result;
          } catch (error) {
            logger.error(
              { 
                batchIndex: index, 
                items: batch.length, 
                error: error instanceof Error ? error.message : String(error) 
              },
              "Batch processing failed"
            );
            return [];
          }
        })
      )
    );

    // Flatten results
    return results.flat();
  }
}

/**
 * Load balancer for distributing tasks across workers
 */
export class LoadBalancer<T = any> {
  private workers: WorkerPool<T>[];
  private currentWorkerIndex: number;

  constructor(workerCount: number, concurrencyPerWorker: number) {
    this.workers = Array.from(
      { length: workerCount },
      () => new WorkerPool<T>(concurrencyPerWorker)
    );
    this.currentWorkerIndex = 0;
  }

  /**
   * Add task to least loaded worker
   */
  addTask(task: Task<T>): void {
    // Find worker with smallest queue
    const worker = this.workers.reduce((min, current) => {
      const minStats = min.getStats();
      const currentStats = current.getStats();
      return currentStats.queueSize < minStats.queueSize ? current : min;
    });

    worker.addTask(task);
  }

  /**
   * Add tasks with round-robin distribution
   */
  addTasksRoundRobin(tasks: Task<T>[]): void {
    tasks.forEach(task => {
      this.workers[this.currentWorkerIndex].addTask(task);
      this.currentWorkerIndex = (this.currentWorkerIndex + 1) % this.workers.length;
    });
  }

  /**
   * Execute all tasks across all workers
   */
  async executeAll(): Promise<TaskResult<T>[]> {
    const results = await Promise.all(
      this.workers.map(worker => worker.executeAll())
    );

    return results.flat();
  }

  /**
   * Get combined statistics
   */
  getStats() {
    const allStats = this.workers.map(w => w.getStats());
    
    return {
      workers: allStats.length,
      totalCompleted: allStats.reduce((sum, s) => sum + s.completed, 0),
      totalFailed: allStats.reduce((sum, s) => sum + s.failed, 0),
      totalQueueSize: allStats.reduce((sum, s) => sum + s.queueSize, 0),
      avgSuccessRate: allStats.reduce((sum, s) => sum + s.successRate, 0) / allStats.length,
    };
  }

  /**
   * Clear all workers
   */
  clear(): void {
    this.workers.forEach(w => w.clear());
  }
}

/**
 * Global worker pool instance
 */
export const globalWorkerPool = new WorkerPool(5);

/**
 * Helper function to execute tasks in parallel with priority
 */
export async function executeParallel<T>(
  tasks: Task<T>[],
  concurrency: number = 5
): Promise<TaskResult<T>[]> {
  const pool = new WorkerPool<T>(concurrency);
  pool.addTasks(tasks);
  return pool.executeAll();
}

/**
 * Helper function to process items in batches
 */
export async function processBatch<T, R>(
  items: T[],
  processor: (batch: T[]) => Promise<R[]>,
  batchSize: number = 10,
  concurrency: number = 3
): Promise<R[]> {
  const batchProcessor = new BatchProcessor(batchSize, concurrency, processor);
  return batchProcessor.process(items);
}
