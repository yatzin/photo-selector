-- CreateTable
CREATE TABLE "AiSettings" (
    "id" TEXT NOT NULL PRIMARY KEY DEFAULT 'singleton',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "baseUrl" TEXT,
    "apiKeyEnc" TEXT,
    "model" TEXT,
    "temperature" REAL,
    "maxTokens" INTEGER,
    "timeoutSeconds" INTEGER,
    "extraBody" TEXT,
    "customPrompt" TEXT,
    "groupWindowSeconds" INTEGER NOT NULL DEFAULT 60,
    "similarity" TEXT NOT NULL DEFAULT 'similar',
    "imageMaxPx" INTEGER NOT NULL DEFAULT 768,
    "maxGroupSize" INTEGER NOT NULL DEFAULT 12,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "AiRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "root" TEXT NOT NULL,
    "folder" TEXT NOT NULL,
    "fresh" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "photoCount" INTEGER NOT NULL DEFAULT 0,
    "groupCount" INTEGER NOT NULL DEFAULT 0,
    "analyzedCount" INTEGER NOT NULL DEFAULT 0,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "model" TEXT,
    "error" TEXT,
    "createdById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" DATETIME,
    "groupedAt" DATETIME,
    "finishedAt" DATETIME,
    CONSTRAINT "AiRun_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AiGroup" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "runId" TEXT NOT NULL,
    "root" TEXT NOT NULL,
    "folder" TEXT NOT NULL,
    "takenAt" DATETIME NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "reason" TEXT,
    "error" TEXT,
    "trashBatchId" TEXT,
    "resolvedById" TEXT,
    "resolvedAt" DATETIME,
    CONSTRAINT "AiGroup_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AiRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AiGroup_resolvedById_fkey" FOREIGN KEY ("resolvedById") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AiGroupPhoto" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "groupId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "takenAt" DATETIME NOT NULL,
    "rank" INTEGER,
    "note" TEXT,
    "suggested" BOOLEAN NOT NULL DEFAULT false,
    "decision" TEXT,
    CONSTRAINT "AiGroupPhoto_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "AiGroup" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "AiRun_status_createdAt_idx" ON "AiRun"("status", "createdAt");

-- CreateIndex
CREATE INDEX "AiGroup_root_folder_status_idx" ON "AiGroup"("root", "folder", "status");

-- CreateIndex
CREATE INDEX "AiGroup_runId_status_idx" ON "AiGroup"("runId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "AiGroupPhoto_groupId_name_key" ON "AiGroupPhoto"("groupId", "name");
