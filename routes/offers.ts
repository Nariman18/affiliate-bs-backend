import { Router } from "express";
import { PrismaClient } from "@prisma/client";
import {
  authenticate,
  requireAdmin,
  requireManager,
  requireAdminOrBasic,
  AuthRequest,
  ROLES,
} from "../middleware/auth";

const router = Router();
const prisma = new PrismaClient();

router.get("/", authenticate, async (req: AuthRequest, res) => {
  try {
    const { category, country, status } = req.query;
    const where: any = {};
    if (category) where.category = category;
    if (country) where.targetCountry = country;
    where.status =
      req.user!.role === ROLES.ADMIN ? (status ?? undefined) : "ACTIVE";

    const offers = await prisma.offer.findMany({
      where,
      include: {
        createdBy: { select: { username: true } },
        _count: { select: { offerRequests: true, links: true } },
      },
      orderBy: { createdAt: "desc" },
    });

    if (req.user!.role === ROLES.MANAGER) {
      const requests = await prisma.offerRequest.findMany({
        where: { userId: req.user!.userId },
        select: { offerId: true, status: true },
      });
      const map = new Map(requests.map((r) => [r.offerId, r.status]));
      return res.json(
        offers.map((o) => ({ ...o, myRequestStatus: map.get(o.id) ?? null })),
      );
    }

    res.json(offers);
  } catch {
    res.status(500).json({ error: "Failed to fetch offers" });
  }
});

router.get("/:id", authenticate, async (req: AuthRequest, res) => {
  try {
    const id = req.params.id as string;
    const offer = await prisma.offer.findUnique({
      where: { id },
      include: {
        createdBy: { select: { username: true, email: true } },
        _count: { select: { links: true, offerRequests: true } },
      },
    });
    if (!offer) return res.status(404).json({ error: "Offer not found" });

    // Don't expose casinoUrl to Managers
    if (req.user!.role === ROLES.MANAGER) {
      const { casinoUrl: _, ...safe } = offer as any;
      return res.json(safe);
    }
    res.json(offer);
  } catch {
    res.status(500).json({ error: "Failed to fetch offer" });
  }
});

router.post("/", authenticate, requireAdmin, async (req: AuthRequest, res) => {
  try {
    const {
      name,
      category,
      description,
      casinoUrl,
      targetCountry,
      commissionPct,
    } = req.body;
    if (!name?.trim())
      return res.status(400).json({ error: "Offer name is required" });
    if (!category?.trim())
      return res.status(400).json({ error: "Category is required" });
    if (!casinoUrl?.trim())
      return res.status(400).json({ error: "Casino URL is required" });

    const offer = await prisma.offer.create({
      data: {
        name,
        category,
        description,
        casinoUrl,
        targetCountry,
        commissionPct: commissionPct ?? 10,
        createdById: req.user!.userId,
      },
    });
    res.status(201).json(offer);
  } catch {
    res.status(500).json({ error: "Failed to create offer" });
  }
});

router.patch(
  "/:id",
  authenticate,
  requireAdmin,
  async (req: AuthRequest, res) => {
    try {
      const id = req.params.id as string;
      const allowed = [
        "name",
        "category",
        "description",
        "casinoUrl",
        "targetCountry",
        "commissionPct",
        "status",
      ];
      const data: any = {};
      for (const key of allowed)
        if (req.body[key] !== undefined) data[key] = req.body[key];
      const offer = await prisma.offer.update({ where: { id }, data });
      res.json(offer);
    } catch {
      res.status(500).json({ error: "Failed to update offer" });
    }
  },
);

router.post(
  "/:id/request",
  authenticate,
  requireManager,
  async (req: AuthRequest, res) => {
    try {
      const id = req.params.id as string;
      const offer = await prisma.offer.findUnique({ where: { id } });
      if (!offer || offer.status !== "ACTIVE")
        return res.status(404).json({ error: "Offer not found or inactive" });

      const existing = await prisma.offerRequest.findUnique({
        where: { userId_offerId: { userId: req.user!.userId, offerId: id } },
      });
      if (existing)
        return res
          .status(409)
          .json({
            error: "Request already submitted",
            status: existing.status,
          });

      const request = await prisma.offerRequest.create({
        data: { userId: req.user!.userId, offerId: id },
      });
      res.status(201).json(request);
    } catch {
      res.status(500).json({ error: "Failed to submit request" });
    }
  },
);

router.get(
  "/:id/requests",
  authenticate,
  requireAdminOrBasic,
  async (req: AuthRequest, res) => {
    try {
      const offerId = req.params.id as string;
      const where: any = { offerId };
      if (req.user!.role === ROLES.BASIC) {
        const teamIds = (
          await prisma.user.findMany({
            where: { supervisorId: req.user!.userId },
            select: { id: true },
          })
        ).map((u) => u.id);
        where.userId = { in: teamIds };
      }
      const requests = await prisma.offerRequest.findMany({
        where,
        include: {
          user: {
            select: { id: true, username: true, email: true, role: true },
          },
        },
        orderBy: { createdAt: "desc" },
      });
      res.json(requests);
    } catch {
      res.status(500).json({ error: "Failed to fetch requests" });
    }
  },
);

router.patch(
  "/:id/requests/:reqId",
  authenticate,
  requireAdminOrBasic,
  async (req: AuthRequest, res) => {
    try {
      const reqId = req.params.reqId as string;
      const { status } = req.body as { status: "APPROVED" | "REJECTED" };
      if (!["APPROVED", "REJECTED"].includes(status))
        return res
          .status(400)
          .json({ error: "status must be APPROVED or REJECTED" });

      const request = await prisma.offerRequest.findUnique({
        where: { id: reqId },
        include: { user: { select: { supervisorId: true } } },
      });
      if (!request) return res.status(404).json({ error: "Request not found" });

      if (
        req.user!.role === ROLES.BASIC &&
        request.user.supervisorId !== req.user!.userId
      )
        return res
          .status(403)
          .json({ error: "This request is not from your team" });

      const updated = await prisma.offerRequest.update({
        where: { id: reqId },
        data: { status },
      });
      res.json(updated);
    } catch {
      res.status(500).json({ error: "Failed to update request" });
    }
  },
);

export default router;
