// src/config/index.ts
// Centralised, type-safe configuration.
// Fails fast at startup if any required env var is missing.

import { z } from "zod";
import * as dotenv from "dotenv";

dotenv.config();

const configSchema = z.object({
  // Server
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().default(3002),
  HOST: z.string().default("0.0.0.0"),
  SERVICE_NAME: z.string().default("blog-service"),

  // Database
  DATABASE_URL: z.string().url("DATABASE_URL must be a valid PostgreSQL URL"),

  // Redis
  REDIS_URL: z.string().url("REDIS_URL must be a valid Redis URL"),

  // RabbitMQ
  RABBITMQ_URL: z.string().url("RABBITMQ_URL must be a valid AMQP URL"),
  RABBITMQ_EXCHANGE: z.string().default("studynation.events"),

  // Auth
  JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 characters"),
  INTERNAL_API_KEY: z.string().min(16, "INTERNAL_API_KEY must be at least 16 characters"),

  // Cache TTLs
  CACHE_TTL_POSTS: z.coerce.number().default(300),
  CACHE_TTL_POST: z.coerce.number().default(600),
  CACHE_TTL_CATEGORIES: z.coerce.number().default(3600),
  CACHE_TTL_TAGS: z.coerce.number().default(1800),

  // Rate limiting
  RATE_LIMIT_MAX: z.coerce.number().default(120),
  RATE_LIMIT_WINDOW: z.coerce.number().default(60_000),

  // Content
  MAX_CONTENT_LENGTH_MB: z.coerce.number().default(5),
  ALLOWED_IMAGE_HOSTS: z.string().default("res.cloudinary.com,imagedelivery.net,studynation.ng"),

  // Pagination
  DEFAULT_PAGE_SIZE: z.coerce.number().default(12),
  MAX_PAGE_SIZE: z.coerce.number().default(200),

  // Logging
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),

  // CORS
  CORS_ORIGINS: z.string().default("http://localhost:3000"),
});

function loadConfig() {
  const result = configSchema.safeParse(process.env);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  • ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  return result.data;
}

export const config = loadConfig();

export type Config = typeof config;

// Derived helpers
export const isDev = config.NODE_ENV === "development";
export const isProd = config.NODE_ENV === "production";
export const isTest = config.NODE_ENV === "test";

export const allowedImageHosts = config.ALLOWED_IMAGE_HOSTS.split(",").map((h) => h.trim());
export const corsOrigins = config.CORS_ORIGINS.split(",").map((o) => o.trim());




// // src/config/index.ts
// // Centralised, type-safe configuration.
// // Fails fast at startup if any required env var is missing.

// import { z } from "zod";
// import * as dotenv from "dotenv";

// dotenv.config();

// const configSchema = z.object({
//   // Server
//   NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
//   PORT: z.coerce.number().default(3002),
//   HOST: z.string().default("0.0.0.0"),
//   SERVICE_NAME: z.string().default("blog-service"),

//   // Database
//   DATABASE_URL: z.string().url("DATABASE_URL must be a valid PostgreSQL URL"),

//   // Redis
//   REDIS_URL: z.string().url("REDIS_URL must be a valid Redis URL"),

//   // RabbitMQ
//   RABBITMQ_URL: z.string().url("RABBITMQ_URL must be a valid AMQP URL"),
//   RABBITMQ_EXCHANGE: z.string().default("studynation.events"),

//   // Auth
//   JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 characters"),
//   INTERNAL_API_KEY: z.string().min(16, "INTERNAL_API_KEY must be at least 16 characters"),

//   // Cache TTLs
//   CACHE_TTL_POSTS: z.coerce.number().default(300),
//   CACHE_TTL_POST: z.coerce.number().default(600),
//   CACHE_TTL_CATEGORIES: z.coerce.number().default(3600),
//   CACHE_TTL_TAGS: z.coerce.number().default(1800),

//   // Rate limiting
//   RATE_LIMIT_MAX: z.coerce.number().default(120),
//   RATE_LIMIT_WINDOW: z.coerce.number().default(60_000),

//   // Content
//   MAX_CONTENT_LENGTH_MB: z.coerce.number().default(5),
//   ALLOWED_IMAGE_HOSTS: z.string().default("res.cloudinary.com,imagedelivery.net,studynation.ng"),

//   // Pagination
//   DEFAULT_PAGE_SIZE: z.coerce.number().default(12),
//   MAX_PAGE_SIZE: z.coerce.number().default(200),

//   // Logging
//   LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),

//   // CORS
//   CORS_ORIGINS: z.string().default("http://localhost:3000"),
// });

// function loadConfig() {
//   const result = configSchema.safeParse(process.env);
//   if (!result.success) {
//     const issues = result.error.issues
//       .map((i) => `  • ${i.path.join(".")}: ${i.message}`)
//       .join("\n");
//     throw new Error(`Invalid configuration:\n${issues}`);
//   }
//   return result.data;
// }

// export const config = loadConfig();

// export type Config = typeof config;

// // Derived helpers
// export const isDev = config.NODE_ENV === "development";
// export const isProd = config.NODE_ENV === "production";
// export const isTest = config.NODE_ENV === "test";

// export const allowedImageHosts = config.ALLOWED_IMAGE_HOSTS.split(",").map((h) => h.trim());
// export const corsOrigins = config.CORS_ORIGINS.split(",").map((o) => o.trim());



// // src/config/index.ts
// // Centralised, type-safe configuration.
// // Fails fast at startup if any required env var is missing.

// import { z } from "zod";
// import * as dotenv from "dotenv";

// dotenv.config();

// const configSchema = z.object({
//   // Server
//   NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
//   PORT: z.coerce.number().default(3002),
//   HOST: z.string().default("0.0.0.0"),
//   SERVICE_NAME: z.string().default("blog-service"),

//   // Database
//   DATABASE_URL: z.string().url("DATABASE_URL must be a valid PostgreSQL URL"),

//   // Redis
//   REDIS_URL: z.string().url("REDIS_URL must be a valid Redis URL"),

//   // RabbitMQ
//   RABBITMQ_URL: z.string().url("RABBITMQ_URL must be a valid AMQP URL"),
//   RABBITMQ_EXCHANGE: z.string().default("sprademia.events"),

//   // Auth
//   JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 characters"),
//   INTERNAL_API_KEY: z.string().min(16, "INTERNAL_API_KEY must be at least 16 characters"),

//   // Cache TTLs
//   CACHE_TTL_POSTS: z.coerce.number().default(300),
//   CACHE_TTL_POST: z.coerce.number().default(600),
//   CACHE_TTL_CATEGORIES: z.coerce.number().default(3600),
//   CACHE_TTL_TAGS: z.coerce.number().default(1800),

//   // Rate limiting
//   RATE_LIMIT_MAX: z.coerce.number().default(120),
//   RATE_LIMIT_WINDOW: z.coerce.number().default(60_000),

//   // Content
//   MAX_CONTENT_LENGTH_MB: z.coerce.number().default(5),
//   ALLOWED_IMAGE_HOSTS: z.string().default("res.cloudinary.com,imagedelivery.net,sprademia.ng"),

//   // Pagination
//   DEFAULT_PAGE_SIZE: z.coerce.number().default(12),
//   MAX_PAGE_SIZE: z.coerce.number().default(50),

//   // Logging
//   LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),

//   // CORS
//   CORS_ORIGINS: z.string().default("http://localhost:3000"),
// });

// function loadConfig() {
//   const result = configSchema.safeParse(process.env);
//   if (!result.success) {
//     const issues = result.error.issues
//       .map((i) => `  • ${i.path.join(".")}: ${i.message}`)
//       .join("\n");
//     throw new Error(`Invalid configuration:\n${issues}`);
//   }
//   return result.data;
// }

// export const config = loadConfig();

// export type Config = typeof config;

// // Derived helpers
// export const isDev = config.NODE_ENV === "development";
// export const isProd = config.NODE_ENV === "production";
// export const isTest = config.NODE_ENV === "test";

// export const allowedImageHosts = config.ALLOWED_IMAGE_HOSTS.split(",").map((h) => h.trim());
// export const corsOrigins = config.CORS_ORIGINS.split(",").map((o) => o.trim());