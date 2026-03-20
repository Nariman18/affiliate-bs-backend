-- AlterTable
ALTER TABLE "Offer" ADD COLUMN     "geoTargets" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "isVisible" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "logoUrl" TEXT,
ADD COLUMN     "minDeposit" DOUBLE PRECISION;

-- AlterTable
ALTER TABLE "UserProfile" ADD COLUMN     "avatarUrl" TEXT;
