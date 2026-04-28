// src/modules/newsletter/index.ts
// Newsletter subscription management.
// Actual email delivery is handled by a dedicated Email service —
// this service only manages subscriber records and emits events via RabbitMQ.

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { SubscriptionStatus } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { publish } from "../../lib/message-bus";
import { authenticate, requireEditor } from "../../middleware/auth";
import type { NewsletterSubscribedPayload } from "../../types";

// ─────────────────────────────────────────────────────────────────────
// Valid category slugs (keep in sync with Category table)
// ─────────────────────────────────────────────────────────────────────

const VALID_CATEGORY_SLUGS = [
  "exam-prep",
  "earn-grow",
  "scholarships",
  "study-tips",
  "ai-tech",
  "remote-jobs",
] as const;

// ─────────────────────────────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────────────────────────────

const SubscribeSchema = z.object({
  email:      z.string().email().toLowerCase().trim(),
  firstName:  z.string().max(60).optional(),
  categories: z
    .array(z.enum(VALID_CATEGORY_SLUGS))
    .min(1, "Select at least one category")
    .max(6),
});

const UpdatePreferencesSchema = z.object({
  categories: z
    .array(z.enum(VALID_CATEGORY_SLUGS))
    .min(1)
    .max(6),
  firstName:  z.string().max(60).optional(),
});

const AdminListQuerySchema = z.object({
  page:   z.coerce.number().int().min(1).default(1),
  limit:  z.coerce.number().int().min(1).max(100).default(50),
  status: z.enum(["ACTIVE", "UNSUBSCRIBED", "BOUNCED"]).optional(),
});

type SubscribeInput          = z.infer<typeof SubscribeSchema>;
type UpdatePreferencesInput  = z.infer<typeof UpdatePreferencesSchema>;
type AdminListQuery          = z.infer<typeof AdminListQuerySchema>;

// ─────────────────────────────────────────────────────────────────────
// Service
// ─────────────────────────────────────────────────────────────────────

export const NewsletterService = {
  async subscribe(input: SubscribeInput) {
    const existing = await prisma.newsletterSubscriber.findUnique({
      where: { email: input.email },
    });

    if (existing) {
      if (existing.status === SubscriptionStatus.ACTIVE) {
        // Update preferences silently
        return prisma.newsletterSubscriber.update({
          where: { id: existing.id },
          data: {
            categories: input.categories,
            ...(input.firstName && { firstName: input.firstName }),
          },
          select: { id: true, email: true, status: true, categories: true },
        });
      }

      // Re-subscribe
      const reactivated = await prisma.newsletterSubscriber.update({
        where: { id: existing.id },
        data: {
          status: SubscriptionStatus.ACTIVE,
          categories: input.categories,
          ...(input.firstName && { firstName: input.firstName }),
          unsubscribedAt: null,
          subscribedAt: new Date(),
        },
        select: { id: true, email: true, firstName: true, status: true, categories: true, token: true },
      });

      await publish<NewsletterSubscribedPayload>("blog.newsletter.subscribed", {
        subscriberId: reactivated.id,
        email: reactivated.email,
        firstName: reactivated.firstName ?? undefined,
        categories: reactivated.categories,
        token: reactivated.token,
      });

      return reactivated;
    }

    // New subscriber
    const subscriber = await prisma.newsletterSubscriber.create({
      data: {
        email: input.email,
        firstName: input.firstName,
        categories: input.categories,
        status: SubscriptionStatus.ACTIVE,
        // verifiedAt is set after email verification flow (handled by Email service)
      },
      select: { id: true, email: true, firstName: true, status: true, categories: true, token: true },
    });

    // Emit event — Email service sends the welcome email
    await publish<NewsletterSubscribedPayload>("blog.newsletter.subscribed", {
      subscriberId: subscriber.id,
      email: subscriber.email,
      firstName: subscriber.firstName ?? undefined,
      categories: subscriber.categories,
      token: subscriber.token,
    });

    return subscriber;
  },

  async unsubscribe(token: string) {
    const subscriber = await prisma.newsletterSubscriber.findUnique({
      where: { token },
      select: { id: true, email: true, status: true },
    });

    if (!subscriber) return null;
    if (subscriber.status === SubscriptionStatus.UNSUBSCRIBED) {
      return { message: "Already unsubscribed" };
    }

    const updated = await prisma.newsletterSubscriber.update({
      where: { id: subscriber.id },
      data: {
        status: SubscriptionStatus.UNSUBSCRIBED,
        unsubscribedAt: new Date(),
      },
      select: { id: true, email: true, status: true },
    });

    await publish("blog.newsletter.unsubscribed", {
      subscriberId: updated.id,
      email: updated.email,
    });

    return { message: "Successfully unsubscribed" };
  },

  async updatePreferences(token: string, input: UpdatePreferencesInput) {
    const subscriber = await prisma.newsletterSubscriber.findUnique({
      where: { token },
      select: { id: true, status: true },
    });

    if (!subscriber || subscriber.status !== SubscriptionStatus.ACTIVE) {
      return null;
    }

    return prisma.newsletterSubscriber.update({
      where: { id: subscriber.id },
      data: {
        categories: input.categories,
        ...(input.firstName && { firstName: input.firstName }),
      },
      select: { id: true, email: true, status: true, categories: true },
    });
  },

  /** Called by Email service after email verification */
  async verify(token: string) {
    const subscriber = await prisma.newsletterSubscriber.findUnique({
      where: { token },
      select: { id: true, verifiedAt: true },
    });
    if (!subscriber) return null;
    if (subscriber.verifiedAt) return { message: "Already verified" };

    return prisma.newsletterSubscriber.update({
      where: { id: subscriber.id },
      data: { verifiedAt: new Date() },
      select: { id: true, email: true, verifiedAt: true },
    });
  },

  async adminList(query: AdminListQuery) {
    const where = query.status
      ? { status: SubscriptionStatus[query.status as keyof typeof SubscriptionStatus] }
      : {};

    const [total, subscribers] = await Promise.all([
      prisma.newsletterSubscriber.count({ where }),
      prisma.newsletterSubscriber.findMany({
        where,
        select: {
          id: true,
          email: true,
          firstName: true,
          status: true,
          categories: true,
          verifiedAt: true,
          subscribedAt: true,
          unsubscribedAt: true,
        },
        orderBy: { subscribedAt: "desc" },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
    ]);

    return {
      data: subscribers,
      pagination: {
        total,
        page: query.page,
        limit: query.limit,
        totalPages: Math.ceil(total / query.limit),
      },
    };
  },

  async adminStats() {
    const [total, active, unsubscribed, verified] = await Promise.all([
      prisma.newsletterSubscriber.count(),
      prisma.newsletterSubscriber.count({ where: { status: "ACTIVE" } }),
      prisma.newsletterSubscriber.count({ where: { status: "UNSUBSCRIBED" } }),
      prisma.newsletterSubscriber.count({
        where: { verifiedAt: { not: null } },
      }),
    ]);
    return { total, active, unsubscribed, verified };
  },
};

// ─────────────────────────────────────────────────────────────────────
// Route handlers
// ─────────────────────────────────────────────────────────────────────

async function subscribe(request: FastifyRequest, reply: FastifyReply) {
  const input = SubscribeSchema.parse(request.body);
  const data = await NewsletterService.subscribe(input);
  return reply.code(201).send({
    success: true,
    data,
    meta: { message: "Check your email to confirm your subscription" },
  });
}

async function unsubscribe(
  request: FastifyRequest<{ Params: { token: string } }>,
  reply: FastifyReply
) {
  const result = await NewsletterService.unsubscribe(request.params.token);
  if (!result) {
    return reply.code(404).send({
      success: false,
      error: { code: "NOT_FOUND", message: "Subscription not found" },
    });
  }
  return reply.send({ success: true, data: result });
}

async function updatePreferences(
  request: FastifyRequest<{ Params: { token: string } }>,
  reply: FastifyReply
) {
  const input = UpdatePreferencesSchema.parse(request.body);
  const data = await NewsletterService.updatePreferences(request.params.token, input);
  if (!data) {
    return reply.code(404).send({
      success: false,
      error: { code: "NOT_FOUND", message: "Active subscription not found" },
    });
  }
  return reply.send({ success: true, data });
}

async function verify(
  request: FastifyRequest<{ Params: { token: string } }>,
  reply: FastifyReply
) {
  const data = await NewsletterService.verify(request.params.token);
  if (!data) {
    return reply.code(404).send({
      success: false,
      error: { code: "NOT_FOUND", message: "Invalid verification token" },
    });
  }
  return reply.send({ success: true, data });
}

async function adminList(request: FastifyRequest, reply: FastifyReply) {
  const query = AdminListQuerySchema.parse(request.query);
  const result = await NewsletterService.adminList(query);
  return reply.send({ success: true, ...result });
}

async function adminStats(_req: FastifyRequest, reply: FastifyReply) {
  const data = await NewsletterService.adminStats();
  return reply.send({ success: true, data });
}

// ─────────────────────────────────────────────────────────────────────
// Plugin registration
// ─────────────────────────────────────────────────────────────────────

export async function newsletterRoutes(fastify: FastifyInstance) {
  // Public
  fastify.post("/newsletter/subscribe", subscribe);
  fastify.get<{ Params: { token: string } }>(
    "/newsletter/unsubscribe/:token",
    unsubscribe
  );
  fastify.patch<{ Params: { token: string } }>(
    "/newsletter/preferences/:token",
    updatePreferences
  );
  fastify.get<{ Params: { token: string } }>(
    "/newsletter/verify/:token",
    verify
  );

  // Admin only
  fastify.get(
    "/newsletter/subscribers",
    { preHandler: [authenticate, requireEditor] },
    adminList
  );
  fastify.get(
    "/newsletter/stats",
    { preHandler: [authenticate, requireEditor] },
    adminStats
  );
}



// // src/modules/newsletter/index.ts
// // Newsletter subscription management.
// // Actual email delivery is handled by a dedicated Email service —
// // this service only manages subscriber records and emits events via RabbitMQ.

// import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
// import { z } from "zod";
// import { SubscriptionStatus } from "@prisma/client";
// import { prisma } from "../../lib/prisma";
// import { publish } from "../../lib/message-bus";
// import { authenticate, requireEditor } from "../../middleware/auth";
// import type { NewsletterSubscribedPayload } from "../../types";

// // ─────────────────────────────────────────────────────────────────────
// // Valid category slugs (keep in sync with Category table)
// // ─────────────────────────────────────────────────────────────────────

// const VALID_CATEGORY_SLUGS = [
//   "exam-prep",
//   "earn-grow",
//   "scholarships",
//   "study-tips",
//   "ai-tech",
//   "remote-jobs",
// ] as const;

// // ─────────────────────────────────────────────────────────────────────
// // Schemas
// // ─────────────────────────────────────────────────────────────────────

// const SubscribeSchema = z.object({
//   email:      z.string().email().toLowerCase().trim(),
//   firstName:  z.string().max(60).optional(),
//   categories: z
//     .array(z.enum(VALID_CATEGORY_SLUGS))
//     .min(1, "Select at least one category")
//     .max(6),
// });

// const UpdatePreferencesSchema = z.object({
//   categories: z
//     .array(z.enum(VALID_CATEGORY_SLUGS))
//     .min(1)
//     .max(6),
//   firstName:  z.string().max(60).optional(),
// });

// const AdminListQuerySchema = z.object({
//   page:   z.coerce.number().int().min(1).default(1),
//   limit:  z.coerce.number().int().min(1).max(100).default(50),
//   status: z.enum(["ACTIVE", "UNSUBSCRIBED", "BOUNCED"]).optional(),
// });

// type SubscribeInput          = z.infer<typeof SubscribeSchema>;
// type UpdatePreferencesInput  = z.infer<typeof UpdatePreferencesSchema>;
// type AdminListQuery          = z.infer<typeof AdminListQuerySchema>;

// // ─────────────────────────────────────────────────────────────────────
// // Service
// // ─────────────────────────────────────────────────────────────────────

// export const NewsletterService = {
//   async subscribe(input: SubscribeInput) {
//     const existing = await prisma.newsletterSubscriber.findUnique({
//       where: { email: input.email },
//     });

//     if (existing) {
//       if (existing.status === SubscriptionStatus.ACTIVE) {
//         // Update preferences silently
//         return prisma.newsletterSubscriber.update({
//           where: { id: existing.id },
//           data: {
//             categories: input.categories,
//             ...(input.firstName && { firstName: input.firstName }),
//           },
//           select: { id: true, email: true, status: true, categories: true },
//         });
//       }

//       // Re-subscribe
//       const reactivated = await prisma.newsletterSubscriber.update({
//         where: { id: existing.id },
//         data: {
//           status: SubscriptionStatus.ACTIVE,
//           categories: input.categories,
//           ...(input.firstName && { firstName: input.firstName }),
//           unsubscribedAt: null,
//           subscribedAt: new Date(),
//         },
//         select: { id: true, email: true, firstName: true, status: true, categories: true, token: true },
//       });

//       await publish<NewsletterSubscribedPayload>("blog.newsletter.subscribed", {
//         subscriberId: reactivated.id,
//         email: reactivated.email,
//         firstName: reactivated.firstName ?? undefined,
//         categories: reactivated.categories,
//         token: reactivated.token,
//       });

//       return reactivated;
//     }

//     // New subscriber
//     const subscriber = await prisma.newsletterSubscriber.create({
//       data: {
//         email: input.email,
//         firstName: input.firstName,
//         categories: input.categories,
//         status: SubscriptionStatus.ACTIVE,
//         // verifiedAt is set after email verification flow (handled by Email service)
//       },
//       select: { id: true, email: true, status: true, categories: true, token: true },
//     });

//     // Emit event — Email service sends the welcome email
//     await publish<NewsletterSubscribedPayload>("blog.newsletter.subscribed", {
//       subscriberId: subscriber.id,
//       email: subscriber.email,
//       firstName: subscriber.firstName ?? undefined,
//       categories: subscriber.categories,
//       token: subscriber.token,
//     });

//     return subscriber;
//   },

//   async unsubscribe(token: string) {
//     const subscriber = await prisma.newsletterSubscriber.findUnique({
//       where: { token },
//       select: { id: true, email: true, status: true },
//     });

//     if (!subscriber) return null;
//     if (subscriber.status === SubscriptionStatus.UNSUBSCRIBED) {
//       return { message: "Already unsubscribed" };
//     }

//     const updated = await prisma.newsletterSubscriber.update({
//       where: { id: subscriber.id },
//       data: {
//         status: SubscriptionStatus.UNSUBSCRIBED,
//         unsubscribedAt: new Date(),
//       },
//       select: { id: true, email: true, status: true },
//     });

//     await publish("blog.newsletter.unsubscribed", {
//       subscriberId: updated.id,
//       email: updated.email,
//     });

//     return { message: "Successfully unsubscribed" };
//   },

//   async updatePreferences(token: string, input: UpdatePreferencesInput) {
//     const subscriber = await prisma.newsletterSubscriber.findUnique({
//       where: { token },
//       select: { id: true, status: true },
//     });

//     if (!subscriber || subscriber.status !== SubscriptionStatus.ACTIVE) {
//       return null;
//     }

//     return prisma.newsletterSubscriber.update({
//       where: { id: subscriber.id },
//       data: {
//         categories: input.categories,
//         ...(input.firstName && { firstName: input.firstName }),
//       },
//       select: { id: true, email: true, status: true, categories: true },
//     });
//   },

//   /** Called by Email service after email verification */
//   async verify(token: string) {
//     const subscriber = await prisma.newsletterSubscriber.findUnique({
//       where: { token },
//       select: { id: true, verifiedAt: true },
//     });
//     if (!subscriber) return null;
//     if (subscriber.verifiedAt) return { message: "Already verified" };

//     return prisma.newsletterSubscriber.update({
//       where: { id: subscriber.id },
//       data: { verifiedAt: new Date() },
//       select: { id: true, email: true, verifiedAt: true },
//     });
//   },

//   async adminList(query: AdminListQuery) {
//     const where = query.status
//       ? { status: SubscriptionStatus[query.status as keyof typeof SubscriptionStatus] }
//       : {};

//     const [total, subscribers] = await Promise.all([
//       prisma.newsletterSubscriber.count({ where }),
//       prisma.newsletterSubscriber.findMany({
//         where,
//         select: {
//           id: true,
//           email: true,
//           firstName: true,
//           status: true,
//           categories: true,
//           verifiedAt: true,
//           subscribedAt: true,
//           unsubscribedAt: true,
//         },
//         orderBy: { subscribedAt: "desc" },
//         skip: (query.page - 1) * query.limit,
//         take: query.limit,
//       }),
//     ]);

//     return {
//       data: subscribers,
//       pagination: {
//         total,
//         page: query.page,
//         limit: query.limit,
//         totalPages: Math.ceil(total / query.limit),
//       },
//     };
//   },

//   async adminStats() {
//     const [total, active, unsubscribed, verified] = await Promise.all([
//       prisma.newsletterSubscriber.count(),
//       prisma.newsletterSubscriber.count({ where: { status: "ACTIVE" } }),
//       prisma.newsletterSubscriber.count({ where: { status: "UNSUBSCRIBED" } }),
//       prisma.newsletterSubscriber.count({
//         where: { verifiedAt: { not: null } },
//       }),
//     ]);
//     return { total, active, unsubscribed, verified };
//   },
// };

// // ─────────────────────────────────────────────────────────────────────
// // Route handlers
// // ─────────────────────────────────────────────────────────────────────

// async function subscribe(request: FastifyRequest, reply: FastifyReply) {
//   const input = SubscribeSchema.parse(request.body);
//   const data = await NewsletterService.subscribe(input);
//   return reply.code(201).send({
//     success: true,
//     data,
//     meta: { message: "Check your email to confirm your subscription" },
//   });
// }

// async function unsubscribe(
//   request: FastifyRequest<{ Params: { token: string } }>,
//   reply: FastifyReply
// ) {
//   const result = await NewsletterService.unsubscribe(request.params.token);
//   if (!result) {
//     return reply.code(404).send({
//       success: false,
//       error: { code: "NOT_FOUND", message: "Subscription not found" },
//     });
//   }
//   return reply.send({ success: true, data: result });
// }

// async function updatePreferences(
//   request: FastifyRequest<{ Params: { token: string } }>,
//   reply: FastifyReply
// ) {
//   const input = UpdatePreferencesSchema.parse(request.body);
//   const data = await NewsletterService.updatePreferences(request.params.token, input);
//   if (!data) {
//     return reply.code(404).send({
//       success: false,
//       error: { code: "NOT_FOUND", message: "Active subscription not found" },
//     });
//   }
//   return reply.send({ success: true, data });
// }

// async function verify(
//   request: FastifyRequest<{ Params: { token: string } }>,
//   reply: FastifyReply
// ) {
//   const data = await NewsletterService.verify(request.params.token);
//   if (!data) {
//     return reply.code(404).send({
//       success: false,
//       error: { code: "NOT_FOUND", message: "Invalid verification token" },
//     });
//   }
//   return reply.send({ success: true, data });
// }

// async function adminList(request: FastifyRequest, reply: FastifyReply) {
//   const query = AdminListQuerySchema.parse(request.query);
//   const result = await NewsletterService.adminList(query);
//   return reply.send({ success: true, ...result });
// }

// async function adminStats(_req: FastifyRequest, reply: FastifyReply) {
//   const data = await NewsletterService.adminStats();
//   return reply.send({ success: true, data });
// }

// // ─────────────────────────────────────────────────────────────────────
// // Plugin registration
// // ─────────────────────────────────────────────────────────────────────

// export async function newsletterRoutes(fastify: FastifyInstance) {
//   // Public
//   fastify.post("/newsletter/subscribe", subscribe);
//   fastify.get<{ Params: { token: string } }>(
//     "/newsletter/unsubscribe/:token",
//     unsubscribe
//   );
//   fastify.patch<{ Params: { token: string } }>(
//     "/newsletter/preferences/:token",
//     updatePreferences
//   );
//   fastify.get<{ Params: { token: string } }>(
//     "/newsletter/verify/:token",
//     verify
//   );

//   // Admin only
//   fastify.get(
//     "/newsletter/subscribers",
//     { preHandler: [authenticate, requireEditor] },
//     adminList
//   );
//   fastify.get(
//     "/newsletter/stats",
//     { preHandler: [authenticate, requireEditor] },
//     adminStats
//   );
// }



// // src/modules/newsletter/index.ts
// // Newsletter subscription management.
// // Actual email delivery is handled by a dedicated Email service —
// // this service only manages subscriber records and emits events via RabbitMQ.

// import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
// import { z } from "zod";
// import { SubscriptionStatus } from "@prisma/client";
// import { prisma } from "../../lib/prisma";
// import { publish } from "../../lib/message-bus";
// import { authenticate, requireEditor } from "../../middleware/auth";
// import type { NewsletterSubscribedPayload } from "../../types";

// // ─────────────────────────────────────────────────────────────────────
// // Valid category slugs (keep in sync with Category table)
// // ─────────────────────────────────────────────────────────────────────

// const VALID_CATEGORY_SLUGS = [
//   "exam-prep",
//   "earn-grow",
//   "scholarships",
//   "study-tips",
//   "ai-tech",
//   "remote-jobs",
// ] as const;

// // ─────────────────────────────────────────────────────────────────────
// // Schemas
// // ─────────────────────────────────────────────────────────────────────

// const SubscribeSchema = z.object({
//   email:      z.string().email().toLowerCase().trim(),
//   firstName:  z.string().max(60).optional(),
//   categories: z
//     .array(z.enum(VALID_CATEGORY_SLUGS))
//     .min(1, "Select at least one category")
//     .max(6),
// });

// const UpdatePreferencesSchema = z.object({
//   categories: z
//     .array(z.enum(VALID_CATEGORY_SLUGS))
//     .min(1)
//     .max(6),
//   firstName:  z.string().max(60).optional(),
// });

// const AdminListQuerySchema = z.object({
//   page:   z.coerce.number().int().min(1).default(1),
//   limit:  z.coerce.number().int().min(1).max(100).default(50),
//   status: z.enum(["ACTIVE", "UNSUBSCRIBED", "BOUNCED"]).optional(),
// });

// type SubscribeInput          = z.infer<typeof SubscribeSchema>;
// type UpdatePreferencesInput  = z.infer<typeof UpdatePreferencesSchema>;
// type AdminListQuery          = z.infer<typeof AdminListQuerySchema>;

// // ─────────────────────────────────────────────────────────────────────
// // Service
// // ─────────────────────────────────────────────────────────────────────

// export const NewsletterService = {
//   async subscribe(input: SubscribeInput) {
//     const existing = await prisma.newsletterSubscriber.findUnique({
//       where: { email: input.email },
//     });

//     if (existing) {
//       if (existing.status === SubscriptionStatus.ACTIVE) {
//         // Update preferences silently
//         return prisma.newsletterSubscriber.update({
//           where: { id: existing.id },
//           data: {
//             categories: input.categories,
//             ...(input.firstName && { firstName: input.firstName }),
//           },
//           select: { id: true, email: true, status: true, categories: true },
//         });
//       }

//       // Re-subscribe
//       const reactivated = await prisma.newsletterSubscriber.update({
//         where: { id: existing.id },
//         data: {
//           status: SubscriptionStatus.ACTIVE,
//           categories: input.categories,
//           ...(input.firstName && { firstName: input.firstName }),
//           unsubscribedAt: null,
//           subscribedAt: new Date(),
//         },
//         select: { id: true, email: true, status: true, categories: true },
//       });

//       await publish<NewsletterSubscribedPayload>("blog.newsletter.subscribed", {
//         subscriberId: reactivated.id,
//         email: reactivated.email,
//         categories: reactivated.categories,
//       });

//       return reactivated;
//     }

//     // New subscriber
//     const subscriber = await prisma.newsletterSubscriber.create({
//       data: {
//         email: input.email,
//         firstName: input.firstName,
//         categories: input.categories,
//         status: SubscriptionStatus.ACTIVE,
//         // verifiedAt is set after email verification flow (handled by Email service)
//       },
//       select: { id: true, email: true, status: true, categories: true, token: true },
//     });

//     // Emit event — Email service will send the verification/welcome email
//     await publish<NewsletterSubscribedPayload>("blog.newsletter.subscribed", {
//       subscriberId: subscriber.id,
//       email: subscriber.email,
//       categories: subscriber.categories,
//     });

//     return subscriber;
//   },

//   async unsubscribe(token: string) {
//     const subscriber = await prisma.newsletterSubscriber.findUnique({
//       where: { token },
//       select: { id: true, email: true, status: true },
//     });

//     if (!subscriber) return null;
//     if (subscriber.status === SubscriptionStatus.UNSUBSCRIBED) {
//       return { message: "Already unsubscribed" };
//     }

//     const updated = await prisma.newsletterSubscriber.update({
//       where: { id: subscriber.id },
//       data: {
//         status: SubscriptionStatus.UNSUBSCRIBED,
//         unsubscribedAt: new Date(),
//       },
//       select: { id: true, email: true, status: true },
//     });

//     await publish("blog.newsletter.unsubscribed", {
//       subscriberId: updated.id,
//       email: updated.email,
//     });

//     return { message: "Successfully unsubscribed" };
//   },

//   async updatePreferences(token: string, input: UpdatePreferencesInput) {
//     const subscriber = await prisma.newsletterSubscriber.findUnique({
//       where: { token },
//       select: { id: true, status: true },
//     });

//     if (!subscriber || subscriber.status !== SubscriptionStatus.ACTIVE) {
//       return null;
//     }

//     return prisma.newsletterSubscriber.update({
//       where: { id: subscriber.id },
//       data: {
//         categories: input.categories,
//         ...(input.firstName && { firstName: input.firstName }),
//       },
//       select: { id: true, email: true, status: true, categories: true },
//     });
//   },

//   /** Called by Email service after email verification */
//   async verify(token: string) {
//     const subscriber = await prisma.newsletterSubscriber.findUnique({
//       where: { token },
//       select: { id: true, verifiedAt: true },
//     });
//     if (!subscriber) return null;
//     if (subscriber.verifiedAt) return { message: "Already verified" };

//     return prisma.newsletterSubscriber.update({
//       where: { id: subscriber.id },
//       data: { verifiedAt: new Date() },
//       select: { id: true, email: true, verifiedAt: true },
//     });
//   },

//   async adminList(query: AdminListQuery) {
//     const where = query.status
//       ? { status: SubscriptionStatus[query.status as keyof typeof SubscriptionStatus] }
//       : {};

//     const [total, subscribers] = await Promise.all([
//       prisma.newsletterSubscriber.count({ where }),
//       prisma.newsletterSubscriber.findMany({
//         where,
//         select: {
//           id: true,
//           email: true,
//           firstName: true,
//           status: true,
//           categories: true,
//           verifiedAt: true,
//           subscribedAt: true,
//           unsubscribedAt: true,
//         },
//         orderBy: { subscribedAt: "desc" },
//         skip: (query.page - 1) * query.limit,
//         take: query.limit,
//       }),
//     ]);

//     return {
//       data: subscribers,
//       pagination: {
//         total,
//         page: query.page,
//         limit: query.limit,
//         totalPages: Math.ceil(total / query.limit),
//       },
//     };
//   },

//   async adminStats() {
//     const [total, active, unsubscribed, verified] = await Promise.all([
//       prisma.newsletterSubscriber.count(),
//       prisma.newsletterSubscriber.count({ where: { status: "ACTIVE" } }),
//       prisma.newsletterSubscriber.count({ where: { status: "UNSUBSCRIBED" } }),
//       prisma.newsletterSubscriber.count({
//         where: { verifiedAt: { not: null } },
//       }),
//     ]);
//     return { total, active, unsubscribed, verified };
//   },
// };

// // ─────────────────────────────────────────────────────────────────────
// // Route handlers
// // ─────────────────────────────────────────────────────────────────────

// async function subscribe(request: FastifyRequest, reply: FastifyReply) {
//   const input = SubscribeSchema.parse(request.body);
//   const data = await NewsletterService.subscribe(input);
//   return reply.code(201).send({
//     success: true,
//     data,
//     meta: { message: "Check your email to confirm your subscription" },
//   });
// }

// async function unsubscribe(
//   request: FastifyRequest<{ Params: { token: string } }>,
//   reply: FastifyReply
// ) {
//   const result = await NewsletterService.unsubscribe(request.params.token);
//   if (!result) {
//     return reply.code(404).send({
//       success: false,
//       error: { code: "NOT_FOUND", message: "Subscription not found" },
//     });
//   }
//   return reply.send({ success: true, data: result });
// }

// async function updatePreferences(
//   request: FastifyRequest<{ Params: { token: string } }>,
//   reply: FastifyReply
// ) {
//   const input = UpdatePreferencesSchema.parse(request.body);
//   const data = await NewsletterService.updatePreferences(request.params.token, input);
//   if (!data) {
//     return reply.code(404).send({
//       success: false,
//       error: { code: "NOT_FOUND", message: "Active subscription not found" },
//     });
//   }
//   return reply.send({ success: true, data });
// }

// async function verify(
//   request: FastifyRequest<{ Params: { token: string } }>,
//   reply: FastifyReply
// ) {
//   const data = await NewsletterService.verify(request.params.token);
//   if (!data) {
//     return reply.code(404).send({
//       success: false,
//       error: { code: "NOT_FOUND", message: "Invalid verification token" },
//     });
//   }
//   return reply.send({ success: true, data });
// }

// async function adminList(request: FastifyRequest, reply: FastifyReply) {
//   const query = AdminListQuerySchema.parse(request.query);
//   const result = await NewsletterService.adminList(query);
//   return reply.send({ success: true, ...result });
// }

// async function adminStats(_req: FastifyRequest, reply: FastifyReply) {
//   const data = await NewsletterService.adminStats();
//   return reply.send({ success: true, data });
// }

// // ─────────────────────────────────────────────────────────────────────
// // Plugin registration
// // ─────────────────────────────────────────────────────────────────────

// export async function newsletterRoutes(fastify: FastifyInstance) {
//   // Public
//   fastify.post("/newsletter/subscribe", subscribe);
//   fastify.get<{ Params: { token: string } }>(
//     "/newsletter/unsubscribe/:token",
//     unsubscribe
//   );
//   fastify.patch<{ Params: { token: string } }>(
//     "/newsletter/preferences/:token",
//     updatePreferences
//   );
//   fastify.get<{ Params: { token: string } }>(
//     "/newsletter/verify/:token",
//     verify
//   );

//   // Admin only
//   fastify.get(
//     "/newsletter/subscribers",
//     { preHandler: [authenticate, requireEditor] },
//     adminList
//   );
//   fastify.get(
//     "/newsletter/stats",
//     { preHandler: [authenticate, requireEditor] },
//     adminStats
//   );
// }




// // src/modules/newsletter/index.ts
// // Newsletter subscription management.
// // Actual email delivery is handled by a dedicated Email service —
// // this service only manages subscriber records and emits events via RabbitMQ.

// import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
// import { z } from "zod";
// import { SubscriptionStatus } from "@prisma/client";
// import { prisma } from "../../lib/prisma";
// import { publish } from "../../lib/message-bus";
// import { authenticate, requireEditor } from "../../middleware/auth";
// import type { NewsletterSubscribedPayload } from "../../types";

// // ─────────────────────────────────────────────────────────────────────
// // Valid category slugs (keep in sync with Category table)
// // ─────────────────────────────────────────────────────────────────────

// const VALID_CATEGORY_SLUGS = [
//   "exam-prep",
//   "earn-grow",
//   "scholarships",
//   "study-tips",
//   "ai-tech",
//   "remote-jobs",
// ] as const;

// // ─────────────────────────────────────────────────────────────────────
// // Schemas
// // ─────────────────────────────────────────────────────────────────────

// const SubscribeSchema = z.object({
//   email:      z.string().email().toLowerCase().trim(),
//   firstName:  z.string().max(60).optional(),
//   categories: z
//     .array(z.enum(VALID_CATEGORY_SLUGS))
//     .min(1, "Select at least one category")
//     .max(6),
// });

// const UpdatePreferencesSchema = z.object({
//   categories: z
//     .array(z.enum(VALID_CATEGORY_SLUGS))
//     .min(1)
//     .max(6),
//   firstName:  z.string().max(60).optional(),
// });

// const AdminListQuerySchema = z.object({
//   page:   z.coerce.number().int().min(1).default(1),
//   limit:  z.coerce.number().int().min(1).max(100).default(50),
//   status: z.enum(["ACTIVE", "UNSUBSCRIBED", "BOUNCED"]).optional(),
// });

// type SubscribeInput          = z.infer<typeof SubscribeSchema>;
// type UpdatePreferencesInput  = z.infer<typeof UpdatePreferencesSchema>;
// type AdminListQuery          = z.infer<typeof AdminListQuerySchema>;

// // ─────────────────────────────────────────────────────────────────────
// // Service
// // ─────────────────────────────────────────────────────────────────────

// export const NewsletterService = {
//   async subscribe(input: SubscribeInput) {
//     const existing = await prisma.newsletterSubscriber.findUnique({
//       where: { email: input.email },
//     });

//     if (existing) {
//       if (existing.status === SubscriptionStatus.ACTIVE) {
//         // Update preferences silently
//         return prisma.newsletterSubscriber.update({
//           where: { id: existing.id },
//           data: {
//             categories: input.categories,
//             ...(input.firstName && { firstName: input.firstName }),
//           },
//           select: { id: true, email: true, status: true, categories: true },
//         });
//       }

//       // Re-subscribe
//       const reactivated = await prisma.newsletterSubscriber.update({
//         where: { id: existing.id },
//         data: {
//           status: SubscriptionStatus.ACTIVE,
//           categories: input.categories,
//           ...(input.firstName && { firstName: input.firstName }),
//           unsubscribedAt: null,
//           subscribedAt: new Date(),
//         },
//         select: { id: true, email: true, status: true, categories: true },
//       });

//       await publish<NewsletterSubscribedPayload>("blog.newsletter.subscribed", {
//         subscriberId: reactivated.id,
//         email: reactivated.email,
//         categories: reactivated.categories,
//       });

//       return reactivated;
//     }

//     // New subscriber
//     const subscriber = await prisma.newsletterSubscriber.create({
//       data: {
//         email: input.email,
//         firstName: input.firstName,
//         categories: input.categories,
//         status: SubscriptionStatus.ACTIVE,
//         // verifiedAt is set after email verification flow (handled by Email service)
//       },
//       select: { id: true, email: true, status: true, categories: true, token: true },
//     });

//     // Emit event — Email service will send the verification/welcome email
//     await publish<NewsletterSubscribedPayload>("blog.newsletter.subscribed", {
//       subscriberId: subscriber.id,
//       email: subscriber.email,
//       categories: subscriber.categories,
//     });

//     return subscriber;
//   },

//   async unsubscribe(token: string) {
//     const subscriber = await prisma.newsletterSubscriber.findUnique({
//       where: { token },
//       select: { id: true, email: true, status: true },
//     });

//     if (!subscriber) return null;
//     if (subscriber.status === SubscriptionStatus.UNSUBSCRIBED) {
//       return { message: "Already unsubscribed" };
//     }

//     const updated = await prisma.newsletterSubscriber.update({
//       where: { id: subscriber.id },
//       data: {
//         status: SubscriptionStatus.UNSUBSCRIBED,
//         unsubscribedAt: new Date(),
//       },
//       select: { id: true, email: true, status: true },
//     });

//     await publish("blog.newsletter.unsubscribed", {
//       subscriberId: updated.id,
//       email: updated.email,
//     });

//     return { message: "Successfully unsubscribed" };
//   },

//   async updatePreferences(token: string, input: UpdatePreferencesInput) {
//     const subscriber = await prisma.newsletterSubscriber.findUnique({
//       where: { token },
//       select: { id: true, status: true },
//     });

//     if (!subscriber || subscriber.status !== SubscriptionStatus.ACTIVE) {
//       return null;
//     }

//     return prisma.newsletterSubscriber.update({
//       where: { id: subscriber.id },
//       data: {
//         categories: input.categories,
//         ...(input.firstName && { firstName: input.firstName }),
//       },
//       select: { id: true, email: true, status: true, categories: true },
//     });
//   },

//   /** Called by Email service after email verification */
//   async verify(token: string) {
//     const subscriber = await prisma.newsletterSubscriber.findUnique({
//       where: { token },
//       select: { id: true, verifiedAt: true },
//     });
//     if (!subscriber) return null;
//     if (subscriber.verifiedAt) return { message: "Already verified" };

//     return prisma.newsletterSubscriber.update({
//       where: { id: subscriber.id },
//       data: { verifiedAt: new Date() },
//       select: { id: true, email: true, verifiedAt: true },
//     });
//   },

//   async adminList(query: AdminListQuery) {
//     const where = query.status
//       ? { status: SubscriptionStatus[query.status as keyof typeof SubscriptionStatus] }
//       : {};

//     const [total, subscribers] = await Promise.all([
//       prisma.newsletterSubscriber.count({ where }),
//       prisma.newsletterSubscriber.findMany({
//         where,
//         select: {
//           id: true,
//           email: true,
//           firstName: true,
//           status: true,
//           categories: true,
//           verifiedAt: true,
//           subscribedAt: true,
//           unsubscribedAt: true,
//         },
//         orderBy: { subscribedAt: "desc" },
//         skip: (query.page - 1) * query.limit,
//         take: query.limit,
//       }),
//     ]);

//     return {
//       data: subscribers,
//       pagination: {
//         total,
//         page: query.page,
//         limit: query.limit,
//         totalPages: Math.ceil(total / query.limit),
//       },
//     };
//   },

//   async adminStats() {
//     const [total, active, unsubscribed, verified] = await Promise.all([
//       prisma.newsletterSubscriber.count(),
//       prisma.newsletterSubscriber.count({ where: { status: "ACTIVE" } }),
//       prisma.newsletterSubscriber.count({ where: { status: "UNSUBSCRIBED" } }),
//       prisma.newsletterSubscriber.count({
//         where: { verifiedAt: { not: null } },
//       }),
//     ]);
//     return { total, active, unsubscribed, verified };
//   },
// };

// // ─────────────────────────────────────────────────────────────────────
// // Route handlers
// // ─────────────────────────────────────────────────────────────────────

// async function subscribe(request: FastifyRequest, reply: FastifyReply) {
//   const input = SubscribeSchema.parse(request.body);
//   const data = await NewsletterService.subscribe(input);
//   return reply.code(201).send({
//     success: true,
//     data,
//     meta: { message: "Check your email to confirm your subscription" },
//   });
// }

// async function unsubscribe(
//   request: FastifyRequest<{ Params: { token: string } }>,
//   reply: FastifyReply
// ) {
//   const result = await NewsletterService.unsubscribe(request.params.token);
//   if (!result) {
//     return reply.code(404).send({
//       success: false,
//       error: { code: "NOT_FOUND", message: "Subscription not found" },
//     });
//   }
//   return reply.send({ success: true, data: result });
// }

// async function updatePreferences(
//   request: FastifyRequest<{ Params: { token: string } }>,
//   reply: FastifyReply
// ) {
//   const input = UpdatePreferencesSchema.parse(request.body);
//   const data = await NewsletterService.updatePreferences(request.params.token, input);
//   if (!data) {
//     return reply.code(404).send({
//       success: false,
//       error: { code: "NOT_FOUND", message: "Active subscription not found" },
//     });
//   }
//   return reply.send({ success: true, data });
// }

// async function verify(
//   request: FastifyRequest<{ Params: { token: string } }>,
//   reply: FastifyReply
// ) {
//   const data = await NewsletterService.verify(request.params.token);
//   if (!data) {
//     return reply.code(404).send({
//       success: false,
//       error: { code: "NOT_FOUND", message: "Invalid verification token" },
//     });
//   }
//   return reply.send({ success: true, data });
// }

// async function adminList(request: FastifyRequest, reply: FastifyReply) {
//   const query = AdminListQuerySchema.parse(request.query);
//   const result = await NewsletterService.adminList(query);
//   return reply.send({ success: true, ...result });
// }

// async function adminStats(_req: FastifyRequest, reply: FastifyReply) {
//   const data = await NewsletterService.adminStats();
//   return reply.send({ success: true, data });
// }

// // ─────────────────────────────────────────────────────────────────────
// // Plugin registration
// // ─────────────────────────────────────────────────────────────────────

// export async function newsletterRoutes(fastify: FastifyInstance) {
//   // Public
//   fastify.post("/newsletter/subscribe", subscribe);
//   fastify.get<{ Params: { token: string } }>(
//     "/newsletter/unsubscribe/:token",
//     unsubscribe
//   );
//   fastify.patch<{ Params: { token: string } }>(
//     "/newsletter/preferences/:token",
//     updatePreferences
//   );
//   fastify.get<{ Params: { token: string } }>(
//     "/newsletter/verify/:token",
//     verify
//   );

//   // Admin only
//   fastify.get(
//     "/newsletter/subscribers",
//     { preHandler: [authenticate, requireEditor] },
//     adminList
//   );
//   fastify.get(
//     "/newsletter/stats",
//     { preHandler: [authenticate, requireEditor] },
//     adminStats
//   );
// }