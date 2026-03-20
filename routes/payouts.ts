import { Router } from "express";
import { PrismaClient } from "@prisma/client";
import {
  authenticate,
  requireAdmin,
  AuthRequest,
  ROLES,
} from "../middleware/auth";

const router = Router();
const prisma = new PrismaClient();

// ── GET /payouts -> Returns FTDs (Deposits) and their commissions ─────────────
router.get("/", authenticate, async (req: AuthRequest, res) => {
  try {
    const isAdmin = req.user!.role === ROLES.ADMIN;
    const { status } = req.query;

    const where: any = {
      ...(status && status !== "all" ? { status: status as string } : {}),
      // Basic Subs/Managers only see FTDs they earned a commission on
      ...(isAdmin
        ? {}
        : { commissions: { some: { recipientId: req.user!.userId } } }),
    };

    const deposits = await prisma.deposit.findMany({
      where,
      include: {
        link: { include: { offer: { select: { name: true } } } },
        commissions: {
          include: {
            recipient: {
              select: {
                id: true,
                username: true,
                email: true,
                role: true,
                profile: true,
              },
            },
          },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    // Grab default wallets for all commission recipients dynamically
    const recipientIds = [
      ...new Set(
        deposits.flatMap((d) => d.commissions.map((c) => c.recipientId)),
      ),
    ];
    const wallets = await prisma.paymentMethod.findMany({
      where: { userId: { in: recipientIds }, isDefault: true },
    });
    const walletMap = new Map(wallets.map((w) => [w.userId, w]));

    const enriched = deposits.map((d) => ({
      id: d.id,
      status: d.status,
      createdAt: d.createdAt,
      amount: d.amount,
      currency: d.currency,
      subId: d.subId,
      offerName: d.link?.offer?.name ?? "Unknown Offer",
      commissions: d.commissions.map((c) => ({
        id: c.id,
        amount: c.amount,
        status: c.status,
        recipient: c.recipient,
        wallet: walletMap.get(c.recipientId) || null,
      })),
    }));

    res.json(enriched);
  } catch {
    res.status(500).json({ error: "Failed to fetch payouts" });
  }
});

// ── GET /payouts/stats ─────────────────────────────────────────────────────────
router.get("/stats", authenticate, async (req: AuthRequest, res) => {
  try {
    const isAdmin = req.user!.role === ROLES.ADMIN;
    const userFilter = isAdmin
      ? {}
      : { commissions: { some: { recipientId: req.user!.userId } } };

    const [pending, approved, paid] = await Promise.all([
      prisma.deposit.aggregate({
        where: { ...userFilter, status: "PENDING" },
        _sum: { amount: true },
        _count: true,
      }),
      prisma.deposit.aggregate({
        where: { ...userFilter, status: "APPROVED" },
        _sum: { amount: true },
        _count: true,
      }),
      prisma.deposit.aggregate({
        where: { ...userFilter, status: "PAID" },
        _sum: { amount: true },
        _count: true,
      }),
    ]);

    res.json({
      pending: { count: pending._count, amount: pending._sum.amount ?? 0 },
      approved: { count: approved._count, amount: approved._sum.amount ?? 0 },
      paid: { count: paid._count, amount: paid._sum.amount ?? 0 },
    });
  } catch {
    res.status(500).json({ error: "Failed to fetch payout stats" });
  }
});

// ── PATCH /payouts/:id/approve ─────────────────────────────────────────────────
router.patch(
  "/:id/approve",
  authenticate,
  requireAdmin,
  async (req: AuthRequest, res) => {
    try {
      const id = req.params.id as string;
      const deposit = await prisma.deposit.findUnique({
        where: { id },
        include: { commissions: true },
      });

      if (!deposit) return res.status(404).json({ error: "FTD not found" });
      if (deposit.status !== "PENDING")
        return res
          .status(400)
          .json({ error: `FTD is already ${deposit.status}` });

      await prisma.$transaction(async (tx) => {
        // 1. Approve Deposit
        await tx.deposit.update({
          where: { id },
          data: { status: "APPROVED" },
        });

        // 2. Approve all attached commissions & shift their balances
        for (const c of deposit.commissions) {
          if (c.status === "PENDING") {
            await tx.commission.update({
              where: { id: c.id },
              data: { status: "APPROVED", approvedAt: new Date() },
            });
            await tx.userProfile.update({
              where: { userId: c.recipientId },
              data: {
                pendingBalance: { decrement: c.amount },
                approvedBalance: { increment: c.amount },
              },
            });
          }
        }
      });
      res.json({ success: true });
    } catch {
      res.status(500).json({ error: "Failed to approve FTD" });
    }
  },
);

// ── PATCH /payouts/:id/pay ─────────────────────────────────────────────────────
router.patch(
  "/:id/pay",
  authenticate,
  requireAdmin,
  async (req: AuthRequest, res) => {
    try {
      const id = req.params.id as string;
      const { txHash, note } = req.body;
      const deposit = await prisma.deposit.findUnique({
        where: { id },
        include: { commissions: true },
      });

      if (!deposit) return res.status(404).json({ error: "FTD not found" });
      if (deposit.status !== "APPROVED")
        return res.status(400).json({ error: "Must be APPROVED to pay" });

      await prisma.$transaction(async (tx) => {
        // 1. Mark Deposit Paid
        await tx.deposit.update({ where: { id }, data: { status: "PAID" } });

        // 2. Mark Commissions Paid & shift balances
        for (const c of deposit.commissions) {
          if (c.status === "APPROVED") {
            await tx.commission.update({
              where: { id: c.id },
              data: {
                status: "PAID",
                paidAt: new Date(),
                note: txHash
                  ? `TxHash: ${txHash}${note ? ` | ${note}` : ""}`
                  : note,
              },
            });
            await tx.userProfile.update({
              where: { userId: c.recipientId },
              data: {
                approvedBalance: { decrement: c.amount },
                paidBalance: { increment: c.amount },
              },
            });
          }
        }
      });
      res.json({ success: true });
    } catch {
      res.status(500).json({ error: "Failed to mark paid" });
    }
  },
);

// ── PATCH /payouts/:id/trash ───────────────────────────────────────────────────
router.patch(
  "/:id/trash",
  authenticate,
  requireAdmin,
  async (req: AuthRequest, res) => {
    try {
      const id = req.params.id as string;
      const deposit = await prisma.deposit.findUnique({
        where: { id },
        include: { commissions: true },
      });

      if (!deposit) return res.status(404).json({ error: "FTD not found" });
      if (deposit.status === "PAID")
        return res.status(400).json({ error: "Cannot trash paid deposit" });

      await prisma.$transaction(async (tx) => {
        // 1. Trash Deposit
        await tx.deposit.update({
          where: { id },
          data: { status: "TRASHED" },
        });

        // 2. Revert Balances & Delete Commissions so they don't count towards metrics
        for (const c of deposit.commissions) {
          if (c.status === "PENDING") {
            await tx.userProfile.update({
              where: { userId: c.recipientId },
              data: { pendingBalance: { decrement: c.amount } },
            });
          } else if (c.status === "APPROVED") {
            await tx.userProfile.update({
              where: { userId: c.recipientId },
              data: { approvedBalance: { decrement: c.amount } },
            });
          }
          await tx.commission.delete({ where: { id: c.id } });
        }
      });
      res.json({ success: true });
    } catch {
      res.status(500).json({ error: "Failed to trash deposit" });
    }
  },
);

export default router;
