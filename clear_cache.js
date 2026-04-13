import { redis } from "./lib/redis.js";

async function clear() {
  console.log("Clearing dispatch history for Chapter 18, 19, 20...");

  const keys = [
    "chapter:dedupe:only i have an ex grade summon:num:18",
    "chapter:dedupe:only i have an ex grade summon:num:19",
    "chapter:dedupe:only i have an ex grade summon:num:20",
    "chapter:https://d.shinigami.asia/chapter/d94083aa-a1cc-48c3-b062-c0e4ef4ea3e8/",
    "chapter:https://02.ikiru.wtf/manga/only-i-have-an-ex-grade-summon/chapter-18.833037/",
    "chapter:https://d.shinigami.asia/chapter/161dfa78-b613-43de-a4bd-54060ae1e60e/",
    "chapter:https://02.ikiru.wtf/manga/only-i-have-an-ex-grade-summon/chapter-19.833040/",
    "chapter:https://d.shinigami.asia/chapter/8a35f428-6962-4d39-b33b-33ee17160791/",
    "chapter:https://02.ikiru.wtf/manga/only-i-have-an-ex-grade-summon/chapter-20.833043/",
  ];

  for (const k of keys) {
    await redis.hdel("dispatch:history", k);
    console.log(`Deleted: ${k}`);
  }

  console.log("Done");
  process.exit(0);
}

clear();
