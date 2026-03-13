import { Router } from "express";
import { PrismaClient } from "@prisma/client";
import { authenticate, AuthRequest } from "../middleware/auth";

const router = Router();
const prisma = new PrismaClient();

router.get("/balance", authenticate, async (req: AuthRequest, res) => {
  try {
    const profile = await prisma.userProfile.findUnique({
      where: { userId: req.user!.userId },
      select: {
        pendingBalance: true,
        approvedBalance: true,
        paidBalance: true,
      },
    });
    res.json({
      pendingBalance: profile?.pendingBalance ?? 0,
      approvedBalance: profile?.approvedBalance ?? 0,
      paidBalance: profile?.paidBalance ?? 0,
    });
  } catch {
    res.status(500).json({ error: "Failed to fetch balance" });
  }
});

router.get("/methods", authenticate, async (req: AuthRequest, res) => {
  try {
    const methods = await prisma.paymentMethod.findMany({
      where: { userId: req.user!.userId },
      orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
    });
    res.json(methods);
  } catch {
    res.status(500).json({ error: "Failed to fetch payment methods" });
  }
});

router.post("/methods", authenticate, async (req: AuthRequest, res) => {
  try {
    const { currency, network, address, label, isDefault } = req.body;
    if (!currency?.trim())
      return res.status(400).json({ error: "Currency is required" });
    if (!address?.trim())
      return res.status(400).json({ error: "Wallet address is required" });
    if (isDefault) {
      await prisma.paymentMethod.updateMany({
        where: { userId: req.user!.userId, isDefault: true },
        data: { isDefault: false },
      });
    }
    const method = await prisma.paymentMethod.create({
      data: {
        userId: req.user!.userId,
        currency: currency.toUpperCase(),
        network: network ?? "TRC20",
        address,
        label,
        isDefault: isDefault ?? false,
      },
    });
    res.status(201).json(method);
  } catch {
    res.status(500).json({ error: "Failed to add payment method" });
  }
});

router.patch("/methods/:id", authenticate, async (req: AuthRequest, res) => {
  try {
    const id = req.params.id as string;
    const method = await prisma.paymentMethod.findFirst({
      where: { id, userId: req.user!.userId },
    });
    if (!method)
      return res.status(404).json({ error: "Payment method not found" });
    const { isDefault, label } = req.body;
    if (isDefault) {
      await prisma.paymentMethod.updateMany({
        where: { userId: req.user!.userId, isDefault: true },
        data: { isDefault: false },
      });
    }
    const updated = await prisma.paymentMethod.update({
      where: { id },
      data: {
        ...(label !== undefined && { label }),
        ...(isDefault !== undefined && { isDefault }),
      },
    });
    res.json(updated);
  } catch {
    res.status(500).json({ error: "Failed to update payment method" });
  }
});

router.delete("/methods/:id", authenticate, async (req: AuthRequest, res) => {
  try {
    const id = req.params.id as string;
    const method = await prisma.paymentMethod.findFirst({
      where: { id, userId: req.user!.userId },
    });
    if (!method) return res.status(404).json({ error: "Not found" });
    if (method.isDefault) {
      const count = await prisma.paymentMethod.count({
        where: { userId: req.user!.userId },
      });
      if (count > 1)
        return res
          .status(400)
          .json({ error: "Set another method as default first" });
    }
    await prisma.paymentMethod.delete({ where: { id } });
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: "Failed to delete payment method" });
  }
});

export default router;
