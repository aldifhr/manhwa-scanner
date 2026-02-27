import { Redis } from "@upstash/redis";
import * as dotenv from "dotenv";
dotenv.config({ path: ".env" });

// 🔹 Upstash Redis client
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// 🔹 List manga
const mangaList = [
  "Hello? Veterinarian!",
  "Woojin Si Detektif Jenius",
  "I Am With the Music Immortals",
  "High School Musical Genius Is Paganini Reincarnated",
  "The Sword God From A Fallen World",
  "Hunter World's Gardener",
  "Pick Me Up (Infinite Gacha)",
  "I Killed an Academy Player",
  "The Concept-Grasping Magical Genius",
  "Absolute Regression",
  "Resurrection of the Catastrophic Hero",
  "Omniscient Reader's Viewpoint",
  "Return of the Devourer",
  "Full Time Awakening",
  "This Is the Law",
  "The Regressed Mercenary's Machinations",
  "Heavenly Demon Tavern",
  "Regressing As The Reincarnated Bastard Of The Sword Clan",
  "Ranker's Return (Remake)",
  "Reincarnation of the Fist King",
  "Unparalleled Rank Hidden Equipment",
  "Myst, Might, Mayhem: Legend of Heavenly Chaos Demon",
  "The Novel's Extra (Remake)",
  "I Start With 13 Hidden Traits",
  "Becoming a Legendary Ace Employee",
  "S-Class Hunter Heals With Monsters",
  "Player Who Returned 10,000 Years Later",
  "Mount Hua Sect's Genius Phantom Swordsman",
  "The Great Heavenly Demon Sovereign",
  "The Demon God",
  "My Bias Gets On The Last Train",
  "Surviving As a Genius On Borrowed Time",
  "I'm Being Misunderstood As a Soccer Genius",
  "The Heavenly Demon Wants a Quiet Life",
  "Overlord of Sichuan",
  "Chronicles of the Lazy Sovereign",
  "Return of the Sword God Rank Civil Servant",
  "The Crazy Genius Composer Returns",
  "Magic Academy's Genius Blinker",
  "The Legendary Hero Is An Academy Honors Student",
  "I Took Over the Academy With a Single Sashimi Knife",
  "Healing Life Through Camping in Another World",
  "After Rebirth I Used Mirror Reversal For Vengeance",
  "Became The Patron Of Villains",
  "Absolute Sword Sense",
  "The Investor Who Sees The Future",
  "NPC Yang Regresi Menjadi Jenius",
  "Mia Has Returned",
  "Petualangan Kim Ohjin Bersama Hewan-Hewan Aneh",
  "Lookism",
  "Nano Machine",
  "The Absolute Scholar",
  "Reborn Rich",
  "Star-Embracing Swordmaster",
  "The Crown Prince That Sells Medicine",
];

// 🔹 Utility: buat slug URL aman
function makeSlug(title) {
  return title
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "") // hapus karakter non-alphanumeric
    .replace(/\s+/g, "-");    // ganti spasi jadi "-"
}

async function bulkAdd() {
  try {
    // 🔹 Ambil data lama dari Redis
    const existing = await redis.get("whitelist:manga");
    let whitelist = [];

    if (existing) {
      try {
        whitelist = typeof existing === "string" ? JSON.parse(existing) : existing;
      } catch {
        whitelist = [];
      }
    }

    let added = 0;
    let skipped = 0;

    for (const title of mangaList) {
      const url = `https://02.ikiru.wtf/manga/${makeSlug(title)}/`;

      // cek duplikat berdasarkan title
      if (whitelist.some((t) => t.title && t.title.toLowerCase() === title.toLowerCase())) {
        console.log(`⏭️  Skip: ${title}`);
        skipped++;
      } else {
        whitelist.push({ title, url });
        console.log(`✅ Added: ${title}`);
        added++;
      }
    }

    // 🔹 Simpan kembali ke Redis
    await redis.set("whitelist:manga", JSON.stringify(whitelist));

    console.log(`\n🎉 Done! Added: ${added} | Skipped: ${skipped} | Total: ${whitelist.length}`);
  } catch (err) {
    console.error("❌ bulkAdd error:", err);
  }
}

bulkAdd();