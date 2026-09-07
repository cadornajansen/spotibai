import { readFile } from "node:fs/promises";
import { Redis } from "@upstash/redis";

try {
  process.loadEnvFile?.(new URL("../../.env", import.meta.url));
} catch {
  // Fall back to environment variables already set
}

const catalogPath = new URL("../data/spotify.json", import.meta.url);
const catalog = JSON.parse(await readFile(catalogPath, "utf8"));
const redis = Redis.fromEnv();

const randomLikes = Object.fromEntries(
  catalog.songs.map((song) => [
    `spotibai:likes:${song.id}`,
    Math.floor(Math.random() * 501) + 500,
  ]),
);

await redis.mset(randomLikes);

console.table(
  catalog.songs.map((song) => ({
    title: song.title,
    likes: randomLikes[`spotibai:likes:${song.id}`],
  })),
);
