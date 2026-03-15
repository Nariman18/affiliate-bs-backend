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

router.get("/", authenticate, async (req: AuthRequest, res) => {
  try {
    const isAdmin = req.user!.role === ROLES.ADMIN;
    const { status } = req.query;
    const where: any = {
      ...(isAdmin ? {} : { userId: req.user!.userId }),
      ...(status ? { status } : {}),
    };
    const payouts = await prisma.payoutRequest.findMany({
      where,
      include: {
        user: {
          select: {
            username: true,
            email: true,
            profile: { select: { approvedBalance: true } },
          },
        },
        paymentMethod: true,
      },
      orderBy: { createdAt: "desc" },
    });
    res.json(payouts);
  } catch {
    res.status(500).json({ error: "Failed to fetch payouts" });
  }
});

router.get("/stats", authenticate, async (req: AuthRequest, res) => {
  try {
    const isAdmin = req.user!.role === ROLES.ADMIN;
    const userFilter = isAdmin ? {} : { userId: req.user!.userId };
    const [pending, approved, paid] = await Promise.all([
      prisma.payoutRequest.aggregate({
        where: { ...userFilter, status: "PENDING" },
        _sum: { amount: true },
        _count: true,
      }),
      prisma.payoutRequest.aggregate({
        where: { ...userFilter, status: "APPROVED" },
        _sum: { amount: true },
        _count: true,
      }),
      prisma.payoutRequest.aggregate({
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

router.post("/", authenticate, async (req: AuthRequest, res) => {
  try {
    const { amount, paymentMethodId } = req.body;
    const parsed = parseFloat(amount);
    if (!parsed || parsed <= 0)
      return res.status(400).json({ error: "Amount must be positive" });

    const profile = await prisma.userProfile.findUnique({
      where: { userId: req.user!.userId },
    });
    if (!profile) return res.status(404).json({ error: "Profile not found" });
    if (profile.approvedBalance < parsed)
      return res.status(400).json({ error: "Insufficient approved balance" });

    if (paymentMethodId) {
      const wallet = await prisma.paymentMethod.findFirst({
        where: { id: paymentMethodId as string, userId: req.user!.userId },
      });
      if (!wallet)
        return res.status(400).json({ error: "Payment method not found" });
    }

    const payout = await prisma.$transaction(async (tx) => {
      await tx.userProfile.update({
        where: { userId: req.user!.userId },
        data: { approvedBalance: { decrement: parsed } },
      });
      return tx.payoutRequest.create({
        data: {
          userId: req.user!.userId,
          amount: parsed,
          status: "PENDING",
          paymentMethodId: paymentMethodId ?? null,
        },
      });
    });
    res.status(201).json(payout);
  } catch {
    res.status(500).json({ error: "Failed to create payout request" });
  }
});

router.patch(
  "/:id/approve",
  authenticate,
  requireAdmin,
  async (req: AuthRequest, res) => {
    try {
      const id = req.params.id as string;
      const { note } = req.body;
      const payout = await prisma.payoutRequest.findUnique({ where: { id } });
      if (!payout) return res.status(404).json({ error: "Payout not found" });
      if (payout.status !== "PENDING")
        return res
          .status(400)
          .json({ error: `Payout is already ${payout.status}` });
      const updated = await prisma.payoutRequest.update({
        where: { id },
        data: { status: "APPROVED", note: note ?? null },
      });
      res.json(updated);
    } catch {
      res.status(500).json({ error: "Failed to approve payout" });
    }
  },
);

router.patch(
  "/:id/pay",
  authenticate,
  requireAdmin,
  async (req: AuthRequest, res) => {
    try {
      const id = req.params.id as string;
      const { txHash, note } = req.body;
      const payout = await prisma.payoutRequest.findUnique({ where: { id } });
      if (!payout) return res.status(404).json({ error: "Payout not found" });
      if (payout.status !== "APPROVED")
        return res
          .status(400)
          .json({ error: "Only APPROVED payouts can be marked PAID" });

      // 1. Fetch all currently APPROVED commissions for this user, oldest first
      const approvedCommissions = await prisma.commission.findMany({
        where: { recipientId: payout.userId, status: "APPROVED" },
        orderBy: { createdAt: "asc" },
      });

      // 2. FIFO loop: collect commission IDs until the payout amount is covered
      let amountToCover = payout.amount;
      const commissionIdsToPay: string[] = [];

      for (const c of approvedCommissions) {
        if (amountToCover <= 0.001) break; // Float safety
        commissionIdsToPay.push(c.id);
        amountToCover -= c.amount;
      }

      const updated = await prisma.$transaction(async (tx) => {
        // 3. Update the Payout Request
        const p = await tx.payoutRequest.update({
          where: { id },
          data: { status: "PAID", txHash: txHash ?? null, note: note ?? null },
        });

        // 4. Update the User's Profile Balances
        await tx.userProfile.update({
          where: { userId: payout.userId },
          data: { paidBalance: { increment: payout.amount } },
        });

        // 5. Update the underlying commissions to PAID so stats sync correctly
        if (commissionIdsToPay.length > 0) {
          await tx.commission.updateMany({
            where: { id: { in: commissionIdsToPay } },
            data: {
              status: "PAID",
              paidAt: new Date(),
              note: note
                ? `[Payout Processed] ${note}`
                : `Paid via Payout Request`,
            },
          });
        }

        return p;
      });
      res.json(updated);
    } catch {
      res.status(500).json({ error: "Failed to mark payout as paid" });
    }
  },
);

router.patch(
  "/:id/trash",
  authenticate,
  requireAdmin,
  async (req: AuthRequest, res) => {
    try {
      const id = req.params.id as string;
      const { note } = req.body;
      const payout = await prisma.payoutRequest.findUnique({ where: { id } });
      if (!payout) return res.status(404).json({ error: "Payout not found" });
      if (payout.status === "PAID")
        return res.status(400).json({ error: "Cannot trash a paid payout" });

      await prisma.$transaction(async (tx) => {
        await tx.userProfile.update({
          where: { userId: payout.userId },
          data: { approvedBalance: { increment: payout.amount } },
        });
        await tx.payoutRequest.update({
          where: { id },
          data: {
            status: "PENDING",
            note: `[TRASHED] ${note ?? "Marked as fraud"}`,
          },
        });
      });
      res.json({ success: true });
    } catch {
      res.status(500).json({ error: "Failed to trash payout" });
    }
  },
);

export default router;
