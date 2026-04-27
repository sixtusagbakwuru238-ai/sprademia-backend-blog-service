-- Migration: add gradient column to authors table
-- Run with: npx prisma migrate deploy

ALTER TABLE "authors" ADD COLUMN IF NOT EXISTS "gradient" TEXT;


-- -- Migration: add gradient column to authors table
-- -- Run with: npx prisma migrate deploy

-- ALTER TABLE "authors" ADD COLUMN IF NOT EXISTS "gradient" TEXT;
