-- CreateTable
CREATE TABLE "StockSettings" (
    "id" TEXT NOT NULL PRIMARY KEY DEFAULT 'singleton',
    "pixabayKeyEnc" TEXT,
    "pexelsKeyEnc" TEXT,
    "openverseClientId" TEXT,
    "openverseClientSecretEnc" TEXT,
    "updatedAt" DATETIME NOT NULL
);
