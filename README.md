# StudyNation Blog Service

Microservice responsible for blog posts, categories, tags, comments,
newsletter subscriptions and full-text search in the StudyNation platform.

## Tech Stack

| Layer        | Technology              | Why                                                              |
|--------------|-------------------------|------------------------------------------------------------------|
| Runtime      | Node.js 20+             | Consistent with the rest of the platform                        |
| Framework    | Fastify 4               | 3× faster than Express; TypeScript-first; plugin architecture   |
| Language     | TypeScript 5            | Type safety across all service boundaries                       |
| Database     | PostgreSQL 16           | Relational with native full-text search; Prisma migrations      |
| ORM          | Prisma 5                | Type-safe queries; auto-generated client; Prisma Studio UI      |
| Cache        | Redis 7 (ioredis)       | Response caching; view-count buffer; rate limiting; locks       |
| Message Bus  | RabbitMQ (amqplib)      | Async inter-service events; decoupled architecture              |
| Auth         | JWT (validated here)    | Stateless; issued by Auth service; validated per request        |
| Docs         | Swagger/OpenAPI         | Auto-generated; served at `/docs` in development               |
| Testing      | Vitest                  | ESM-native; fast; built-in coverage                            |
| Container    | Docker + Compose        | Reproducible environments; production-ready multi-stage build   |

---

## Quick Start

### 1. Prerequisites
- Node.js ≥ 20
- Docker (for PostgreSQL, Redis, RabbitMQ)

### 2. Install dependencies
```bash
npm install
```

### 3. Start infrastructure
```bash
docker compose up -d
```
This starts PostgreSQL (port 5432), Redis (6379) and RabbitMQ (5672 + management UI at 15672).

### 4. Configure environment
```bash
cp .env.example .env
# Edit .env — set JWT_SECRET and INTERNAL_API_KEY at minimum
```

### 5. Run database migrations and seed
```bash
npm run db:migrate     # Apply migrations
npm run db:seed        # Seed categories, tags and sample post
```

### 6. Start the development server
```bash
npm run dev
```
Service runs at `http://localhost:3002`.
Swagger docs at `http://localhost:3002/docs`.

---

## API Reference

All routes are prefixed with `/api/v1`.

### Posts

| Method | Path                          | Auth        | Description                         |
|--------|-------------------------------|-------------|-------------------------------------|
| GET    | `/posts`                      | Optional    | List posts (paginated, filterable)  |
| GET    | `/posts/:slug`                | Optional    | Get post by slug                    |
| GET    | `/posts/:id/related`          | None        | Get related posts                   |
| POST   | `/posts`                      | Editor+     | Create post                         |
| PATCH  | `/posts/:id`                  | Editor+     | Update post                         |
| DELETE | `/posts/:id`                  | Editor+     | Delete post                         |
| POST   | `/posts/:id/react`            | Logged in   | Like/bookmark/share a post          |
| GET    | `/posts/:id/revisions`        | Editor+     | View revision history               |

**List posts query params:** `page`, `limit`, `category`, `tag`, `author`, `status`, `featured`, `search`, `sortBy`, `sortOrder`

### Categories

| Method | Path                  | Auth     | Description             |
|--------|-----------------------|----------|-------------------------|
| GET    | `/categories`         | None     | List all categories     |
| GET    | `/categories/:slug`   | None     | Get category by slug    |
| POST   | `/categories`         | Editor+  | Create category         |
| PATCH  | `/categories/:id`     | Editor+  | Update category         |
| DELETE | `/categories/:id`     | Editor+  | Delete category         |

### Tags

| Method | Path             | Auth     | Description                         |
|--------|------------------|----------|-------------------------------------|
| GET    | `/tags`          | None     | List tags (`?popular=true` to sort) |
| GET    | `/tags/:slug`    | None     | Get tag by slug                     |
| POST   | `/tags`          | Editor+  | Create tag                          |
| DELETE | `/tags/:id`      | Editor+  | Delete tag                          |

### Comments

| Method | Path                              | Auth       | Description              |
|--------|-----------------------------------|------------|--------------------------|
| GET    | `/posts/:postId/comments`         | Optional   | List approved comments   |
| POST   | `/posts/:postId/comments`         | Logged in  | Create comment           |
| PATCH  | `/comments/:commentId/moderate`   | Editor+    | Approve/spam/delete      |
| DELETE | `/comments/:commentId`            | Logged in  | Delete own comment       |
| POST   | `/comments/:commentId/like`       | Logged in  | Like a comment           |

### Newsletter

| Method | Path                                 | Auth      | Description                   |
|--------|--------------------------------------|-----------|-------------------------------|
| POST   | `/newsletter/subscribe`              | None      | Subscribe with category prefs |
| GET    | `/newsletter/unsubscribe/:token`     | None      | Unsubscribe via token         |
| PATCH  | `/newsletter/preferences/:token`     | None      | Update category preferences   |
| GET    | `/newsletter/verify/:token`          | None      | Verify email address          |
| GET    | `/newsletter/subscribers`            | Editor+   | Admin: list subscribers       |
| GET    | `/newsletter/stats`                  | Editor+   | Admin: subscription stats     |

### Search

| Method | Path                | Auth  | Description              |
|--------|---------------------|-------|--------------------------|
| GET    | `/search`           | None  | Full-text search posts   |
| GET    | `/search/suggest`   | None  | Autocomplete suggestions |

### Authors

| Method | Path                    | Auth      | Description                    |
|--------|-------------------------|-----------|--------------------------------|
| GET    | `/authors/:id`          | None      | Get author profile             |
| GET    | `/authors/:id/posts`    | None      | List author's posts            |
| PUT    | `/internal/authors`     | API Key   | Upsert author (internal sync)  |

---

## RabbitMQ Events

### Published (this service → others)

| Routing Key                   | Payload fields                                                 |
|-------------------------------|----------------------------------------------------------------|
| `blog.post.published`         | `postId, slug, title, authorId, categorySlug, tags, publishedAt` |
| `blog.post.updated`           | `postId, slug`                                                |
| `blog.post.deleted`           | `postId, slug`                                                |
| `blog.comment.created`        | `commentId, postId, authorId, parentId`                       |
| `blog.comment.approved`       | `commentId, postId, moderatedBy`                              |
| `blog.newsletter.subscribed`  | `subscriberId, email, categories`                             |
| `blog.newsletter.unsubscribed`| `subscriberId, email`                                         |

### Consumed (other services → this service)

| Routing Key                   | Action                                              |
|-------------------------------|-----------------------------------------------------|
| `user.profile.updated`        | Sync author shadow table with updated profile data  |
| `user.account.deleted`        | Anonymise all posts and comments for deleted user   |

---

## Project Structure

```
blog-service/
├── prisma/
│   ├── schema.prisma       # Database schema
│   └── seed.ts             # Seed script
├── src/
│   ├── config/             # Zod-validated environment config
│   ├── jobs/               # Background jobs (view flush, scheduler)
│   ├── lib/
│   │   ├── content.ts      # Slug, markdown, reading time, excerpt
│   │   ├── event-consumers.ts  # RabbitMQ subscriptions
│   │   ├── message-bus.ts  # RabbitMQ publish/subscribe
│   │   ├── prisma.ts       # Prisma singleton
│   │   └── redis.ts        # Redis client + cache helpers
│   ├── middleware/
│   │   └── auth.ts         # JWT verification + role guards
│   ├── modules/
│   │   ├── authors/        # Author profile sync (shadow table)
│   │   ├── categories/     # Category CRUD
│   │   ├── comments/       # Threaded comments + moderation
│   │   ├── newsletter/     # Subscriber management
│   │   ├── posts/          # Post CRUD, reactions, revisions
│   │   ├── search/         # Full-text search + autocomplete
│   │   └── tags/           # Tag CRUD
│   ├── plugins/            # Fastify plugin registrations
│   ├── types/              # Shared TypeScript types
│   └── server.ts           # Entry point
├── .env.example
├── docker-compose.yml
├── Dockerfile
└── package.json
```

---

## Running Tests

```bash
npm test             # Run all tests once
npm run test:watch   # Watch mode
npm run test:cov     # With coverage report
```

---

## Deployment

### Build Docker image
```bash
docker build -t studynation/blog-service:latest .
```

### Run production migrations (before deploying new version)
```bash
npm run db:migrate:prod
```

### Environment variables required in production
- `DATABASE_URL` — PostgreSQL connection string
- `REDIS_URL` — Redis connection string  
- `RABBITMQ_URL` — RabbitMQ AMQP URL
- `JWT_SECRET` — Must match Auth service secret (min 32 chars)
- `INTERNAL_API_KEY` — Shared secret for internal service calls
