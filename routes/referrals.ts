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

// ── GET /referrals/link — get this user's invite / referral link ───────────────
// Only Admin and Basic Sub can invite people.
// Admin   → link that registers a BASIC_SUB_AFFILIATE
// Basic   → link that registers an AFFILIATE_MANAGER
router.get(
  "/link",
  authenticate,
  requireAdminOrBasic,
  async (req: AuthRequest, res) => {
    const { userId, role } = req.user!;
    const targetRole = role === ROLES.ADMIN ? ROLES.BASIC : ROLES.MANAGER;
    const base = process.env.FRONTEND_URL ?? "http://localhost:3000";
    res.json({
      link: `${base}/register?ref=${userId}&role=${targetRole}`,
      targetRole,
    });
  },
);

// ── GET /referrals/mine — list subordinates (the users this person invited) ────
// Returns the users directly supervised by the requesting user, enriched with
// 30-day commission totals so the frontend can show "earnings from referrals".
router.get(
  "/mine",
  authenticate,
  requireAdminOrBasic,
  async (req: AuthRequest, res) => {
    try {
      const { userId } = req.user!;

      const subordinates = await prisma.user.findMany({
        where: { supervisorId: userId },
        include: {
          profile: {
            select: {
              displayName: true,
              pendingBalance: true,
              approvedBalance: true,
            },
          },
        },
        orderBy: { createdAt: "desc" },
      });

      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

      const enriched = await Promise.all(
        subordinates.map(async (sub) => {
          // Total commissions earned BY the subordinate in the last 30 days
          const theirCommissions = await prisma.commission.aggregate({
            where: {
              recipientId: sub.id,
              createdAt: { gte: thirtyDaysAgo },
            },
            _sum: { amount: true },
          });

          // MY commissions that came from this subordinate's deposits (Basic Sub only)
          // = commissions on deposits made via links owned by this subordinate
          const myEarnings = await prisma.commission.aggregate({
            where: {
              recipientId: userId,
              deposit: { link: { affiliateId: sub.id } },
              createdAt: { gte: thirtyDaysAgo },
            },
            _sum: { amount: true },
          });

          const totalLifetime = await prisma.commission.aggregate({
            where: {
              recipientId: userId,
              deposit: { link: { affiliateId: sub.id } },
            },
            _sum: { amount: true },
          });

          return {
            id: sub.id,
            username: sub.username,
            email: sub.email,
            role: sub.role,
            displayName: sub.profile?.displayName ?? sub.username,
            pendingBalance: sub.profile?.pendingBalance ?? 0,
            approvedBalance: sub.profile?.approvedBalance ?? 0,
            thirtyDaySubCommission: theirCommissions._sum.amount ?? 0,
            myThirtyDayEarnings: myEarnings._sum.amount ?? 0,
            totalEarned: totalLifetime._sum.amount ?? 0,
            joinedAt: sub.createdAt,
          };
        }),
      );

      res.json(enriched);
    } catch {
      res.status(500).json({ error: "Failed to fetch referrals" });
    }
  },
);

// ── GET /referrals/stats ───────────────────────────────────────────────────────
router.get(
  "/stats",
  authenticate,
  requireAdminOrBasic,
  async (req: AuthRequest, res) => {
    try {
      const { userId } = req.user!;

      const [subordinateCount, totalEarned, profile] = await Promise.all([
        prisma.user.count({ where: { supervisorId: userId } }),
        prisma.commission.aggregate({
          where: { recipientId: userId },
          _sum: { amount: true },
        }),
        prisma.userProfile.findUnique({
          where: { userId },
          select: {
            pendingBalance: true,
            approvedBalance: true,
            paidBalance: true,
          },
        }),
      ]);

      res.json({
        totalReferrals: subordinateCount,
        totalEarned: totalEarned._sum.amount ?? 0,
        pendingBalance: profile?.pendingBalance ?? 0,
        approvedBalance: profile?.approvedBalance ?? 0,
        paidBalance: profile?.paidBalance ?? 0,
      });
    } catch {
      res.status(500).json({ error: "Failed to fetch referral stats" });
    }
  },
);

export default router;
