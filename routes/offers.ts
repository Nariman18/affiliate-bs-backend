import { Router } from "express";
import { PrismaClient } from "@prisma/client";
import { Storage } from "@google-cloud/storage";
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

const storage = new Storage({
  projectId: process.env.GCS_PROJECT_ID,
  credentials: {
    client_email: process.env.GCS_CLIENT_EMAIL,
    private_key: process.env.GCS_PRIVATE_KEY?.replace(/\\n/g, "\n"),
  },
});
const bucket = storage.bucket(process.env.GCS_BUCKET_NAME || "");

// Helper to validate URL format
const isValidUrl = (urlString: string) => {
  try {
    return Boolean(new URL(urlString));
  } catch (e) {
    return false;
  }
};

// ─── POST /api/offers/upload-url ──────────────────────────────────────────────
router.post(
  "/upload-url",
  authenticate,
  requireAdmin,
  async (req: AuthRequest, res) => {
    try {
      const { filename, contentType } = req.body;
      if (!filename || !contentType) {
        return res
          .status(400)
          .json({ error: "Filename and contentType are required" });
      }
      const uniqueFilename = `offers/logos/${Date.now()}-${filename.replace(/\s+/g, "_")}`;
      const file = bucket.file(uniqueFilename);
      const [uploadUrl] = await file.getSignedUrl({
        version: "v4",
        action: "write",
        expires: Date.now() + 15 * 60 * 1000,
        contentType,
      });
      const publicUrl = `https://storage.googleapis.com/${bucket.name}/${uniqueFilename}`;
      res.json({ uploadUrl, publicUrl, fileKey: uniqueFilename });
    } catch (error) {
      console.error("GCS Signed URL Error:", error);
      res.status(500).json({ error: "Failed to generate upload URL" });
    }
  },
);

// ─── GET /api/offers ─────────────────────────────────────────────────────────
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
        starredBy: { where: { id: req.user!.userId }, select: { id: true } },
      },
      orderBy: { createdAt: "desc" },
    });

    const processedOffers = offers.map((o) => ({
      ...o,
      isStarred: o.starredBy.length > 0,
      starredBy: undefined,
    }));

    if (req.user!.role === ROLES.MANAGER) {
      const requests = await prisma.offerRequest.findMany({
        where: { userId: req.user!.userId },
        select: { offerId: true, status: true },
      });
      const map = new Map(requests.map((r) => [r.offerId, r.status]));
      return res.json(
        processedOffers.map((o) => ({
          ...o,
          myRequestStatus: map.get(o.id) ?? null,
        })),
      );
    }

    res.json(processedOffers);
  } catch {
    res.status(500).json({ error: "Failed to fetch offers" });
  }
});

// ─── POST /api/offers/:id/star (Toggle Star) ──────────────────────────────────
router.post("/:id/star", authenticate, async (req: AuthRequest, res) => {
  try {
    const offerId = req.params.id as string;
    const userId = req.user!.userId;

    const offer = await prisma.offer.findUnique({
      where: { id: offerId },
      include: { starredBy: { where: { id: userId } } },
    });

    if (!offer) return res.status(404).json({ error: "Offer not found" });

    if (offer.starredBy.length > 0) {
      await prisma.offer.update({
        where: { id: offerId },
        data: { starredBy: { disconnect: { id: userId } } },
      });
      return res.json({ isStarred: false });
    } else {
      await prisma.offer.update({
        where: { id: offerId },
        data: { starredBy: { connect: { id: userId } } },
      });
      return res.json({ isStarred: true });
    }
  } catch {
    res.status(500).json({ error: "Failed to toggle star" });
  }
});

// ─── GET /api/offers/:id ─────────────────────────────────────────────────────
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

    // NO LONGER STRIPPING casinoUrl FOR MANAGERS
    res.json(offer);
  } catch {
    res.status(500).json({ error: "Failed to fetch offer" });
  }
});

// ─── POST /api/offers (Create Offer) ──────────────────────────────────────────
router.post("/", authenticate, requireAdmin, async (req: AuthRequest, res) => {
  try {
    const {
      name,
      category,
      description,
      casinoUrl,
      targetCountry,
      logoUrl,
      geoTargets,
      minDeposit,
      regPayout,
      isVisible,
      isNew,
      isTop,
      isExclusive,
    } = req.body;

    if (!name?.trim() || !category?.trim() || !casinoUrl?.trim()) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    // Add explicit URL validation
    if (!isValidUrl(casinoUrl)) {
      return res.status(400).json({
        error: "Invalid Casino URL format. Must include http:// or https://",
      });
    }

    const offer = await prisma.offer.create({
      data: {
        name,
        category,
        description,
        casinoUrl,
        targetCountry,
        logoUrl,
        geoTargets: geoTargets ?? [],
        minDeposit: minDeposit ? parseFloat(minDeposit) : null,
        regPayout: regPayout ? parseFloat(regPayout) : 0,
        isVisible: isVisible ?? true,
        isNew: isNew ?? false,
        isTop: isTop ?? false,
        isExclusive: isExclusive ?? false,
        createdById: req.user!.userId,
      },
    });
    res.status(201).json(offer);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to create offer" });
  }
});

// ─── PATCH /api/offers/:id (Update Offer) ─────────────────────────────────────
router.patch(
  "/:id",
  authenticate,
  requireAdmin,
  async (req: AuthRequest, res) => {
    try {
      const id = req.params.id as string;

      // Add explicit URL validation if attempting to update it
      if (req.body.casinoUrl !== undefined && !isValidUrl(req.body.casinoUrl)) {
        return res.status(400).json({
          error: "Invalid Casino URL format. Must include http:// or https://",
        });
      }

      const allowed = [
        "name",
        "category",
        "description",
        "casinoUrl",
        "targetCountry",
        "status",
        "logoUrl",
        "geoTargets",
        "minDeposit",
        "regPayout",
        "isVisible",
        "isNew",
        "isTop",
        "isExclusive",
      ];
      const data: any = {};
      for (const key of allowed) {
        if (req.body[key] !== undefined) {
          if (
            (key === "minDeposit" || key === "regPayout") &&
            req.body[key] !== null
          ) {
            data[key] = parseFloat(req.body[key]);
          } else {
            data[key] = req.body[key];
          }
        }
      }
      const offer = await prisma.offer.update({ where: { id }, data });
      res.json(offer);
    } catch {
      res.status(500).json({ error: "Failed to update offer" });
    }
  },
);

// ─── DELETE /api/offers/:id (Delete Offer) ────────────────────────────────────
router.delete(
  "/:id",
  authenticate,
  requireAdmin,
  async (req: AuthRequest, res) => {
    try {
      const id = req.params.id as string;
      await prisma.offerRequest.deleteMany({ where: { offerId: id } });
      await prisma.offer.delete({ where: { id } });
      res.json({ message: "Offer deleted successfully" });
    } catch (error: any) {
      if (error.code === "P2003") {
        return res.status(400).json({
          error:
            "Cannot delete offer because it has active tracking links or data associated with it. Please archive it instead.",
        });
      }
      res.status(500).json({ error: "Failed to delete offer" });
    }
  },
);

// ─── POST /api/offers/:id/request ─────────────────────────────────────────────
router.post("/:id/request", authenticate, async (req: AuthRequest, res) => {
  try {
    const id = req.params.id as string;
    const offer = await prisma.offer.findUnique({ where: { id } });
    if (!offer || offer.status !== "ACTIVE" || !offer.isVisible)
      return res.status(404).json({ error: "Offer not found or inactive" });

    const existing = await prisma.offerRequest.findUnique({
      where: { userId_offerId: { userId: req.user!.userId, offerId: id } },
    });
    if (existing)
      return res.status(409).json({
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
});

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
            select: {
              id: true,
              username: true,
              email: true,
              role: true,
              supervisorId: true,
            },
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

// ─── GET /api/offers/:id/clicks ──────────────────────────────────────────────
router.get("/:id/clicks", authenticate, async (req: AuthRequest, res) => {
  try {
    const id = req.params.id as string;
    const clicks = await prisma.click.findMany({
      where: { link: { offerId: id } },
      orderBy: { createdAt: "desc" },
      take: 100, // Limit for performance on the UI
    });
    res.json(clicks);
  } catch {
    res.status(500).json({ error: "Failed to fetch clicks" });
  }
});

// ─── GET /api/offers/:id/conversions ─────────────────────────────────────────
router.get("/:id/conversions", authenticate, async (req: AuthRequest, res) => {
  try {
    const id = req.params.id as string;
    const conversions = await prisma.deposit.findMany({
      where: { link: { offerId: id } },
      orderBy: { createdAt: "desc" },
      include: { link: { select: { subId: true } } },
      take: 100, // Limit for performance
    });
    res.json(conversions);
  } catch {
    res.status(500).json({ error: "Failed to fetch conversions" });
  }
});

export default router;
