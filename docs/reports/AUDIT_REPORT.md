# Code Audit Report - Manhwa Scanner

**Date:** May 2, 2026  
**Scope:** Full codebase audit for errors, dead code, and code quality issues  
**Files Analyzed:** 117 TypeScript files in `lib/`

---

## Summary

| Category | Count | Priority |
|----------|-------|----------|
| Potential Runtime Errors | 2 | HIGH |
| Console.log (should use logger) | 20 | MEDIUM |
| Loose Equality (== vs ===) | 90 | MEDIUM |
| Commented Code Blocks | 132 | LOW |
| TODO Comments | 1 | LOW |

**TypeScript Compilation:** ✅ No errors (tsc --noEmit passes)

---

## 1. Potential Runtime Errors (HIGH Priority)

### 1.1 Type Mismatch in `lib/scrapers/ikiru/core.ts`
```
Line 723: Argument of type 'Cheerio<unknown>' is not assignable to parameter of type 'Cheerio<Element>'
Line 728: Type 'string | null' is not assignable to type 'string | undefined'
```
**Fix:** Update `extractStatus()` parameter type or add type guard before calling.

---

## 2. Console.log Statements (MEDIUM Priority)

**Should use structured logger instead of console.log.** Found in 7 files:

### 2.1 `lib/utils/stay-online.ts` (9 matches)
- Line 86: `console.error(`[${timestamp()}] ❌ Request error...`
- Line 117: `console.log(`✅ OK (${result.responseTime}ms)...`
- Line 120: `console.log(`❌ FAIL - Status:...`
- Line 127: `console.log(`\n[${timestamp()}] 📊 Stats:...`
- Line 135-136: `console.log(`\n[${timestamp()}] 🛑 Received...`
- Line 148: `console.log(`╔═══════════════════════════════════════...`
- Line 164: `console.log(`[${timestamp()}] ⏰ Keep-alive...`
- Line 168: `console.error(`Fatal error in keep-alive...`

**Note:** This is a standalone script, console.log may be acceptable here.

### 2.2 `lib/services/dispatch/deduplication.ts` (4 matches)
- Lines with console.log for debugging deduplication logic

### 2.3 `lib/cronLogs.ts` (3 matches)
- Console.log statements for cron logging

### 2.4 Other files (5 matches)
- `lib/config/env.ts`, `lib/logger.ts`, `lib/services/dispatch.ts`, `lib/utils/scraping.ts`

---

## 3. Loose Equality Operators (MEDIUM Priority)

**90 matches across 35 files using `== null` or `== undefined` instead of `===`**

### Top Files:
1. `lib/discord/interactions.ts` (13 matches)
2. `lib/cronLogs.ts` (9 matches)
3. `lib/scrapers/secondary/parser.ts` (5 matches)
4. `lib/utils/type-guards.ts` (5 matches)

**Recommendation:** While `== null` checks both null/undefined, be explicit with `===` for type safety.

---

## 4. Commented Code Blocks (LOW Priority)

**132 matches across 50 files** - Old code commented out instead of removed:

### Top Files:
1. `lib/cronLogs.ts` (9 blocks)
2. `lib/services/dispatch.ts` (7 blocks)
3. `lib/utils/text-safe.ts` (7 blocks)
4. `lib/config/env.ts` (6 blocks)
5. `lib/config/deadlines.ts` (5 blocks)

**Examples:**
```typescript
// Old implementation - kept for reference
// if (oldCondition) { ... }

// TODO: Remove after migration
// const legacyVar = ...
```

---

## 5. TODO/FIXME Comments (LOW Priority)

### 5.1 `lib/scrapers/optimizer.ts` Line 97
```typescript
return {
  inFlight: this.inFlight.size,
  cached: this.cache.size,
  cacheHitRate: 0, // TODO: track hits/misses
};
```

---

## 6. Dead Code Candidates

### 6.1 Unused Imports (Detected via pattern matching)
Common patterns found:
- Imports at top of file with no references
- Barrel exports that re-export non-existent modules

### 6.2 Functions That May Be Unused
Need manual verification for:
- Helper functions in `lib/utils/` 
- Scraper utility functions
- Discord formatting helpers

---

## 7. Quick Fixes Recommended

### Fix 1: Type Errors in core.ts
```typescript
// lib/scrapers/ikiru/core.ts line 723
// Change:
const status = extractStatus($el);
// To:
const status = extractStatus($el as Cheerio<Element>);
```

### Fix 2: Replace console.log with logger
```typescript
// In library code (not stay-online.ts):
console.log(`✅ OK (${result.responseTime}ms)`);
// Should be:
logger.info({ responseTime: result.responseTime }, "Bot is warm");
```

### Fix 3: Remove commented code
```bash
# Find and review all commented code blocks:
grep -n "^\s*//.*\w.*(" lib/**/*.ts | head -50
```

---

## 8. Files Requiring Immediate Attention

| File | Issues | Action |
|------|--------|--------|
| `lib/scrapers/ikiru/core.ts` | Type errors | Fix Cheerio types |
| `lib/utils/stay-online.ts` | console.log | Acceptable (standalone script) |
| `lib/discord/interactions.ts` | 13 loose == | Review for strict equality |
| `lib/cronLogs.ts` | 9 loose == + comments | Clean up |

---

## Appendix: Full File List with Issues

### Console.log files (7):
- lib/utils/stay-online.ts (9)
- lib/services/dispatch/deduplication.ts (4)
- lib/cronLogs.ts (3)
- lib/config/env.ts (1)
- lib/logger.ts (1)
- lib/services/dispatch.ts (1)
- lib/utils/scraping.ts (1)

### Loose equality files (35):
- lib/discord/interactions.ts (13)
- lib/cronLogs.ts (9)
- lib/scrapers/secondary/parser.ts (5)
- lib/utils/type-guards.ts (5)
- lib/services/fastcron.ts (4)
- lib/services/health.ts (4)
- lib/utils/safe-cache.ts (4)
- lib/config/env.ts (3)
- lib/dateUtils.ts (3)
- lib/scrapers/optimizer.ts (3)
- [25 more files with 1-2 matches each]

### Commented code files (50):
- lib/cronLogs.ts (9)
- lib/services/dispatch.ts (7)
- lib/utils/text-safe.ts (7)
- lib/config/env.ts (6)
- lib/services/priority-queue.ts (6)
- [45 more files with 1-5 matches each]

---

**Next Steps:**
1. Fix the 2 type errors in core.ts
2. Review console.log usage in library files
3. Gradually clean up commented code
4. Consider enabling stricter ESLint rules
