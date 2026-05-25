import { loadWhitelist } from "../lib/redis.js";

async function dumpWhitelist() {
  try {
    const list = await loadWhitelist();
    console.log(`Total Items: ${list.length}`);
    list.forEach((item, i) => {
      console.log(`${i + 1}. |${item.title}| (Size: ${item.title.length})`);
    });
  } catch (err) {
    console.error(err);
  }
}

dumpWhitelist();
