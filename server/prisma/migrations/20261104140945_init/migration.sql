-- CreateTable
CREATE TABLE "Game" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "gameType" TEXT NOT NULL,
    "boardState" TEXT NOT NULL,
    "moveHistory" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'playing',
    "winner" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
