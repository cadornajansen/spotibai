import type { APIRoute } from 'astro';
import { Redis } from '@upstash/redis';
import catalogData from '../../../data/spotify.json';

const VISITOR_COOKIE = 'spotibai_visitor_id';
const songIds = new Set(catalogData.songs.map((song) => song.id));

const toggleLikeScript = `
local liked = redis.call('SISMEMBER', KEYS[2], ARGV[1])
local count = tonumber(redis.call('GET', KEYS[1]) or '0')

if liked == 1 then
  redis.call('SREM', KEYS[2], ARGV[1])
  count = math.max(0, count - 1)
  redis.call('SET', KEYS[1], count)
  return { count, 0 }
end

redis.call('SADD', KEYS[2], ARGV[1])
count = count + 1
redis.call('SET', KEYS[1], count)
return { count, 1 }
`;

const json = (body: object, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
});

const getRedis = () => {
  const url = process.env.UPSTASH_REDIS_REST_URL || import.meta.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || import.meta.env.UPSTASH_REDIS_REST_TOKEN;
  if (url && token) return new Redis({ url, token });
  try {
    return Redis.fromEnv();
  } catch {
    return null;
  }
};

const getVisitorId = (cookies: Parameters<APIRoute>[0]['cookies']) => {
  const existingId = cookies.get(VISITOR_COOKIE)?.value;
  if (existingId) return existingId;

  const visitorId = crypto.randomUUID();
  cookies.set(VISITOR_COOKIE, visitorId, {
    httpOnly: true,
    maxAge: 60 * 60 * 24 * 365,
    path: '/',
    sameSite: 'lax',
    secure: import.meta.env.PROD,
  });
  return visitorId;
};

const getKeys = (songId: string, visitorId: string) => ({
  countKey: `spotibai:likes:${songId}`,
  likedKey: `spotibai:liked:${visitorId}`,
});

const validateSongId = (songId: string | undefined) => Boolean(songId && songIds.has(songId));

export const GET: APIRoute = async ({ params, cookies }) => {
  const { songId } = params;
  if (!validateSongId(songId)) return json({ error: 'Song not found' }, 404);
  const redis = getRedis();
  if (!redis) {
    console.warn('[Likes API] Redis is not configured! Please set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN in Vercel Environment Variables.');
    return json({ count: 0, liked: false, configured: false });
  }

  try {
    const visitorId = getVisitorId(cookies);
    const { countKey, likedKey } = getKeys(songId!, visitorId);
    const [storedCount, liked] = await Promise.all([
      redis.get<number>(countKey),
      redis.sismember(likedKey, songId!),
    ]);
    return json({ count: Math.max(0, Number(storedCount) || 0), liked: Boolean(liked), configured: true });
  } catch (error) {
    console.error('Unable to load song likes', error);
    return json({ error: 'Unable to load likes' }, 503);
  }
};

export const POST: APIRoute = async ({ params, cookies }) => {
  const { songId } = params;
  if (!validateSongId(songId)) return json({ error: 'Song not found' }, 404);
  const redis = getRedis();
  if (!redis) {
    console.warn('[Likes API] Redis is not configured! Please set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN in Vercel Environment Variables.');
    return json({ count: 0, liked: false, configured: false });
  }

  try {
    const visitorId = getVisitorId(cookies);
    const { countKey, likedKey } = getKeys(songId!, visitorId);
    const [count, liked] = await redis.eval<string[], [number, number]>(
      toggleLikeScript,
      [countKey, likedKey],
      [songId!],
    );
    return json({ count: Math.max(0, Number(count) || 0), liked: Boolean(liked), configured: true });
  } catch (error) {
    console.error('Unable to toggle song like', error);
    return json({ error: 'Unable to update likes' }, 503);
  }
};
