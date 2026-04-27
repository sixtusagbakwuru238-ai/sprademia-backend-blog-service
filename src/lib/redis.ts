// src/lib/redis.ts
// Ioredis client + typed cache helpers.
// Used for response caching, rate limiting, and distributed locking.

import Redis from "ioredis";
import { config } from "../config";

export const redis = new Redis(config.REDIS_URL, {
  maxRetriesPerRequest: 3,
  enableReadyCheck: true,
  lazyConnect: true,
});

redis.on("error", (err) => {
  console.error("[Redis] Connection error:", err.message);
});

// ─────────────────────────────────────────────────────────────────────
// Cache helpers
// ─────────────────────────────────────────────────────────────────────

export const CacheKeys = {
  post:         (slug: string)         => `blog:post:${slug}`,
  posts:        (params: string)       => `blog:posts:${params}`,
  category:     (slug: string)         => `blog:category:${slug}`,
  categories:   ()                     => "blog:categories:all",
  tag:          (slug: string)         => `blog:tag:${slug}`,
  tags:         ()                     => "blog:tags:all",
  popularTags:  ()                     => "blog:tags:popular",
  postComments: (postId: string, p: number) => `blog:comments:${postId}:${p}`,
  search:       (q: string)            => `blog:search:${Buffer.from(q).toString("base64")}`,
  postStats:    (postId: string)       => `blog:stats:${postId}`,
} as const;

export async function cacheGet<T>(key: string): Promise<T | null> {
  const raw = await redis.get(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export async function cacheSet<T>(
  key: string,
  value: T,
  ttlSeconds: number
): Promise<void> {
  await redis.setex(key, ttlSeconds, JSON.stringify(value));
}

export async function cacheDelete(key: string): Promise<void> {
  await redis.del(key);
}

/** Delete all keys matching a pattern — use sparingly, O(N) */
export async function cacheDeletePattern(pattern: string): Promise<void> {
  const keys = await redis.keys(pattern);
  if (keys.length > 0) {
    await redis.del(...keys);
  }
}

// ─────────────────────────────────────────────────────────────────────
// Distributed lock (for counter flush jobs)
// ─────────────────────────────────────────────────────────────────────

export async function acquireLock(
  resource: string,
  ttlMs: number
): Promise<string | null> {
  const token = `${Date.now()}-${Math.random()}`;
  const key = `lock:${resource}`;
  const result = await redis.set(key, token, "PX", ttlMs, "NX");
  return result === "OK" ? token : null;
}

export async function releaseLock(
  resource: string,
  token: string
): Promise<void> {
  const key = `lock:${resource}`;
  const current = await redis.get(key);
  if (current === token) {
    await redis.del(key);
  }
}

// ─────────────────────────────────────────────────────────────────────
// View counter (buffered — flushed to DB every 5 minutes by a job)
// ─────────────────────────────────────────────────────────────────────

export async function incrementPostViewBuffer(postId: string): Promise<void> {
  await redis.hincrby("blog:view_buffer", postId, 1);
}

export async function flushViewBuffer(): Promise<Record<string, number>> {
  const data = await redis.hgetall("blog:view_buffer");
  if (Object.keys(data).length > 0) {
    await redis.del("blog:view_buffer");
  }
  return Object.fromEntries(
    Object.entries(data).map(([k, v]) => [k, parseInt(v, 10)])
  );
}




// // src/lib/redis.ts
// // Ioredis client + typed cache helpers.
// // Used for response caching, rate limiting, and distributed locking.

// import Redis from "ioredis";
// import { config } from "../config";

// export const redis = new Redis(config.REDIS_URL, {
//   maxRetriesPerRequest: 3,
//   enableReadyCheck: true,
//   lazyConnect: true,
// });

// redis.on("error", (err) => {
//   console.error("[Redis] Connection error:", err.message);
// });

// // ─────────────────────────────────────────────────────────────────────
// // Cache helpers
// // ─────────────────────────────────────────────────────────────────────

// export const CacheKeys = {
//   post:         (slug: string)         => `blog:post:${slug}`,
//   posts:        (params: string)       => `blog:posts:${params}`,
//   category:     (slug: string)         => `blog:category:${slug}`,
//   categories:   ()                     => "blog:categories:all",
//   tag:          (slug: string)         => `blog:tag:${slug}`,
//   tags:         ()                     => "blog:tags:all",
//   popularTags:  ()                     => "blog:tags:popular",
//   postComments: (postId: string, p: number) => `blog:comments:${postId}:${p}`,
//   search:       (q: string)            => `blog:search:${Buffer.from(q).toString("base64")}`,
//   postStats:    (postId: string)       => `blog:stats:${postId}`,
// } as const;

// export async function cacheGet<T>(key: string): Promise<T | null> {
//   const raw = await redis.get(key);
//   if (!raw) return null;
//   try {
//     return JSON.parse(raw) as T;
//   } catch {
//     return null;
//   }
// }

// export async function cacheSet<T>(
//   key: string,
//   value: T,
//   ttlSeconds: number
// ): Promise<void> {
//   await redis.setex(key, ttlSeconds, JSON.stringify(value));
// }

// export async function cacheDelete(key: string): Promise<void> {
//   await redis.del(key);
// }

// /** Delete all keys matching a pattern — use sparingly, O(N) */
// export async function cacheDeletePattern(pattern: string): Promise<void> {
//   const keys = await redis.keys(pattern);
//   if (keys.length > 0) {
//     await redis.del(...keys);
//   }
// }

// // ─────────────────────────────────────────────────────────────────────
// // Distributed lock (for counter flush jobs)
// // ─────────────────────────────────────────────────────────────────────

// export async function acquireLock(
//   resource: string,
//   ttlMs: number
// ): Promise<string | null> {
//   const token = `${Date.now()}-${Math.random()}`;
//   const key = `lock:${resource}`;
//   const result = await redis.set(key, token, "PX", ttlMs, "NX");
//   return result === "OK" ? token : null;
// }

// export async function releaseLock(
//   resource: string,
//   token: string
// ): Promise<void> {
//   const key = `lock:${resource}`;
//   const current = await redis.get(key);
//   if (current === token) {
//     await redis.del(key);
//   }
// }

// // ─────────────────────────────────────────────────────────────────────
// // View counter (buffered — flushed to DB every 5 minutes by a job)
// // ─────────────────────────────────────────────────────────────────────

// export async function incrementPostViewBuffer(postId: string): Promise<void> {
//   await redis.hincrby("blog:view_buffer", postId, 1);
// }

// export async function flushViewBuffer(): Promise<Record<string, number>> {
//   const data = await redis.hgetall("blog:view_buffer");
//   if (Object.keys(data).length > 0) {
//     await redis.del("blog:view_buffer");
//   }
//   return Object.fromEntries(
//     Object.entries(data).map(([k, v]) => [k, parseInt(v, 10)])
//   );
// }



// // src/lib/redis.ts
// // Ioredis client + typed cache helpers.
// // Used for response caching, rate limiting, and distributed locking.

// import Redis from "ioredis";
// import { config } from "../config";

// export const redis = new Redis(config.REDIS_URL, {
//   maxRetriesPerRequest: 3,
//   enableReadyCheck: true,
//   lazyConnect: true,
// });

// redis.on("error", (err) => {
//   console.error("[Redis] Connection error:", err.message);
// });

// // ─────────────────────────────────────────────────────────────────────
// // Cache helpers
// // ─────────────────────────────────────────────────────────────────────

// export const CacheKeys = {
//   post:         (slug: string)         => `blog:post:${slug}`,
//   posts:        (params: string)       => `blog:posts:${params}`,
//   category:     (slug: string)         => `blog:category:${slug}`,
//   categories:   ()                     => "blog:categories:all",
//   tag:          (slug: string)         => `blog:tag:${slug}`,
//   tags:         ()                     => "blog:tags:all",
//   popularTags:  ()                     => "blog:tags:popular",
//   postComments: (postId: string, p: number) => `blog:comments:${postId}:${p}`,
//   search:       (q: string)            => `blog:search:${Buffer.from(q).toString("base64")}`,
//   postStats:    (postId: string)       => `blog:stats:${postId}`,
// } as const;

// export async function cacheGet<T>(key: string): Promise<T | null> {
//   const raw = await redis.get(key);
//   if (!raw) return null;
//   try {
//     return JSON.parse(raw) as T;
//   } catch {
//     return null;
//   }
// }

// export async function cacheSet<T>(
//   key: string,
//   value: T,
//   ttlSeconds: number
// ): Promise<void> {
//   await redis.setex(key, ttlSeconds, JSON.stringify(value));
// }

// export async function cacheDelete(key: string): Promise<void> {
//   await redis.del(key);
// }

// /** Delete all keys matching a pattern — use sparingly, O(N) */
// export async function cacheDeletePattern(pattern: string): Promise<void> {
//   const keys = await redis.keys(pattern);
//   if (keys.length > 0) {
//     await redis.del(...keys);
//   }
// }

// // ─────────────────────────────────────────────────────────────────────
// // Distributed lock (for counter flush jobs)
// // ─────────────────────────────────────────────────────────────────────

// export async function acquireLock(
//   resource: string,
//   ttlMs: number
// ): Promise<string | null> {
//   const token = `${Date.now()}-${Math.random()}`;
//   const key = `lock:${resource}`;
//   const result = await redis.set(key, token, "PX", ttlMs, "NX");
//   return result === "OK" ? token : null;
// }

// export async function releaseLock(
//   resource: string,
//   token: string
// ): Promise<void> {
//   const key = `lock:${resource}`;
//   const current = await redis.get(key);
//   if (current === token) {
//     await redis.del(key);
//   }
// }

// // ─────────────────────────────────────────────────────────────────────
// // View counter (buffered — flushed to DB every 5 minutes by a job)
// // ─────────────────────────────────────────────────────────────────────

// export async function incrementPostViewBuffer(postId: string): Promise<void> {
//   await redis.hincrby("blog:view_buffer", postId, 1);
// }

// export async function flushViewBuffer(): Promise<Record<string, number>> {
//   const data = await redis.hgetall("blog:view_buffer");
//   if (Object.keys(data).length > 0) {
//     await redis.del("blog:view_buffer");
//   }
//   return Object.fromEntries(
//     Object.entries(data).map(([k, v]) => [k, parseInt(v, 10)])
//   );
// }