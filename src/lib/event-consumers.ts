// src/lib/event-consumers.ts
// Subscribe to events published by other microservices.
// This module sets up all RabbitMQ consumers for this service.

import { subscribe } from "./message-bus";
import { AuthorsService } from "../modules/authors";

// ─────────────────────────────────────────────────────────────────────
// Consume: user.profile.updated (from Auth/User service)
// Keeps the local author shadow table in sync.
// ─────────────────────────────────────────────────────────────────────

async function handleUserProfileUpdated(content: unknown) {
  const event = content as {
    payload: {
      id: string;
      displayName: string;
      avatarUrl?: string | null;
      bio?: string | null;
      school?: string | null;
      role?: string | null;
      twitterHandle?: string | null;
      verified?: boolean;
    };
  };

  const { payload } = event;
  if (!payload?.id) return;

  await AuthorsService.upsert({
    id:            payload.id,
    displayName:   payload.displayName,
    avatarUrl:     payload.avatarUrl,
    bio:           payload.bio,
    school:        payload.school,
    role:          payload.role,
    twitterHandle: payload.twitterHandle,
    gradient:      payload.gradient,
    verified:      payload.verified ?? false,
  });

  console.info(`[event] Synced author profile: ${payload.id}`);
}

// ─────────────────────────────────────────────────────────────────────
// Consume: user.account.deleted (from Auth service)
// Anonymise posts and comments when a user deletes their account.
// ─────────────────────────────────────────────────────────────────────

async function handleUserDeleted(content: unknown) {
  const event = content as { payload: { userId: string } };
  const userId = event?.payload?.userId;
  if (!userId) return;

  const { prisma } = await import("./prisma");

  // Soft-delete: replace identifying data with "[deleted]"
  await prisma.$transaction([
    prisma.comment.updateMany({
      where: { authorId: userId },
      data: { authorId: "deleted", body: "[deleted]", status: "DELETED" },
    }),
    // Posts are archived, not deleted — preserve content
    prisma.post.updateMany({
      where: { authorId: userId },
      data: { status: "ARCHIVED" },
    }),
  ]);

  console.info(`[event] Anonymised data for deleted user: ${userId}`);
}

// ─────────────────────────────────────────────────────────────────────
// Register all consumers
// ─────────────────────────────────────────────────────────────────────

export async function registerEventConsumers() {
  await subscribe(
    "blog-service.user.profile.updated",
    "user.profile.updated",
    handleUserProfileUpdated
  );

  await subscribe(
    "blog-service.user.account.deleted",
    "user.account.deleted",
    handleUserDeleted
  );

  console.info("[event-consumers] All consumers registered");
}




// // src/lib/event-consumers.ts
// // Subscribe to events published by other microservices.
// // This module sets up all RabbitMQ consumers for this service.

// import { subscribe } from "./message-bus";
// import { AuthorsService } from "../modules/authors";

// // ─────────────────────────────────────────────────────────────────────
// // Consume: user.profile.updated (from Auth/User service)
// // Keeps the local author shadow table in sync.
// // ─────────────────────────────────────────────────────────────────────

// async function handleUserProfileUpdated(content: unknown) {
//   const event = content as {
//     payload: {
//       id: string;
//       displayName: string;
//       avatarUrl?: string | null;
//       bio?: string | null;
//       school?: string | null;
//       role?: string | null;
//       twitterHandle?: string | null;
//       verified?: boolean;
//     };
//   };

//   const { payload } = event;
//   if (!payload?.id) return;

//   await AuthorsService.upsert({
//     id:            payload.id,
//     displayName:   payload.displayName,
//     avatarUrl:     payload.avatarUrl,
//     bio:           payload.bio,
//     school:        payload.school,
//     role:          payload.role,
//     twitterHandle: payload.twitterHandle,
//     gradient:      payload.gradient,
//     verified:      payload.verified ?? false,
//   });

//   console.info(`[event] Synced author profile: ${payload.id}`);
// }

// // ─────────────────────────────────────────────────────────────────────
// // Consume: user.account.deleted (from Auth service)
// // Anonymise posts and comments when a user deletes their account.
// // ─────────────────────────────────────────────────────────────────────

// async function handleUserDeleted(content: unknown) {
//   const event = content as { payload: { userId: string } };
//   const userId = event?.payload?.userId;
//   if (!userId) return;

//   const { prisma } = await import("./prisma");

//   // Soft-delete: replace identifying data with "[deleted]"
//   await prisma.$transaction([
//     prisma.comment.updateMany({
//       where: { authorId: userId },
//       data: { authorId: "deleted", body: "[deleted]", status: "DELETED" },
//     }),
//     // Posts are archived, not deleted — preserve content
//     prisma.post.updateMany({
//       where: { authorId: userId },
//       data: { status: "ARCHIVED" },
//     }),
//   ]);

//   console.info(`[event] Anonymised data for deleted user: ${userId}`);
// }

// // ─────────────────────────────────────────────────────────────────────
// // Register all consumers
// // ─────────────────────────────────────────────────────────────────────

// export async function registerEventConsumers() {
//   await subscribe(
//     "blog-service.user.profile.updated",
//     "user.profile.updated",
//     handleUserProfileUpdated
//   );

//   await subscribe(
//     "blog-service.user.account.deleted",
//     "user.account.deleted",
//     handleUserDeleted
//   );

//   console.info("[event-consumers] All consumers registered");
// }




// // src/lib/event-consumers.ts
// // Subscribe to events published by other microservices.
// // This module sets up all RabbitMQ consumers for this service.

// import { subscribe } from "./message-bus";
// import { AuthorsService } from "../modules/authors";

// // ─────────────────────────────────────────────────────────────────────
// // Consume: user.profile.updated (from Auth/User service)
// // Keeps the local author shadow table in sync.
// // ─────────────────────────────────────────────────────────────────────

// async function handleUserProfileUpdated(content: unknown) {
//   const event = content as {
//     payload: {
//       id: string;
//       displayName: string;
//       avatarUrl?: string | null;
//       bio?: string | null;
//       school?: string | null;
//       role?: string | null;
//       twitterHandle?: string | null;
//       verified?: boolean;
//     };
//   };

//   const { payload } = event;
//   if (!payload?.id) return;

//   await AuthorsService.upsert({
//     id:            payload.id,
//     displayName:   payload.displayName,
//     avatarUrl:     payload.avatarUrl,
//     bio:           payload.bio,
//     school:        payload.school,
//     role:          payload.role,
//     twitterHandle: payload.twitterHandle,
//     verified:      payload.verified ?? false,
//   });

//   console.info(`[event] Synced author profile: ${payload.id}`);
// }

// // ─────────────────────────────────────────────────────────────────────
// // Consume: user.account.deleted (from Auth service)
// // Anonymise posts and comments when a user deletes their account.
// // ─────────────────────────────────────────────────────────────────────

// async function handleUserDeleted(content: unknown) {
//   const event = content as { payload: { userId: string } };
//   const userId = event?.payload?.userId;
//   if (!userId) return;

//   const { prisma } = await import("./prisma");

//   // Soft-delete: replace identifying data with "[deleted]"
//   await prisma.$transaction([
//     prisma.comment.updateMany({
//       where: { authorId: userId },
//       data: { authorId: "deleted", body: "[deleted]", status: "DELETED" },
//     }),
//     // Posts are archived, not deleted — preserve content
//     prisma.post.updateMany({
//       where: { authorId: userId },
//       data: { status: "ARCHIVED" },
//     }),
//   ]);

//   console.info(`[event] Anonymised data for deleted user: ${userId}`);
// }

// // ─────────────────────────────────────────────────────────────────────
// // Register all consumers
// // ─────────────────────────────────────────────────────────────────────

// export async function registerEventConsumers() {
//   await subscribe(
//     "blog-service.user.profile.updated",
//     "user.profile.updated",
//     handleUserProfileUpdated
//   );

//   await subscribe(
//     "blog-service.user.account.deleted",
//     "user.account.deleted",
//     handleUserDeleted
//   );

//   console.info("[event-consumers] All consumers registered");
// }