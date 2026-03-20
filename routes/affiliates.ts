import { Router } from "express";
import { PrismaClient } from "@prisma/client";
import {
  authenticate,
  requireAdminOrBasic,
  AuthRequest,
  ROLES,
} from "../middleware/auth";

const router = Router();
const prisma = new PrismaClient();

// ── GET /affiliates — Admin or Basic Sub views their affiliate managers ─────────
router.get(
  "/",
  authenticate,
  requireAdminOrBasic,
  async (req: AuthRequest, res) => {
    try {
      const { userId, role } = req.user!;

      // For Admin: all managers across the platform
      // For Basic Sub: only their own managers
      const where =
        role === ROLES.ADMIN
          ? { role: ROLES.MANAGER as any }
          : { role: ROLES.MANAGER as any, supervisorId: userId };

      const managers = await prisma.user.findMany({
        where,
        include: {
          profile: {
            select: {
              displayName: true,
              pendingBalance: true,
              approvedBalance: true,
              avatarUrl: true, // <-- ADDED THIS
            },
          },
          paymentMethods: {
            where: { isDefault: true },
            take: 1,
            select: { address: true, network: true, currency: true },
          },
        },
        orderBy: { createdAt: "desc" },
      });

      const enriched = await Promise.all(
        managers.map(async (mgr) => {
          const [clicks, deposits, commissions] = await Promise.all([
            prisma.click.count({ where: { link: { affiliateId: mgr.id } } }),
            prisma.deposit.aggregate({
              where: { link: { affiliateId: mgr.id } },
              _sum: { amount: true },
              _count: true,
            }),
            prisma.commission.aggregate({
              where: { recipientId: mgr.id },
              _sum: { amount: true },
            }),
          ]);
          return {
            id: mgr.id,
            username: mgr.username,
            email: mgr.email,
            displayName: mgr.profile?.displayName ?? mgr.username,
            avatarUrl: mgr.profile?.avatarUrl ?? null, // <-- ADDED THIS
            pendingBalance: mgr.profile?.pendingBalance ?? 0,
            approvedBalance: mgr.profile?.approvedBalance ?? 0,
            defaultWallet: mgr.paymentMethods[0] ?? null,
            clicks,
            conversions: deposits._count,
            revenue: deposits._sum.amount ?? 0,
            commission: commissions._sum.amount ?? 0,
            joinedAt: mgr.createdAt,
          };
        }),
      );

      res.json(enriched);
    } catch {
      res.status(500).json({ error: "Failed to fetch affiliates" });
    }
  },
);

// ── GET /affiliates/me/profile ─────────────────────────────────────────────────
router.get("/me/profile", authenticate, async (req: AuthRequest, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.userId },
      include: { profile: true },
    });
    if (!user) return res.status(404).json({ error: "User not found" });
    res.json({
      id: user.id,
      email: user.email,
      role: user.role,
      supervisorId: user.supervisorId,
      profile: user.profile,
    });
  } catch {
    res.status(500).json({ error: "Failed to fetch profile" });
  }
});

// ── PATCH /affiliates/me/profile ───────────────────────────────────────────────
router.patch("/me/profile", authenticate, async (req: AuthRequest, res) => {
  try {
    const { displayName, telegramHandle } = req.body;
    const updated = await prisma.userProfile.upsert({
      where: { userId: req.user!.userId },
      update: { displayName, telegramHandle },
      create: { userId: req.user!.userId, displayName, telegramHandle },
    });
    res.json(updated);
  } catch {
    res.status(500).json({ error: "Failed to update profile" });
  }
});

export default router;
