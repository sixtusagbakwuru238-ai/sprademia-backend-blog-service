// src/jobs/index.ts
// Background jobs run on intervals within this service process.
// For production at scale, migrate these to a dedicated worker
// using BullMQ (Redis-backed queue) or a separate job runner.

import { prisma } from "../lib/prisma";
import { flushViewBuffer, acquireLock, releaseLock } from "../lib/redis";
import { publish } from "../lib/message-bus";
import type { PostPublishedPayload } from "../types";

// ─────────────────────────────────────────────────────────────────────
// Job 1: Flush buffered view counts to PostgreSQL
// Runs every 5 minutes. Redis buffers individual view increments;
// this job batches them into a single DB update per post.
// ─────────────────────────────────────────────────────────────────────

async function flushViewCounts() {
  const lock = await acquireLock("job:flush-views", 60_000); // 60s lock
  if (!lock) return; // Another instance is already running

  try {
    const buffer = await flushViewBuffer();
    const entries = Object.entries(buffer);

    if (entries.length === 0) return;

    // Batch update all posts in a single transaction
    await prisma.$transaction(
      entries.map(([postId, count]) =>
        prisma.post.update({
          where: { id: postId },
          data: { viewCount: { increment: count } },
        })
      )
    );

    console.info(`[job:flush-views] Flushed ${entries.length} posts, ${
      entries.reduce((s, [, c]) => s + c, 0)
    } total views`);
  } catch (err) {
    console.error("[job:flush-views] Error:", (err as Error).message);
  } finally {
    await releaseLock("job:flush-views", lock);
  }
}

// ─────────────────────────────────────────────────────────────────────
// Job 2: Publish scheduled posts
// Runs every minute. Finds posts with SCHEDULED status whose
// scheduledAt has passed and publishes them.
// ─────────────────────────────────────────────────────────────────────

async function publishScheduledPosts() {
  const lock = await acquireLock("job:publish-scheduled", 30_000);
  if (!lock) return;

  try {
    const due = await prisma.post.findMany({
      where: {
        status: "SCHEDULED",
        scheduledAt: { lte: new Date() },
      },
      select: {
        id: true,
        slug: true,
        title: true,
        authorId: true,
        category: { select: { slug: true } },
        tags: { select: { tag: { select: { slug: true } } } },
      },
    });

    for (const post of due) {
      await prisma.post.update({
        where: { id: post.id },
        data: {
          status: "PUBLISHED",
          publishedAt: new Date(),
          scheduledAt: null,
        },
      });

      await publish<PostPublishedPayload>("blog.post.published", {
        postId: post.id,
        slug: post.slug,
        title: post.title,
        authorId: post.authorId,
        categorySlug: post.category.slug,
        tags: (post.tags as Array<{ tag: { slug: string } }>).map((pt) => pt.tag.slug),
        publishedAt: new Date().toISOString(),
      });

      console.info(`[job:publish-scheduled] Published: ${post.slug}`);
    }
  } catch (err) {
    console.error("[job:publish-scheduled] Error:", (err as Error).message);
  } finally {
    await releaseLock("job:publish-scheduled", lock);
  }
}

// ─────────────────────────────────────────────────────────────────────
// Job 3: Clean up old anonymous view logs (GDPR hygiene)
// Runs daily. Deletes PostView records older than 90 days.
// ─────────────────────────────────────────────────────────────────────

async function cleanOldViewLogs() {
  const lock = await acquireLock("job:clean-views", 120_000);
  if (!lock) return;

  try {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 90);

    const { count } = await prisma.postView.deleteMany({
      where: { createdAt: { lt: cutoff } },
    });

    console.info(`[job:clean-views] Deleted ${count} old view log entries`);
  } catch (err) {
    console.error("[job:clean-views] Error:", (err as Error).message);
  } finally {
    await releaseLock("job:clean-views", lock);
  }
}

// ─────────────────────────────────────────────────────────────────────
// Job runner
// ─────────────────────────────────────────────────────────────────────

const intervals: ReturnType<typeof setInterval>[] = [];

export function startJobs() {
  console.info("[jobs] Starting background jobs");

  // Flush view counts every 5 minutes
  intervals.push(
    setInterval(flushViewCounts, 5 * 60 * 1000)
  );

  // Check for scheduled posts every minute
  intervals.push(
    setInterval(publishScheduledPosts, 60 * 1000)
  );

  // Clean old view logs once per day
  intervals.push(
    setInterval(cleanOldViewLogs, 24 * 60 * 60 * 1000)
  );

  // Run immediately on startup (don't wait for first interval)
  void flushViewCounts();
  void publishScheduledPosts();
}

export function stopJobs() {
  intervals.forEach(clearInterval);
  console.info("[jobs] Background jobs stopped");
}



// // src/jobs/index.ts
// // Background jobs run on intervals within this service process.
// // For production at scale, migrate these to a dedicated worker
// // using BullMQ (Redis-backed queue) or a separate job runner.

// import { prisma } from "../lib/prisma";
// import { flushViewBuffer, acquireLock, releaseLock } from "../lib/redis";
// import { publish } from "../lib/message-bus";
// import type { PostPublishedPayload } from "../types";

// // ─────────────────────────────────────────────────────────────────────
// // Job 1: Flush buffered view counts to PostgreSQL
// // Runs every 5 minutes. Redis buffers individual view increments;
// // this job batches them into a single DB update per post.
// // ─────────────────────────────────────────────────────────────────────

// async function flushViewCounts() {
//   const lock = await acquireLock("job:flush-views", 60_000); // 60s lock
//   if (!lock) return; // Another instance is already running

//   try {
//     const buffer = await flushViewBuffer();
//     const entries = Object.entries(buffer);

//     if (entries.length === 0) return;

//     // Batch update all posts in a single transaction
//     await prisma.$transaction(
//       entries.map(([postId, count]) =>
//         prisma.post.update({
//           where: { id: postId },
//           data: { viewCount: { increment: count } },
//         })
//       )
//     );

//     console.info(`[job:flush-views] Flushed ${entries.length} posts, ${
//       entries.reduce((s, [, c]) => s + c, 0)
//     } total views`);
//   } catch (err) {
//     console.error("[job:flush-views] Error:", (err as Error).message);
//   } finally {
//     await releaseLock("job:flush-views", lock);
//   }
// }

// // ─────────────────────────────────────────────────────────────────────
// // Job 2: Publish scheduled posts
// // Runs every minute. Finds posts with SCHEDULED status whose
// // scheduledAt has passed and publishes them.
// // ─────────────────────────────────────────────────────────────────────

// async function publishScheduledPosts() {
//   const lock = await acquireLock("job:publish-scheduled", 30_000);
//   if (!lock) return;

//   try {
//     const due = await prisma.post.findMany({
//       where: {
//         status: "SCHEDULED",
//         scheduledAt: { lte: new Date() },
//       },
//       select: {
//         id: true,
//         slug: true,
//         title: true,
//         authorId: true,
//         category: { select: { slug: true } },
//         tags: { select: { tag: { select: { slug: true } } } },
//       },
//     });

//     for (const post of due) {
//       await prisma.post.update({
//         where: { id: post.id },
//         data: {
//           status: "PUBLISHED",
//           publishedAt: new Date(),
//           scheduledAt: null,
//         },
//       });

//       await publish<PostPublishedPayload>("blog.post.published", {
//         postId: post.id,
//         slug: post.slug,
//         title: post.title,
//         authorId: post.authorId,
//         categorySlug: post.category.slug,
//         tags: (post.tags as Array<{ tag: { slug: string } }>).map((pt) => pt.tag.slug),
//         publishedAt: new Date().toISOString(),
//       });

//       console.info(`[job:publish-scheduled] Published: ${post.slug}`);
//     }
//   } catch (err) {
//     console.error("[job:publish-scheduled] Error:", (err as Error).message);
//   } finally {
//     await releaseLock("job:publish-scheduled", lock);
//   }
// }

// // ─────────────────────────────────────────────────────────────────────
// // Job 3: Clean up old anonymous view logs (GDPR hygiene)
// // Runs daily. Deletes PostView records older than 90 days.
// // ─────────────────────────────────────────────────────────────────────

// async function cleanOldViewLogs() {
//   const lock = await acquireLock("job:clean-views", 120_000);
//   if (!lock) return;

//   try {
//     const cutoff = new Date();
//     cutoff.setDate(cutoff.getDate() - 90);

//     const { count } = await prisma.postView.deleteMany({
//       where: { createdAt: { lt: cutoff } },
//     });

//     console.info(`[job:clean-views] Deleted ${count} old view log entries`);
//   } catch (err) {
//     console.error("[job:clean-views] Error:", (err as Error).message);
//   } finally {
//     await releaseLock("job:clean-views", lock);
//   }
// }

// // ─────────────────────────────────────────────────────────────────────
// // Job runner
// // ─────────────────────────────────────────────────────────────────────

// const intervals: ReturnType<typeof setInterval>[] = [];

// export function startJobs() {
//   console.info("[jobs] Starting background jobs");

//   // Flush view counts every 5 minutes
//   intervals.push(
//     setInterval(flushViewCounts, 5 * 60 * 1000)
//   );

//   // Check for scheduled posts every minute
//   intervals.push(
//     setInterval(publishScheduledPosts, 60 * 1000)
//   );

//   // Clean old view logs once per day
//   intervals.push(
//     setInterval(cleanOldViewLogs, 24 * 60 * 60 * 1000)
//   );

//   // Run immediately on startup (don't wait for first interval)
//   void flushViewCounts();
//   void publishScheduledPosts();
// }

// export function stopJobs() {
//   intervals.forEach(clearInterval);
//   console.info("[jobs] Background jobs stopped");
// }




// // src/jobs/index.ts
// // Background jobs run on intervals within this service process.
// // For production at scale, migrate these to a dedicated worker
// // using BullMQ (Redis-backed queue) or a separate job runner.

// import { prisma } from "../lib/prisma";
// import { flushViewBuffer, acquireLock, releaseLock } from "../lib/redis";
// import { publish } from "../lib/message-bus";
// import type { PostPublishedPayload } from "../types";

// // ─────────────────────────────────────────────────────────────────────
// // Job 1: Flush buffered view counts to PostgreSQL
// // Runs every 5 minutes. Redis buffers individual view increments;
// // this job batches them into a single DB update per post.
// // ─────────────────────────────────────────────────────────────────────

// async function flushViewCounts() {
//   const lock = await acquireLock("job:flush-views", 60_000); // 60s lock
//   if (!lock) return; // Another instance is already running

//   try {
//     const buffer = await flushViewBuffer();
//     const entries = Object.entries(buffer);

//     if (entries.length === 0) return;

//     // Batch update all posts in a single transaction
//     await prisma.$transaction(
//       entries.map(([postId, count]) =>
//         prisma.post.update({
//           where: { id: postId },
//           data: { viewCount: { increment: count } },
//         })
//       )
//     );

//     console.info(`[job:flush-views] Flushed ${entries.length} posts, ${
//       entries.reduce((s, [, c]) => s + c, 0)
//     } total views`);
//   } catch (err) {
//     console.error("[job:flush-views] Error:", (err as Error).message);
//   } finally {
//     await releaseLock("job:flush-views", lock);
//   }
// }

// // ─────────────────────────────────────────────────────────────────────
// // Job 2: Publish scheduled posts
// // Runs every minute. Finds posts with SCHEDULED status whose
// // scheduledAt has passed and publishes them.
// // ─────────────────────────────────────────────────────────────────────

// async function publishScheduledPosts() {
//   const lock = await acquireLock("job:publish-scheduled", 30_000);
//   if (!lock) return;

//   try {
//     const due = await prisma.post.findMany({
//       where: {
//         status: "SCHEDULED",
//         scheduledAt: { lte: new Date() },
//       },
//       select: {
//         id: true,
//         slug: true,
//         title: true,
//         authorId: true,
//         category: { select: { slug: true } },
//         tags: { select: { tag: { select: { slug: true } } } },
//       },
//     });

//     for (const post of due) {
//       await prisma.post.update({
//         where: { id: post.id },
//         data: {
//           status: "PUBLISHED",
//           publishedAt: new Date(),
//           scheduledAt: null,
//         },
//       });

//       await publish<PostPublishedPayload>("blog.post.published", {
//         postId: post.id,
//         slug: post.slug,
//         title: post.title,
//         authorId: post.authorId,
//         categorySlug: post.category.slug,
//         tags: (post.tags as Array<{ tag: { slug: string } }>).map((pt) => pt.tag.slug),
//         publishedAt: new Date().toISOString(),
//       });

//       console.info(`[job:publish-scheduled] Published: ${post.slug}`);
//     }
//   } catch (err) {
//     console.error("[job:publish-scheduled] Error:", (err as Error).message);
//   } finally {
//     await releaseLock("job:publish-scheduled", lock);
//   }
// }

// // ─────────────────────────────────────────────────────────────────────
// // Job 3: Clean up old anonymous view logs (GDPR hygiene)
// // Runs daily. Deletes PostView records older than 90 days.
// // ─────────────────────────────────────────────────────────────────────

// async function cleanOldViewLogs() {
//   const lock = await acquireLock("job:clean-views", 120_000);
//   if (!lock) return;

//   try {
//     const cutoff = new Date();
//     cutoff.setDate(cutoff.getDate() - 90);

//     const { count } = await prisma.postView.deleteMany({
//       where: { createdAt: { lt: cutoff } },
//     });

//     console.info(`[job:clean-views] Deleted ${count} old view log entries`);
//   } catch (err) {
//     console.error("[job:clean-views] Error:", (err as Error).message);
//   } finally {
//     await releaseLock("job:clean-views", lock);
//   }
// }

// // ─────────────────────────────────────────────────────────────────────
// // Job runner
// // ─────────────────────────────────────────────────────────────────────

// const intervals: ReturnType<typeof setInterval>[] = [];

// export function startJobs() {
//   console.info("[jobs] Starting background jobs");

//   // Flush view counts every 5 minutes
//   intervals.push(
//     setInterval(flushViewCounts, 5 * 60 * 1000)
//   );

//   // Check for scheduled posts every minute
//   intervals.push(
//     setInterval(publishScheduledPosts, 60 * 1000)
//   );

//   // Clean old view logs once per day
//   intervals.push(
//     setInterval(cleanOldViewLogs, 24 * 60 * 60 * 1000)
//   );

//   // Run immediately on startup (don't wait for first interval)
//   void flushViewCounts();
//   void publishScheduledPosts();
// }

// export function stopJobs() {
//   intervals.forEach(clearInterval);
//   console.info("[jobs] Background jobs stopped");
// }