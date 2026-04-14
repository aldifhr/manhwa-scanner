import { markChapterSentPermanent, checkChapterSentPermanent } from "../lib/supabase.js";

async function test() {
  console.log("Memulai pengujian koneksi ke Supabase L2 Cache...");

  const mockData = {
    titleKey: "debug-title",
    chapterKey: "debug-chapter-0",
    mangaTitle: "Test Debug Manga",
    chapterText: "Chapter 0 (Test)",
    source: "debug_system",
    channelId: "123456789",
  };

  // 1. Coba Insert (Seharusnya sukses - false konflik)
  const isInserted = await markChapterSentPermanent(mockData);
  console.log("Mock Insert:", isInserted ? "Sukses" : "Gagal/Konflik");

  // 2. Coba Insert Ulang (Seharusnya dicegah - Return false karena unique constraint)
  const isDuplicateDetected = await markChapterSentPermanent(mockData);
  console.log("Dedupe Insert Test:", !isDuplicateDetected ? "Deduplikasi Bekerja" : "Gagal Deduplikasi");

  // 3. Coba Seleksi Query (Seharusnya mereturn TRUE karena dikira sudah sent)
  const checkL2 = await checkChapterSentPermanent(mockData.titleKey, mockData.chapterKey, mockData.channelId);
  console.log("L2 Reader Status:", checkL2 ? "Terdikte (Ditemukan)" : "Tidak Terdikte (Hilang)");

  if (isInserted && (!isDuplicateDetected) && checkL2) {
    console.log("\n✅ SEMUA PENGUJIAN SUPABASE LULUS DENGAN SEMPURNA!");
  } else {
    console.log("\n❌ PENGUJIAN MEMILIKI KENDALA KONEKSI/IZIN.");
  }
}

test().catch(console.error);
