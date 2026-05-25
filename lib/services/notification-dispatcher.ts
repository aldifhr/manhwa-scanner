/**
 * Notification Dispatcher - chooses between QStash or direct send
 */

import { isQStashEnabled, publishToQStash, publishBatchToQStash } from "./qstash.js";
import { sendDiscordEmbedsChannelBatch } from "../discord.js";
import { RedisClient } from "../types.js";
import { getLogger } from "../logger.js";

const logger = getLogger({ scope: "notification-dispatcher" });

export interface DispatchTask {
  chapter: {
    title: string;
    chapter: string;
    source: string;
    url: string;
    imageUrl?: string;
    updatedAt?: string;
  };
  channelIds: string[];
  mentions?: string[];
}

export async function dispatchNotification(
  task: DispatchTask,
  redisClient: RedisClient
): Promise<{ success: boolean; via: "qstash" | "direct" }> {
  // Deduplicate channel IDs
  const uniqueChannelIds = [...new Set(task.channelIds)];
  task.channelIds = uniqueChannelIds;

  // If QStash enabled, publish to queue instead of sending directly
  if (isQStashEnabled()) {
    const published = await publishToQStash(task);
    if (published) {
      return { success: true, via: "qstash" };
    }
    logger.warn("QStash publish failed, falling back to direct send");
  }

  // Fallback to direct send
  try {
    for (const channelId of task.channelIds) {
      await sendDiscordEmbedsChannelBatch(
        [task.chapter],
        channelId,
        redisClient,
        task.mentions?.join(" ")
      );
    }
    return { success: true, via: "direct" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err: message, chapter: task.chapter.title }, "Direct send failed");
    return { success: false, via: "direct" };
  }
}

export async function dispatchBatch(
  tasks: DispatchTask[],
  redisClient: RedisClient
): Promise<{ success: number; failed: number; via: "qstash" | "direct" }> {
  if (tasks.length === 0) {
    return { success: 0, failed: 0, via: "direct" };
  }

  // Deduplicate channel IDs for each task
  for (const task of tasks) {
    task.channelIds = [...new Set(task.channelIds)];
  }

  // If QStash enabled, use batch publish
  if (isQStashEnabled()) {
    const published = await publishBatchToQStash(tasks);
    return { 
      success: published, 
      failed: tasks.length - published, 
      via: "qstash" 
    };
  }

  // Fallback to direct send
  let success = 0;
  let failed = 0;

  // Group by channel for efficiency
  const byChannel = new Map<string, DispatchTask[]>();
  for (const task of tasks) {
    for (const channelId of task.channelIds) {
      if (!byChannel.has(channelId)) {
        byChannel.set(channelId, []);
      }
      byChannel.get(channelId)!.push(task);
    }
  }

  for (const [channelId, channelTasks] of byChannel) {
    try {
      const chapters = channelTasks.map(t => t.chapter);
      const mentions = [...new Set(channelTasks.flatMap(t => t.mentions || []))].join(" ");
      
      await sendDiscordEmbedsChannelBatch(
        chapters,
        channelId,
        redisClient,
        mentions || undefined
      );
      success += channelTasks.length;
    } catch (err) {
      logger.error({ channelId, count: channelTasks.length }, "Batch send failed");
      failed += channelTasks.length;
    }
  }

  return { success, failed, via: "direct" };
}