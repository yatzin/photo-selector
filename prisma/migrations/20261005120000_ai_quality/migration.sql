-- AlterTable
ALTER TABLE "AiSettings" ADD COLUMN "qualityInstructions" TEXT;

-- AiShotStatus: SCREENSHOT renamed to FLAGGED (enums are stored as text in SQLite)
UPDATE "AiShot" SET "status" = 'FLAGGED' WHERE "status" = 'SCREENSHOT';
