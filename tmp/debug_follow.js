import { isUserFollowing, followManga, unfollowManga } from "../lib/services/notifications.js";

async function test() {
  try {
    const userId = "123456789";
    const title = "I Took over The Academy With a Single Sashimi Knife";
    console.log("Checking following status...");
    const following = await isUserFollowing(userId, title);
    console.log("Is Following:", following);
    console.log("Follow Manga...");
    await followManga(userId, title);
    const following2 = await isUserFollowing(userId, title);
    console.log("Is Following 2:", following2);
    await unfollowManga(userId, title);
    process.exit(0);
  } catch (err) {
    console.error("Error:", err);
    process.exit(1);
  }
}

test();
