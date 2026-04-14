import { httpPost } from "./httpClient.js";
import { getLogger } from "./logger.js";
import dotenv from "dotenv";

dotenv.config();

const logger = getLogger({ scope: "supabase" });

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

export const HAS_SUPABASE = Boolean(SUPABASE_URL && SUPABASE_KEY);

/**
 * Inserts a record into a Supabase table using the REST API.
 * @param {string} table The table name
 * @param {object} payload The data to insert
 * @returns {Promise<boolean>} True if successful
 */
export async function supabaseInsert(table, payload) {
  if (!HAS_SUPABASE) return false;

  const endpoint = `${SUPABASE_URL}/rest/v1/${table}`;
  const config = {
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal", // Don't return the inserted row to save bandwidth
    },
  };

  try {
    await httpPost(endpoint, payload, config);
    return true;
  } catch (err) {
    if (err?.response?.status === 409) {
      // 409 Conflict: Record already exists (Unique constraint violation)
      return false; // This is a normal deduplication block
    }
    logger.warn(
      { table, err: err?.response?.data || err.message },
      "Supabase insert failed",
    );
    return false;
  }
}

/**
 * Validates if the chapter was already sent by checking Supabase synchronously.
 * Note: Since Supabase REST doesn't easily expose an 'INSERT IF NOT EXIST' that returns
 * status without erroring on conflict if we use standard POST, we just try to insert.
 * If it succeeds, it wasn't there. If it fails with 409, it was already there.
 * This acts as an atomic lock if the table has a UNIQUE constraint on (title_key, chapter_key, channel_id).
 */
export async function markChapterSentPermanent(data) {
  if (!HAS_SUPABASE) return true; // Pretend it worked if not configured

  const payload = {
    title_key: data.titleKey,
    chapter_key: data.chapterKey,
    manga_title: data.mangaTitle,
    chapter_text: data.chapterText,
    source: data.source,
    channel_id: data.channelId,
  };

  // We rely on the UNIQUE constraint in Supabase to prevent duplicates
  // If this returns true, the insert succeeded and the chapter was fresh.
  return await supabaseInsert("chapter_history", payload);
}

/**
 * Checks if a chapter was already sent permanently by querying Supabase.
 * Acts as an L2 Cache to prevent Discord spam if Redis is flushed.
 */
export async function checkChapterSentPermanent(titleKey, chapterKey, channelId) {
  if (!HAS_SUPABASE) return false; // If not configured, assume not sent

  const endpoint = `${SUPABASE_URL}/rest/v1/chapter_history?select=id&title_key=eq.${encodeURIComponent(titleKey)}&chapter_key=eq.${encodeURIComponent(chapterKey)}&channel_id=eq.${encodeURIComponent(channelId)}&limit=1`;
  const config = {
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
    },
  };

  try {
    const { default: axios } = await import("axios");
    const res = await axios.get(endpoint, config);
    return res.data && res.data.length > 0;
  } catch (err) {
    logger.warn({ err: err.message }, "Supabase dedupe check failed");
    return false; // Fail open to allow sending if DB is down
  }
}

