/**
 * Whitelist and storage types
 */

import { z } from "zod";
import {
  WhitelistSourceSchema,
  WhitelistEntrySchema,
  NotificationTaskSchema,
} from "../schemas.js";

/**
 * A source configuration within a whitelist entry
 */
export type WhitelistSource = z.infer<typeof WhitelistSourceSchema>;

/**
 * An entry in the user's manga whitelist
 */
export type WhitelistEntry = z.infer<typeof WhitelistEntrySchema>;

/**
 * A notification task ready to be enqueued
 */
export type NotificationTask = z.infer<typeof NotificationTaskSchema>;
