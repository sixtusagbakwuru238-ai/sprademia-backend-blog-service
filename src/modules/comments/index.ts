// src/modules/comments/index.ts
// Threaded comments (2 levels: top-level + replies).
// Guest comments (name + email, no auth required) go to PENDING.
// Authenticated user comments also go to PENDING.
// Editors approve/reject via the moderate endpoint.

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { CommentStatus } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import {
  cacheGet, cacheSet, cacheDelete, CacheKeys,
} from "../../lib/redis";
import { optionalAuthenticate, authenticate, requireEditor } from "../../middleware/auth";
import { publish } from "../../lib/message-bus";
import type { AuthenticatedUser } from "../../types";

// ─────────────────────────────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────────────────────────────

const CreateCommentSchema = z.object({
  body:        z.string().min(1, "Comment cannot be empty").max(2000).transform((s) => s.trim()),
  parentId:    z.string().cuid().optional(),
  // Guest fields — required when not authenticated
  guestName:   z.string().min(1).max(80).transform((s) => s.trim()).optional(),
  guestEmail:  z.string().email().max(200).optional(),
});

const ListCommentsQuerySchema = z.object({
  page:   z.coerce.number().int().min(1).default(1),
  limit:  z.coerce.number().int().min(1).max(50).default(20),
  status: z.enum(["PENDING", "APPROVED", "SPAM", "DELETED"]).optional(),
});

const ModerateCommentSchema = z.object({
  status: z.enum(["APPROVED", "SPAM", "DELETED"]),
});

type CreateCommentInput   = z.infer<typeof CreateCommentSchema>;
type ListCommentsQuery    = z.infer<typeof ListCommentsQuerySchema>;
type ModerateCommentInput = z.infer<typeof ModerateCommentSchema>;

// ─────────────────────────────────────────────────────────────────────
// DB select
// ─────────────────────────────────────────────────────────────────────

const commentSelect = {
  id:         true,
  body:       true,
  status:     true,
  likeCount:  true,
  parentId:   true,
  authorId:   true,
  guestName:  true,   // available after npx prisma db push
  createdAt:  true,
  updatedAt:  true,
  replies: {
    where: { status: CommentStatus.APPROVED },
    select: {
      id:        true,
      body:      true,
      authorId:  true,
      guestName: true,  // available after npx prisma db push
      likeCount: true,
      parentId:  true,
      createdAt: true,
    },
    orderBy: { createdAt: "asc" as const },
    take: 10,
  },
} as const;

// ─────────────────────────────────────────────────────────────────────
// Service
// ─────────────────────────────────────────────────────────────────────

export const CommentsService = {
  async listForPost(postId: string, query: ListCommentsQuery, isEditor: boolean) {
    const cacheKey = CacheKeys.postComments(postId, query.page);
    if (!isEditor) {
      const cached = await cacheGet(cacheKey);
      if (cached) return cached;
    }

    const where = {
      postId,
      parentId: null,
      ...(!isEditor && { status: CommentStatus.APPROVED }),
      ...(isEditor && query.status
        ? { status: CommentStatus[query.status as keyof typeof CommentStatus] }
        : {}),
    };

    const [total, comments] = await Promise.all([
      prisma.comment.count({ where }),
      prisma.comment.findMany({
        where,
        select: commentSelect,
        orderBy: { createdAt: "desc" },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
    ]);

    const totalPages = Math.ceil(total / query.limit);
    const result = {
      data: comments,
      pagination: {
        total,
        page: query.page,
        limit: query.limit,
        totalPages,
        hasNext: query.page < totalPages,
        hasPrev: query.page > 1,
      },
    };

    if (!isEditor) {
      await cacheSet(cacheKey, result, 60);
    }
    return result;
  },

  async create(
    postId: string,
    input: CreateCommentInput,
    authorId?: string   // undefined = guest comment
  ) {
    // Must have either an authenticated author OR guest name+email
    if (!authorId && (!input.guestName || !input.guestEmail)) {
      throw Object.assign(
        new Error("Name and email are required for guest comments"),
        { code: "BAD_REQUEST" }
      );
    }

    // Validate parent exists and belongs to this post
    if (input.parentId) {
      const parent = await prisma.comment.findUnique({
        where: { id: input.parentId },
        select: { postId: true, parentId: true },
      });
      if (!parent || parent.postId !== postId) {
        throw Object.assign(
          new Error("Parent comment not found on this post"),
          { code: "BAD_REQUEST" }
        );
      }
      if (parent.parentId) {
        throw Object.assign(
          new Error("Cannot reply to a reply — only 1 level of nesting allowed"),
          { code: "BAD_REQUEST" }
        );
      }
    }

    const comment = await prisma.comment.create({
      data: {
        postId,
        authorId:   authorId ?? null,
        guestName:  authorId ? null : (input.guestName ?? null),
        guestEmail: authorId ? null : (input.guestEmail ?? null),
        body:       input.body,
        parentId:   input.parentId ?? null,
        status:     CommentStatus.PENDING,
      },
      select: commentSelect,
    });

    await publish("blog.comment.created", {
      commentId: comment.id,
      postId,
      authorId:  authorId ?? null,
      guestName: input.guestName ?? null,
      parentId:  input.parentId ?? null,
    });

    return comment;
  },

  async moderate(commentId: string, input: ModerateCommentInput, editorId: string) {
    const comment = await prisma.comment.findUnique({
      where: { id: commentId },
      select: { postId: true, status: true },
    });
    if (!comment) return null;

    const updated = await prisma.comment.update({
      where: { id: commentId },
      data: { status: CommentStatus[input.status as keyof typeof CommentStatus] },
      select: { id: true, status: true, postId: true },
    });

    if (input.status === "APPROVED" && comment.status !== CommentStatus.APPROVED) {
      await prisma.post.update({
        where: { id: comment.postId },
        data: { commentCount: { increment: 1 } },
      });
      await publish("blog.comment.approved", {
        commentId,
        postId: comment.postId,
        moderatedBy: editorId,
      });
    }

    await cacheDelete(CacheKeys.postComments(comment.postId, 1));
    return updated;
  },

  async delete(commentId: string, requesterId: string, isEditor: boolean) {
    const comment = await prisma.comment.findUnique({
      where: { id: commentId },
      select: { authorId: true, postId: true, status: true, parentId: true },
    });
    if (!comment) return null;

    if (!isEditor && comment.authorId !== requesterId) {
      throw Object.assign(
        new Error("You can only delete your own comments"),
        { code: "FORBIDDEN" }
      );
    }

    await prisma.comment.update({
      where: { id: commentId },
      data: { status: CommentStatus.DELETED, body: "[deleted]" },
    });

    if (comment.status === CommentStatus.APPROVED && !comment.parentId) {
      await prisma.post.update({
        where: { id: comment.postId },
        data: { commentCount: { decrement: 1 } },
      });
    }

    await cacheDelete(CacheKeys.postComments(comment.postId, 1));
    return true;
  },

  async likeComment(commentId: string) {
    await prisma.comment.update({
      where: { id: commentId },
      data: { likeCount: { increment: 1 } },
    });
  },
};

// ─────────────────────────────────────────────────────────────────────
// Route handlers
// ─────────────────────────────────────────────────────────────────────

async function listComments(
  request: FastifyRequest<{ Params: { postId: string } }>,
  reply: FastifyReply
) {
  const query = ListCommentsQuerySchema.parse(request.query);
  const isEditor = ["editor", "admin"].includes(request.authenticatedUser?.role ?? "");
  const data = await CommentsService.listForPost(request.params.postId, query, isEditor);
  return reply.send({ success: true, ...data });
}

async function createComment(
  request: FastifyRequest<{ Params: { postId: string } }>,
  reply: FastifyReply
) {
  const input    = CreateCommentSchema.parse(request.body);
  const authorId = (request.authenticatedUser as AuthenticatedUser | undefined)?.id;
  const data     = await CommentsService.create(request.params.postId, input, authorId);
  return reply.code(201).send({ success: true, data });
}

async function moderateComment(
  request: FastifyRequest<{ Params: { commentId: string } }>,
  reply: FastifyReply
) {
  const input    = ModerateCommentSchema.parse(request.body);
  const editorId = (request.authenticatedUser as AuthenticatedUser).id;
  const data     = await CommentsService.moderate(request.params.commentId, input, editorId);
  if (!data) {
    return reply.code(404).send({
      success: false,
      error: { code: "NOT_FOUND", message: "Comment not found" },
    });
  }
  return reply.send({ success: true, data });
}

async function deleteComment(
  request: FastifyRequest<{ Params: { commentId: string } }>,
  reply: FastifyReply
) {
  const user = request.authenticatedUser as AuthenticatedUser;
  await CommentsService.delete(
    request.params.commentId,
    user.id,
    ["editor", "admin"].includes(user.role)
  );
  return reply.code(204).send();
}

async function likeComment(
  request: FastifyRequest<{ Params: { commentId: string } }>,
  reply: FastifyReply
) {
  await CommentsService.likeComment(request.params.commentId);
  return reply.send({ success: true });
}

// ─────────────────────────────────────────────────────────────────────
// Plugin registration
// ─────────────────────────────────────────────────────────────────────

export async function commentsRoutes(fastify: FastifyInstance) {
  // List — public, approved only (editors see all)
  fastify.get<{ Params: { postId: string } }>(
    "/posts/:postId/comments",
    { preHandler: [optionalAuthenticate] },
    listComments
  );

  // Create — guests allowed (no auth required), auth optional
  fastify.post<{ Params: { postId: string } }>(
    "/posts/:postId/comments",
    { preHandler: [optionalAuthenticate] },
    createComment
  );

  // Moderate — editors/admin only
  fastify.patch<{ Params: { commentId: string } }>(
    "/comments/:commentId/moderate",
    { preHandler: [authenticate, requireEditor] },
    moderateComment
  );

  // Delete — own comment or editor
  fastify.delete<{ Params: { commentId: string } }>(
    "/comments/:commentId",
    { preHandler: [authenticate] },
    deleteComment
  );

  // Like — public (no auth needed)
  fastify.post<{ Params: { commentId: string } }>(
    "/comments/:commentId/like",
    likeComment
  );
}



// // src/modules/comments/index.ts
// // Threaded comments (2 levels: top-level + replies).
// // Guest comments (name + email, no auth required) go to PENDING.
// // Authenticated user comments also go to PENDING.
// // Editors approve/reject via the moderate endpoint.

// import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
// import { z } from "zod";
// import { CommentStatus } from "@prisma/client";
// import { prisma } from "../../lib/prisma";
// import {
//   cacheGet, cacheSet, cacheDelete, CacheKeys,
// } from "../../lib/redis";
// import { optionalAuthenticate, authenticate, requireEditor } from "../../middleware/auth";
// import { publish } from "../../lib/message-bus";
// import { config } from "../../config";
// import type { AuthenticatedUser } from "../../types";

// // ─────────────────────────────────────────────────────────────────────
// // Schemas
// // ─────────────────────────────────────────────────────────────────────

// const CreateCommentSchema = z.object({
//   body:        z.string().min(1, "Comment cannot be empty").max(2000).transform((s) => s.trim()),
//   parentId:    z.string().cuid().optional(),
//   // Guest fields — required when not authenticated
//   guestName:   z.string().min(1).max(80).transform((s) => s.trim()).optional(),
//   guestEmail:  z.string().email().max(200).optional(),
// });

// const ListCommentsQuerySchema = z.object({
//   page:   z.coerce.number().int().min(1).default(1),
//   limit:  z.coerce.number().int().min(1).max(50).default(20),
//   status: z.enum(["PENDING", "APPROVED", "SPAM", "DELETED"]).optional(),
// });

// const ModerateCommentSchema = z.object({
//   status: z.enum(["APPROVED", "SPAM", "DELETED"]),
// });

// type CreateCommentInput   = z.infer<typeof CreateCommentSchema>;
// type ListCommentsQuery    = z.infer<typeof ListCommentsQuerySchema>;
// type ModerateCommentInput = z.infer<typeof ModerateCommentSchema>;

// // ─────────────────────────────────────────────────────────────────────
// // DB select
// // ─────────────────────────────────────────────────────────────────────

// const commentSelect = {
//   id:         true,
//   body:       true,
//   status:     true,
//   likeCount:  true,
//   parentId:   true,
//   authorId:   true,
//   guestName:  true,
//   createdAt:  true,
//   updatedAt:  true,
//   replies: {
//     where: { status: CommentStatus.APPROVED },
//     select: {
//       id:        true,
//       body:      true,
//       authorId:  true,
//       guestName: true,
//       likeCount: true,
//       parentId:  true,
//       createdAt: true,
//     },
//     orderBy: { createdAt: "asc" as const },
//     take: 10,
//   },
// } as const;

// // ─────────────────────────────────────────────────────────────────────
// // Service
// // ─────────────────────────────────────────────────────────────────────

// export const CommentsService = {
//   async listForPost(postId: string, query: ListCommentsQuery, isEditor: boolean) {
//     const cacheKey = CacheKeys.postComments(postId, query.page);
//     if (!isEditor) {
//       const cached = await cacheGet(cacheKey);
//       if (cached) return cached;
//     }

//     const where = {
//       postId,
//       parentId: null,
//       ...(!isEditor && { status: CommentStatus.APPROVED }),
//       ...(isEditor && query.status
//         ? { status: CommentStatus[query.status as keyof typeof CommentStatus] }
//         : {}),
//     };

//     const [total, comments] = await Promise.all([
//       prisma.comment.count({ where }),
//       prisma.comment.findMany({
//         where,
//         select: commentSelect,
//         orderBy: { createdAt: "desc" },
//         skip: (query.page - 1) * query.limit,
//         take: query.limit,
//       }),
//     ]);

//     const totalPages = Math.ceil(total / query.limit);
//     const result = {
//       data: comments,
//       pagination: {
//         total,
//         page: query.page,
//         limit: query.limit,
//         totalPages,
//         hasNext: query.page < totalPages,
//         hasPrev: query.page > 1,
//       },
//     };

//     if (!isEditor) {
//       await cacheSet(cacheKey, result, 60);
//     }
//     return result;
//   },

//   async create(
//     postId: string,
//     input: CreateCommentInput,
//     authorId?: string   // undefined = guest comment
//   ) {
//     // Must have either an authenticated author OR guest name+email
//     if (!authorId && (!input.guestName || !input.guestEmail)) {
//       throw Object.assign(
//         new Error("Name and email are required for guest comments"),
//         { code: "BAD_REQUEST" }
//       );
//     }

//     // Validate parent exists and belongs to this post
//     if (input.parentId) {
//       const parent = await prisma.comment.findUnique({
//         where: { id: input.parentId },
//         select: { postId: true, parentId: true },
//       });
//       if (!parent || parent.postId !== postId) {
//         throw Object.assign(
//           new Error("Parent comment not found on this post"),
//           { code: "BAD_REQUEST" }
//         );
//       }
//       if (parent.parentId) {
//         throw Object.assign(
//           new Error("Cannot reply to a reply — only 1 level of nesting allowed"),
//           { code: "BAD_REQUEST" }
//         );
//       }
//     }

//     const comment = await prisma.comment.create({
//       data: {
//         postId,
//         authorId:   authorId ?? null,
//         guestName:  authorId ? null : (input.guestName ?? null),
//         guestEmail: authorId ? null : (input.guestEmail ?? null),
//         body:       input.body,
//         parentId:   input.parentId ?? null,
//         status:     CommentStatus.PENDING,
//       },
//       select: commentSelect,
//     });

//     await publish("blog.comment.created", {
//       commentId: comment.id,
//       postId,
//       authorId:  authorId ?? null,
//       guestName: input.guestName ?? null,
//       parentId:  input.parentId ?? null,
//     });

//     return comment;
//   },

//   async moderate(commentId: string, input: ModerateCommentInput, editorId: string) {
//     const comment = await prisma.comment.findUnique({
//       where: { id: commentId },
//       select: { postId: true, status: true },
//     });
//     if (!comment) return null;

//     const updated = await prisma.comment.update({
//       where: { id: commentId },
//       data: { status: CommentStatus[input.status as keyof typeof CommentStatus] },
//       select: { id: true, status: true, postId: true },
//     });

//     if (input.status === "APPROVED" && comment.status !== CommentStatus.APPROVED) {
//       await prisma.post.update({
//         where: { id: comment.postId },
//         data: { commentCount: { increment: 1 } },
//       });
//       await publish("blog.comment.approved", {
//         commentId,
//         postId: comment.postId,
//         moderatedBy: editorId,
//       });
//     }

//     await cacheDelete(CacheKeys.postComments(comment.postId, 1));
//     return updated;
//   },

//   async delete(commentId: string, requesterId: string, isEditor: boolean) {
//     const comment = await prisma.comment.findUnique({
//       where: { id: commentId },
//       select: { authorId: true, postId: true, status: true, parentId: true },
//     });
//     if (!comment) return null;

//     if (!isEditor && comment.authorId !== requesterId) {
//       throw Object.assign(
//         new Error("You can only delete your own comments"),
//         { code: "FORBIDDEN" }
//       );
//     }

//     await prisma.comment.update({
//       where: { id: commentId },
//       data: { status: CommentStatus.DELETED, body: "[deleted]" },
//     });

//     if (comment.status === CommentStatus.APPROVED && !comment.parentId) {
//       await prisma.post.update({
//         where: { id: comment.postId },
//         data: { commentCount: { decrement: 1 } },
//       });
//     }

//     await cacheDelete(CacheKeys.postComments(comment.postId, 1));
//     return true;
//   },

//   async likeComment(commentId: string) {
//     await prisma.comment.update({
//       where: { id: commentId },
//       data: { likeCount: { increment: 1 } },
//     });
//   },
// };

// // ─────────────────────────────────────────────────────────────────────
// // Route handlers
// // ─────────────────────────────────────────────────────────────────────

// async function listComments(
//   request: FastifyRequest<{ Params: { postId: string } }>,
//   reply: FastifyReply
// ) {
//   const query = ListCommentsQuerySchema.parse(request.query);
//   const isEditor = ["editor", "admin"].includes(request.user?.role ?? "");
//   const data = await CommentsService.listForPost(request.params.postId, query, isEditor);
//   return reply.send({ success: true, ...data });
// }

// async function createComment(
//   request: FastifyRequest<{ Params: { postId: string } }>,
//   reply: FastifyReply
// ) {
//   const input    = CreateCommentSchema.parse(request.body);
//   const authorId = (request.user as AuthenticatedUser | undefined)?.id;
//   const data     = await CommentsService.create(request.params.postId, input, authorId);
//   return reply.code(201).send({ success: true, data });
// }

// async function moderateComment(
//   request: FastifyRequest<{ Params: { commentId: string } }>,
//   reply: FastifyReply
// ) {
//   const input    = ModerateCommentSchema.parse(request.body);
//   const editorId = (request.user as AuthenticatedUser).id;
//   const data     = await CommentsService.moderate(request.params.commentId, input, editorId);
//   if (!data) {
//     return reply.code(404).send({
//       success: false,
//       error: { code: "NOT_FOUND", message: "Comment not found" },
//     });
//   }
//   return reply.send({ success: true, data });
// }

// async function deleteComment(
//   request: FastifyRequest<{ Params: { commentId: string } }>,
//   reply: FastifyReply
// ) {
//   const user = request.user as AuthenticatedUser;
//   await CommentsService.delete(
//     request.params.commentId,
//     user.id,
//     ["editor", "admin"].includes(user.role)
//   );
//   return reply.code(204).send();
// }

// async function likeComment(
//   request: FastifyRequest<{ Params: { commentId: string } }>,
//   reply: FastifyReply
// ) {
//   await CommentsService.likeComment(request.params.commentId);
//   return reply.send({ success: true });
// }

// // ─────────────────────────────────────────────────────────────────────
// // Plugin registration
// // ─────────────────────────────────────────────────────────────────────

// export async function commentsRoutes(fastify: FastifyInstance) {
//   // List — public, approved only (editors see all)
//   fastify.get<{ Params: { postId: string } }>(
//     "/posts/:postId/comments",
//     { preHandler: [optionalAuthenticate] },
//     listComments
//   );

//   // Create — guests allowed (no auth required), auth optional
//   fastify.post<{ Params: { postId: string } }>(
//     "/posts/:postId/comments",
//     { preHandler: [optionalAuthenticate] },
//     createComment
//   );

//   // Moderate — editors/admin only
//   fastify.patch<{ Params: { commentId: string } }>(
//     "/comments/:commentId/moderate",
//     { preHandler: [authenticate, requireEditor] },
//     moderateComment
//   );

//   // Delete — own comment or editor
//   fastify.delete<{ Params: { commentId: string } }>(
//     "/comments/:commentId",
//     { preHandler: [authenticate] },
//     deleteComment
//   );

//   // Like — public (no auth needed)
//   fastify.post<{ Params: { commentId: string } }>(
//     "/comments/:commentId/like",
//     likeComment
//   );
// }




// // src/modules/comments/index.ts
// // Threaded comments (2 levels: top-level + replies).
// // New comments go to PENDING status; editors approve/reject.
// // Approved comments are returned to public.

// import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
// import { z } from "zod";
// import { CommentStatus } from "@prisma/client";
// import { prisma } from "../../lib/prisma";
// import {
//   cacheGet, cacheSet, cacheDelete, CacheKeys,
// } from "../../lib/redis";
// import { authenticate, requireEditor } from "../../middleware/auth";
// import { publish } from "../../lib/message-bus";
// import { config } from "../../config";
// import type { AuthenticatedUser } from "../../types";

// // ─────────────────────────────────────────────────────────────────────
// // Schemas
// // ─────────────────────────────────────────────────────────────────────

// const CreateCommentSchema = z.object({
//   body:     z.string().min(1).max(2000).transform((s) => s.trim()),
//   parentId: z.string().cuid().optional(),
// });

// const ListCommentsQuerySchema = z.object({
//   page:   z.coerce.number().int().min(1).default(1),
//   limit:  z.coerce.number().int().min(1).max(50).default(20),
//   status: z.enum(["PENDING", "APPROVED", "SPAM", "DELETED"]).optional(),
// });

// const ModerateCommentSchema = z.object({
//   status: z.enum(["APPROVED", "SPAM", "DELETED"]),
// });

// type CreateCommentInput   = z.infer<typeof CreateCommentSchema>;
// type ListCommentsQuery    = z.infer<typeof ListCommentsQuerySchema>;
// type ModerateCommentInput = z.infer<typeof ModerateCommentSchema>;

// // ─────────────────────────────────────────────────────────────────────
// // Service
// // ─────────────────────────────────────────────────────────────────────

// const commentSelect = {
//   id: true,
//   body: true,
//   status: true,
//   likeCount: true,
//   parentId: true,
//   authorId: true,
//   createdAt: true,
//   updatedAt: true,
//   replies: {
//     where: { status: CommentStatus.APPROVED },
//     select: {
//       id: true,
//       body: true,
//       authorId: true,
//       likeCount: true,
//       parentId: true,
//       createdAt: true,
//     },
//     orderBy: { createdAt: "asc" as const },
//     take: 10,
//   },
// } as const;

// export const CommentsService = {
//   async listForPost(postId: string, query: ListCommentsQuery, isEditor: boolean) {
//     const cacheKey = CacheKeys.postComments(postId, query.page);
//     if (!isEditor) {
//       const cached = await cacheGet(cacheKey);
//       if (cached) return cached;
//     }

//     const where = {
//       postId,
//       parentId: null, // top-level only — replies are nested
//       ...(!isEditor && { status: CommentStatus.APPROVED }),
//       ...(isEditor && query.status
//         ? { status: CommentStatus[query.status as keyof typeof CommentStatus] }
//         : {}),
//     };

//     const [total, comments] = await Promise.all([
//       prisma.comment.count({ where }),
//       prisma.comment.findMany({
//         where,
//         select: commentSelect,
//         orderBy: { createdAt: "desc" },
//         skip: (query.page - 1) * query.limit,
//         take: query.limit,
//       }),
//     ]);

//     const totalPages = Math.ceil(total / query.limit);
//     const result = {
//       data: comments,
//       pagination: {
//         total,
//         page: query.page,
//         limit: query.limit,
//         totalPages,
//         hasNext: query.page < totalPages,
//         hasPrev: query.page > 1,
//       },
//     };

//     if (!isEditor) {
//       await cacheSet(cacheKey, result, 60); // 1 min — comments update frequently
//     }
//     return result;
//   },

//   async create(
//     postId: string,
//     authorId: string,
//     input: CreateCommentInput
//   ) {
//     // Validate parent exists and belongs to this post
//     if (input.parentId) {
//       const parent = await prisma.comment.findUnique({
//         where: { id: input.parentId },
//         select: { postId: true, parentId: true },
//       });
//       if (!parent || parent.postId !== postId) {
//         throw Object.assign(
//           new Error("Parent comment not found on this post"),
//           { code: "BAD_REQUEST" }
//         );
//       }
//       // Only allow 1 level of nesting
//       if (parent.parentId) {
//         throw Object.assign(
//           new Error("Cannot reply to a reply — only 1 level of nesting allowed"),
//           { code: "BAD_REQUEST" }
//         );
//       }
//     }

//     const comment = await prisma.comment.create({
//       data: {
//         postId,
//         authorId,
//         body: input.body,
//         parentId: input.parentId,
//         status: CommentStatus.PENDING,
//       },
//       select: commentSelect,
//     });

//     // Emit event so notification service can alert the post author
//     await publish("blog.comment.created", {
//       commentId: comment.id,
//       postId,
//       authorId,
//       parentId: input.parentId,
//     });

//     return comment;
//   },

//   async moderate(commentId: string, input: ModerateCommentInput, editorId: string) {
//     const comment = await prisma.comment.findUnique({
//       where: { id: commentId },
//       select: { postId: true, status: true },
//     });
//     if (!comment) return null;

//     const updated = await prisma.comment.update({
//       where: { id: commentId },
//       data: { status: CommentStatus[input.status as keyof typeof CommentStatus] },
//       select: { id: true, status: true, postId: true },
//     });

//     // If just approved, update the post's commentCount
//     if (input.status === "APPROVED" && comment.status !== CommentStatus.APPROVED) {
//       await prisma.post.update({
//         where: { id: comment.postId },
//         data: { commentCount: { increment: 1 } },
//       });
//       await publish("blog.comment.approved", {
//         commentId,
//         postId: comment.postId,
//         moderatedBy: editorId,
//       });
//     }

//     // Invalidate comment cache for this post
//     await cacheDelete(CacheKeys.postComments(comment.postId, 1));

//     return updated;
//   },

//   async delete(commentId: string, requesterId: string, isEditor: boolean) {
//     const comment = await prisma.comment.findUnique({
//       where: { id: commentId },
//       select: { authorId: true, postId: true, status: true, parentId: true },
//     });
//     if (!comment) return null;

//     // Authors can delete own pending comments; editors can delete any
//     if (!isEditor && comment.authorId !== requesterId) {
//       throw Object.assign(
//         new Error("You can only delete your own comments"),
//         { code: "FORBIDDEN" }
//       );
//     }

//     await prisma.comment.update({
//       where: { id: commentId },
//       data: { status: CommentStatus.DELETED, body: "[deleted]" },
//     });

//     // Decrement post counter if comment was approved
//     if (comment.status === CommentStatus.APPROVED && !comment.parentId) {
//       await prisma.post.update({
//         where: { id: comment.postId },
//         data: { commentCount: { decrement: 1 } },
//       });
//     }

//     await cacheDelete(CacheKeys.postComments(comment.postId, 1));
//     return true;
//   },

//   async likeComment(commentId: string) {
//     await prisma.comment.update({
//       where: { id: commentId },
//       data: { likeCount: { increment: 1 } },
//     });
//   },
// };

// // ─────────────────────────────────────────────────────────────────────
// // Route handlers
// // ─────────────────────────────────────────────────────────────────────

// async function listComments(
//   request: FastifyRequest<{ Params: { postId: string } }>,
//   reply: FastifyReply
// ) {
//   const query = ListCommentsQuerySchema.parse(request.query);
//   const isEditor = ["editor", "admin"].includes(request.user?.role ?? "");
//   const data = await CommentsService.listForPost(
//     request.params.postId,
//     query,
//     isEditor
//   );
//   return reply.send({ success: true, ...data });
// }

// async function createComment(
//   request: FastifyRequest<{ Params: { postId: string } }>,
//   reply: FastifyReply
// ) {
//   const input = CreateCommentSchema.parse(request.body);
//   const authorId = (request.user as AuthenticatedUser).id;
//   const data = await CommentsService.create(request.params.postId, authorId, input);
//   return reply.code(201).send({ success: true, data });
// }

// async function moderateComment(
//   request: FastifyRequest<{ Params: { commentId: string } }>,
//   reply: FastifyReply
// ) {
//   const input = ModerateCommentSchema.parse(request.body);
//   const editorId = (request.user as AuthenticatedUser).id;
//   const data = await CommentsService.moderate(
//     request.params.commentId,
//     input,
//     editorId
//   );
//   if (!data) {
//     return reply.code(404).send({
//       success: false,
//       error: { code: "NOT_FOUND", message: "Comment not found" },
//     });
//   }
//   return reply.send({ success: true, data });
// }

// async function deleteComment(
//   request: FastifyRequest<{ Params: { commentId: string } }>,
//   reply: FastifyReply
// ) {
//   const user = request.user as AuthenticatedUser;
//   await CommentsService.delete(
//     request.params.commentId,
//     user.id,
//     ["editor", "admin"].includes(user.role)
//   );
//   return reply.code(204).send();
// }

// async function likeComment(
//   request: FastifyRequest<{ Params: { commentId: string } }>,
//   reply: FastifyReply
// ) {
//   await CommentsService.likeComment(request.params.commentId);
//   return reply.send({ success: true });
// }

// // ─────────────────────────────────────────────────────────────────────
// // Plugin registration
// // ─────────────────────────────────────────────────────────────────────

// export async function commentsRoutes(fastify: FastifyInstance) {
//   // List comments on a post (public — approved only; editors see all statuses)
//   fastify.get<{ Params: { postId: string } }>(
//     "/posts/:postId/comments",
//     commentsRoutes.prototype,
//     listComments
//   );

//   // Create comment (authenticated users)
//   fastify.post<{ Params: { postId: string } }>(
//     "/posts/:postId/comments",
//     { preHandler: [authenticate] },
//     createComment
//   );

//   // Moderate (editors/admin)
//   fastify.patch<{ Params: { commentId: string } }>(
//     "/comments/:commentId/moderate",
//     { preHandler: [authenticate, requireEditor] },
//     moderateComment
//   );

//   // Delete
//   fastify.delete<{ Params: { commentId: string } }>(
//     "/comments/:commentId",
//     { preHandler: [authenticate] },
//     deleteComment
//   );

//   // Like a comment
//   fastify.post<{ Params: { commentId: string } }>(
//     "/comments/:commentId/like",
//     { preHandler: [authenticate] },
//     likeComment
//   );
// }

// // Fix: register without prototype
// export async function registerCommentsRoutes(fastify: FastifyInstance) {
//   fastify.get<{ Params: { postId: string } }>(
//     "/posts/:postId/comments",
//     listComments
//   );
//   fastify.post<{ Params: { postId: string } }>(
//     "/posts/:postId/comments",
//     { preHandler: [authenticate] },
//     createComment
//   );
//   fastify.patch<{ Params: { commentId: string } }>(
//     "/comments/:commentId/moderate",
//     { preHandler: [authenticate, requireEditor] },
//     moderateComment
//   );
//   fastify.delete<{ Params: { commentId: string } }>(
//     "/comments/:commentId",
//     { preHandler: [authenticate] },
//     deleteComment
//   );
//   fastify.post<{ Params: { commentId: string } }>(
//     "/comments/:commentId/like",
//     { preHandler: [authenticate] },
//     likeComment
//   );
// }




// // src/modules/comments/index.ts
// // Threaded comments (2 levels: top-level + replies).
// // New comments go to PENDING status; editors approve/reject.
// // Approved comments are returned to public.

// import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
// import { z } from "zod";
// import { CommentStatus } from "@prisma/client";
// import { prisma } from "../../lib/prisma";
// import {
//   cacheGet, cacheSet, cacheDelete, CacheKeys,
// } from "../../lib/redis";
// import { authenticate, requireEditor } from "../../middleware/auth";
// import { publish } from "../../lib/message-bus";
// import { config } from "../../config";
// import type { AuthenticatedUser } from "../../types";

// // ─────────────────────────────────────────────────────────────────────
// // Schemas
// // ─────────────────────────────────────────────────────────────────────

// const CreateCommentSchema = z.object({
//   body:     z.string().min(1).max(2000).transform((s) => s.trim()),
//   parentId: z.string().cuid().optional(),
// });

// const ListCommentsQuerySchema = z.object({
//   page:   z.coerce.number().int().min(1).default(1),
//   limit:  z.coerce.number().int().min(1).max(50).default(20),
//   status: z.enum(["PENDING", "APPROVED", "SPAM", "DELETED"]).optional(),
// });

// const ModerateCommentSchema = z.object({
//   status: z.enum(["APPROVED", "SPAM", "DELETED"]),
// });

// type CreateCommentInput   = z.infer<typeof CreateCommentSchema>;
// type ListCommentsQuery    = z.infer<typeof ListCommentsQuerySchema>;
// type ModerateCommentInput = z.infer<typeof ModerateCommentSchema>;

// // ─────────────────────────────────────────────────────────────────────
// // Service
// // ─────────────────────────────────────────────────────────────────────

// const commentSelect = {
//   id: true,
//   body: true,
//   status: true,
//   likeCount: true,
//   parentId: true,
//   authorId: true,
//   createdAt: true,
//   updatedAt: true,
//   replies: {
//     where: { status: CommentStatus.APPROVED },
//     select: {
//       id: true,
//       body: true,
//       authorId: true,
//       likeCount: true,
//       parentId: true,
//       createdAt: true,
//     },
//     orderBy: { createdAt: "asc" as const },
//     take: 10,
//   },
// } as const;

// export const CommentsService = {
//   async listForPost(postId: string, query: ListCommentsQuery, isEditor: boolean) {
//     const cacheKey = CacheKeys.postComments(postId, query.page);
//     if (!isEditor) {
//       const cached = await cacheGet(cacheKey);
//       if (cached) return cached;
//     }

//     const where = {
//       postId,
//       parentId: null, // top-level only — replies are nested
//       ...(!isEditor && { status: CommentStatus.APPROVED }),
//       ...(isEditor && query.status
//         ? { status: CommentStatus[query.status as keyof typeof CommentStatus] }
//         : {}),
//     };

//     const [total, comments] = await Promise.all([
//       prisma.comment.count({ where }),
//       prisma.comment.findMany({
//         where,
//         select: commentSelect,
//         orderBy: { createdAt: "desc" },
//         skip: (query.page - 1) * query.limit,
//         take: query.limit,
//       }),
//     ]);

//     const totalPages = Math.ceil(total / query.limit);
//     const result = {
//       data: comments,
//       pagination: {
//         total,
//         page: query.page,
//         limit: query.limit,
//         totalPages,
//         hasNext: query.page < totalPages,
//         hasPrev: query.page > 1,
//       },
//     };

//     if (!isEditor) {
//       await cacheSet(cacheKey, result, 60); // 1 min — comments update frequently
//     }
//     return result;
//   },

//   async create(
//     postId: string,
//     authorId: string,
//     input: CreateCommentInput
//   ) {
//     // Validate parent exists and belongs to this post
//     if (input.parentId) {
//       const parent = await prisma.comment.findUnique({
//         where: { id: input.parentId },
//         select: { postId: true, parentId: true },
//       });
//       if (!parent || parent.postId !== postId) {
//         throw Object.assign(
//           new Error("Parent comment not found on this post"),
//           { code: "BAD_REQUEST" }
//         );
//       }
//       // Only allow 1 level of nesting
//       if (parent.parentId) {
//         throw Object.assign(
//           new Error("Cannot reply to a reply — only 1 level of nesting allowed"),
//           { code: "BAD_REQUEST" }
//         );
//       }
//     }

//     const comment = await prisma.comment.create({
//       data: {
//         postId,
//         authorId,
//         body: input.body,
//         parentId: input.parentId,
//         status: CommentStatus.PENDING,
//       },
//       select: commentSelect,
//     });

//     // Emit event so notification service can alert the post author
//     await publish("blog.comment.created", {
//       commentId: comment.id,
//       postId,
//       authorId,
//       parentId: input.parentId,
//     });

//     return comment;
//   },

//   async moderate(commentId: string, input: ModerateCommentInput, editorId: string) {
//     const comment = await prisma.comment.findUnique({
//       where: { id: commentId },
//       select: { postId: true, status: true },
//     });
//     if (!comment) return null;

//     const updated = await prisma.comment.update({
//       where: { id: commentId },
//       data: { status: CommentStatus[input.status as keyof typeof CommentStatus] },
//       select: { id: true, status: true, postId: true },
//     });

//     // If just approved, update the post's commentCount
//     if (input.status === "APPROVED" && comment.status !== CommentStatus.APPROVED) {
//       await prisma.post.update({
//         where: { id: comment.postId },
//         data: { commentCount: { increment: 1 } },
//       });
//       await publish("blog.comment.approved", {
//         commentId,
//         postId: comment.postId,
//         moderatedBy: editorId,
//       });
//     }

//     // Invalidate comment cache for this post
//     await cacheDelete(CacheKeys.postComments(comment.postId, 1));

//     return updated;
//   },

//   async delete(commentId: string, requesterId: string, isEditor: boolean) {
//     const comment = await prisma.comment.findUnique({
//       where: { id: commentId },
//       select: { authorId: true, postId: true, status: true, parentId: true },
//     });
//     if (!comment) return null;

//     // Authors can delete own pending comments; editors can delete any
//     if (!isEditor && comment.authorId !== requesterId) {
//       throw Object.assign(
//         new Error("You can only delete your own comments"),
//         { code: "FORBIDDEN" }
//       );
//     }

//     await prisma.comment.update({
//       where: { id: commentId },
//       data: { status: CommentStatus.DELETED, body: "[deleted]" },
//     });

//     // Decrement post counter if comment was approved
//     if (comment.status === CommentStatus.APPROVED && !comment.parentId) {
//       await prisma.post.update({
//         where: { id: comment.postId },
//         data: { commentCount: { decrement: 1 } },
//       });
//     }

//     await cacheDelete(CacheKeys.postComments(comment.postId, 1));
//     return true;
//   },

//   async likeComment(commentId: string) {
//     await prisma.comment.update({
//       where: { id: commentId },
//       data: { likeCount: { increment: 1 } },
//     });
//   },
// };

// // ─────────────────────────────────────────────────────────────────────
// // Route handlers
// // ─────────────────────────────────────────────────────────────────────

// async function listComments(
//   request: FastifyRequest<{ Params: { postId: string } }>,
//   reply: FastifyReply
// ) {
//   const query = ListCommentsQuerySchema.parse(request.query);
//   const isEditor = ["editor", "admin"].includes(request.user?.role ?? "");
//   const data = await CommentsService.listForPost(
//     request.params.postId,
//     query,
//     isEditor
//   );
//   return reply.send({ success: true, ...data });
// }

// async function createComment(
//   request: FastifyRequest<{ Params: { postId: string } }>,
//   reply: FastifyReply
// ) {
//   const input = CreateCommentSchema.parse(request.body);
//   const authorId = (request.user as AuthenticatedUser).id;
//   const data = await CommentsService.create(request.params.postId, authorId, input);
//   return reply.code(201).send({ success: true, data });
// }

// async function moderateComment(
//   request: FastifyRequest<{ Params: { commentId: string } }>,
//   reply: FastifyReply
// ) {
//   const input = ModerateCommentSchema.parse(request.body);
//   const editorId = (request.user as AuthenticatedUser).id;
//   const data = await CommentsService.moderate(
//     request.params.commentId,
//     input,
//     editorId
//   );
//   if (!data) {
//     return reply.code(404).send({
//       success: false,
//       error: { code: "NOT_FOUND", message: "Comment not found" },
//     });
//   }
//   return reply.send({ success: true, data });
// }

// async function deleteComment(
//   request: FastifyRequest<{ Params: { commentId: string } }>,
//   reply: FastifyReply
// ) {
//   const user = request.user as AuthenticatedUser;
//   await CommentsService.delete(
//     request.params.commentId,
//     user.id,
//     ["editor", "admin"].includes(user.role)
//   );
//   return reply.code(204).send();
// }

// async function likeComment(
//   request: FastifyRequest<{ Params: { commentId: string } }>,
//   reply: FastifyReply
// ) {
//   await CommentsService.likeComment(request.params.commentId);
//   return reply.send({ success: true });
// }

// // ─────────────────────────────────────────────────────────────────────
// // Plugin registration
// // ─────────────────────────────────────────────────────────────────────

// export async function commentsRoutes(fastify: FastifyInstance) {
//   // List comments on a post (public — approved only; editors see all statuses)
//   fastify.get<{ Params: { postId: string } }>(
//     "/posts/:postId/comments",
//     commentsRoutes.prototype,
//     listComments
//   );

//   // Create comment (authenticated users)
//   fastify.post<{ Params: { postId: string } }>(
//     "/posts/:postId/comments",
//     { preHandler: [authenticate] },
//     createComment
//   );

//   // Moderate (editors/admin)
//   fastify.patch<{ Params: { commentId: string } }>(
//     "/comments/:commentId/moderate",
//     { preHandler: [authenticate, requireEditor] },
//     moderateComment
//   );

//   // Delete
//   fastify.delete<{ Params: { commentId: string } }>(
//     "/comments/:commentId",
//     { preHandler: [authenticate] },
//     deleteComment
//   );

//   // Like a comment
//   fastify.post<{ Params: { commentId: string } }>(
//     "/comments/:commentId/like",
//     { preHandler: [authenticate] },
//     likeComment
//   );
// }

// // Fix: register without prototype
// export async function registerCommentsRoutes(fastify: FastifyInstance) {
//   fastify.get<{ Params: { postId: string } }>(
//     "/posts/:postId/comments",
//     listComments
//   );
//   fastify.post<{ Params: { postId: string } }>(
//     "/posts/:postId/comments",
//     { preHandler: [authenticate] },
//     createComment
//   );
//   fastify.patch<{ Params: { commentId: string } }>(
//     "/comments/:commentId/moderate",
//     { preHandler: [authenticate, requireEditor] },
//     moderateComment
//   );
//   fastify.delete<{ Params: { commentId: string } }>(
//     "/comments/:commentId",
//     { preHandler: [authenticate] },
//     deleteComment
//   );
//   fastify.post<{ Params: { commentId: string } }>(
//     "/comments/:commentId/like",
//     { preHandler: [authenticate] },
//     likeComment
//   );
// }