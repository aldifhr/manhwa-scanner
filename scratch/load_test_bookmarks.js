import { followManga, unfollowManga, getMangaSubscribers } from "../lib/services/notifications.js";
import { redis } from "../lib/redis.js";
import { normalizeTitleKey } from "../lib/domain.js";

async function runLoadTest() {
  const TEST_TITLE = "Load Test Manga " + Date.now();
  const titleKey = normalizeTitleKey(TEST_TITLE);
  const NUM_USERS = 20;
  const userIds = Array.from({ length: NUM_USERS }, (_, i) => `user_test_${i}`);

  console.log(`🚀 Memulai Load Test pada: ${TEST_TITLE}`);
  console.log(`👥 Mensimulasikan ${NUM_USERS} user mengklik bookmark secara bersamaan...`);

  // 1. Simulasi Follow Paralel
  console.log("\n--- Tahap 1: Follow Bersamaan ---");
  const followPromises = userIds.map(id => {
    console.log(`[Start] ${id} following...`);
    return followManga(id, TEST_TITLE);
  });

  await Promise.all(followPromises);

  // Verifikasi hasil follow
  const subscribersAfterFollow = await getMangaSubscribers(TEST_TITLE);
  console.log(`✅ Selesai. Total subscriber terdeteksi: ${subscribersAfterFollow.length}`);

  const followSuccess = subscribersAfterFollow.length === NUM_USERS;
  console.log(followSuccess ? "🟢 HASIL: SEMPURNA (Semua user terdaftar)" : "🔴 HASIL: GAGAL (Ada data yang hilang)");

  // 2. Simulasi Campuran (Beberapa unfollow, beberapa follow lagi)
  console.log("\n--- Tahap 2: Operasi Campuran (Race Condition Stress Test) ---");
  const mixedPromises = userIds.map((id, i) => {
    if (i % 2 === 0) {
      console.log(`[Action] ${id} unfollowing...`);
      return unfollowManga(id, TEST_TITLE);
    } else {
      console.log(`[Action] ${id} re-following (no-op)...`);
      return followManga(id, TEST_TITLE);
    }
  });

  await Promise.all(mixedPromises);

  // Verifikasi hasil campuran
  const subscribersAfterMixed = await getMangaSubscribers(TEST_TITLE);
  const expectedCount = NUM_USERS / 2; // Hanya ganjil yang tersisa
  console.log(`✅ Selesai. Total subscriber terdeteksi: ${subscribersAfterMixed.length} (Ekspektasi: ${expectedCount})`);

  const mixedSuccess = subscribersAfterMixed.length === expectedCount;
  console.log(mixedSuccess ? "🟢 HASIL: SEMPURNA (Konsistensi data terjaga)" : "🔴 HASIL: GAGAL (Data tidak konsisten)");

  // Cleanup
  console.log("\n🧹 Membersihkan data test...");
  await redis.del(`manga:subscribers:set:${titleKey}`);
  await Promise.all(userIds.map(id => redis.del(`user:follows:set:${id}`)));
  await redis.zrem("manga:popularity_index", titleKey);

  console.log("🏁 Test Selesai.");
  process.exit(followSuccess && mixedSuccess ? 0 : 1);
}

runLoadTest().catch(err => {
  console.error("❌ Test crashed:", err);
  process.exit(1);
});
