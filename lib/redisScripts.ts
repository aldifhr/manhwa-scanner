/**
 * REDIS LUA SCRIPTS
 * These scripts are executed atomically on the Redis server to minimize round-trips 
 * and prevent race conditions during high-concurrency dispatch.
 */

/**
 * Atomically claims a chapter and its duplicate for processing.
 * 
 * ARGS: [nowIso, statusPending, ttlMs, key, duplicateKey]
 * KEYS: [DISPATCH_HISTORY_KEY]
 * 
 * Returns 1 if claimed successfully, 0 otherwise.
 */
export const BATCH_CLAIM_SCRIPT = `
local nowIso = ARGV[1]
local statusPending = ARGV[2]
local ttlMs = tonumber(ARGV[3])
local historyKey = KEYS[1]

-- Primary key: block only on SENT (stale PENDING allows retry via pendingStaleMs logic)
local function is_primary_blocked(k)
    if not k or k == "" then return false end
    local existing = redis.call("HGET", historyKey, k)
    if not existing then return false end
    local ok, data = pcall(cjson.decode, existing)
    if not ok then return false end
    local status = data.s or data.status
    return status == "sent"
end

-- Duplicate (cross-source) key: block on SENT or non-expired PENDING.
-- Prevents a second source from claiming the same chapter while another source
-- has already claimed it and is waiting for QStash delivery.
local function is_duplicate_blocked(k, now)
    if not k or k == "" then return false end
    local existing = redis.call("HGET", historyKey, k)
    if not existing then return false end
    local ok, data = pcall(cjson.decode, existing)
    if not ok then return false end
    local status = data.s or data.status
    if status == "sent" then return true end
    if status == "pending" then
        local e = data.e
        if e then return tonumber(e) > tonumber(now) end
        return true
    end
    return false
end

local nowMs = (redis.call("TIME")[1] * 1000)
if is_primary_blocked(ARGV[4]) then return 0 end
if ARGV[5] ~= "" and is_duplicate_blocked(ARGV[5], nowMs) then return 0 end

local payload = cjson.encode({
    s = statusPending,
    ca = nowIso,
    e = nowMs + ttlMs
})

redis.call("HSET", historyKey, ARGV[4], payload)
redis.call("HPEXPIRE", historyKey, ttlMs, "FIELDS", 1, ARGV[4])

if ARGV[5] ~= "" then
    redis.call("HSET", historyKey, ARGV[5], payload)
    redis.call("HPEXPIRE", historyKey, ttlMs, "FIELDS", 1, ARGV[5])
end

return 1
`;

/**
 * Minifies and saves a successful dispatch.
 * 
 * ARGS: [key, titleKey, nowIso, chapterPayload, recentPayload, historyTtl, recentMax]
 * KEYS: [HISTORY_KEY, UPDATES_KEY, RECENT_KEY]
 */
export const ATOMIC_DISPATCH_SCRIPT = `
local key = ARGV[1]
local titleKey = ARGV[2]
local nowIso = ARGV[3]
local historyPayload = ARGV[4]
local recentPayload = ARGV[5]
local historyTtl = tonumber(ARGV[6])
local recentMax = tonumber(ARGV[7])
local duplicateKey = ARGV[8]
local dupPayload = ARGV[9]
local chapterNum = ARGV[10]

local historyKey = KEYS[1]
local updatesKey = KEYS[2]
local recentKey = KEYS[3]
local lastChaptersKey = KEYS[4]

-- 1. Update History with TTL
redis.call("HSET", historyKey, key, historyPayload)
redis.call("HPEXPIRE", historyKey, historyTtl, "FIELDS", 1, key)

-- 1.1 Update Duplicate Key with TTL
if duplicateKey ~= nil and duplicateKey ~= "" then
    redis.call("HSET", historyKey, duplicateKey, dupPayload)
    redis.call("HPEXPIRE", historyKey, historyTtl, "FIELDS", 1, duplicateKey)
end

-- 2. Update Last Update Time
redis.call("HSET", updatesKey, titleKey, nowIso)

-- 3. Add to Recent ZSET
local score = redis.call("TIME")[1]
redis.call("ZADD", recentKey, score, recentPayload)

-- 4. Trim Recent ZSET
redis.call("ZREMRANGEBYRANK", recentKey, 0, -(recentMax + 1))

-- 5. Update Last Chapter Number (Only if higher)
if lastChaptersKey ~= nil and chapterNum ~= nil and chapterNum ~= "" then
    local currentLast = redis.call("HGET", lastChaptersKey, titleKey)
    if not currentLast or tonumber(chapterNum) > (tonumber(currentLast) or 0) then
        redis.call("HSET", lastChaptersKey, titleKey, chapterNum)
    end
end

return 1
`;

/**
 * Atomically moves a task from pending queue to processing queue.
 * Prevents race conditions where multiple cron jobs claim the same chapter.
 * 
 * ARGS: [taskKey]
 * KEYS: [NOTIFICATION_QUEUE_KEY, NOTIFICATION_PROCESSING_QUEUE_KEY]
 * 
 * Returns 1 if moved successfully, 0 if task not found.
 */
export const ATOMIC_QUEUE_MOVE_SCRIPT = `
local pendingKey = KEYS[1]
local processingKey = KEYS[2]
local taskKey = ARGV[1]

-- Remove from pending queue
local removed = redis.call("LREM", pendingKey, 1, taskKey)

if removed > 0 then
    -- Add to processing queue
    redis.call("RPUSH", processingKey, taskKey)
    redis.call("EXPIRE", processingKey, 60)
    return 1
else
    return 0
end
`;

/**
 * Atomically moves multiple tasks from pending to processing queue in batch.
 * More efficient than calling ATOMIC_QUEUE_MOVE_SCRIPT multiple times.
 * 
 * ARGS: [taskKey1, taskKey2, ...]
 * KEYS: [NOTIFICATION_QUEUE_KEY, NOTIFICATION_PROCESSING_QUEUE_KEY]
 * 
 * Returns number of tasks successfully moved.
 */
export const ATOMIC_BATCH_QUEUE_MOVE_SCRIPT = `
local pendingKey = KEYS[1]
local processingKey = KEYS[2]
local movedCount = 0

for i = 1, #ARGV do
    local taskKey = ARGV[i]
    local removed = redis.call("LREM", pendingKey, 1, taskKey)
    
    if removed > 0 then
        redis.call("RPUSH", processingKey, taskKey)
        movedCount = movedCount + 1
    end
end

if movedCount > 0 then
    redis.call("EXPIRE", processingKey, 60)
end

return movedCount
`;
