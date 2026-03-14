import { Router } from "express";
import { PrismaClient } from "@prisma/client";
import {
  authenticate,
  requireManager,
  requireAdminOrBasic,
  AuthRequest,
  ROLES,
} from "../middleware/auth";

const router = Router();
const prisma = new PrismaClient();

// ── GET /track/links/mine — Affiliate Manager gets their own links ─────────────
router.get(
  "/links/mine",
  authenticate,
  requireManager,
  async (req: AuthRequest, res) => {
    try {
      const links = await prisma.link.findMany({
        where: { affiliateId: req.user!.userId },
        include: {
          offer: {
            // UPDATED: Removed commissionPct, added regPayout and minDeposit
            select: {
              name: true,
              category: true,
              regPayout: true,
              minDeposit: true,
            },
          },
        },
        orderBy: { createdAt: "desc" },
      });

      res.json(
        links.map((l) => ({
          ...l,
          trackingUrl: buildTrackingUrl(l.id),
        })),
      );
    } catch {
      res.status(500).json({ error: "Failed to fetch links" });
    }
  },
);

// ── POST /track/links — Admin or Basic Sub distributes a link to a Manager ─────
router.post(
  "/links",
  authenticate,
  requireAdminOrBasic,
  async (req: AuthRequest, res) => {
    try {
      const { offerId, affiliateId, name, subId } = req.body;

      const target = await prisma.user.findUnique({
        where: { id: affiliateId },
      });
      if (!target || target.role !== ROLES.MANAGER)
        return res
          .status(400)
          .json({ error: "Target user must be an Affiliate Manager" });

      if (
        req.user!.role === ROLES.BASIC &&
        target.supervisorId !== req.user!.userId
      )
        return res.status(403).json({
          error: "You can only assign links to your own team members",
        });

      const offer = await prisma.offer.findUnique({ where: { id: offerId } });
      if (!offer || offer.status !== "ACTIVE")
        return res.status(404).json({ error: "Offer not found or inactive" });

      const link = await prisma.link.create({
        data: {
          name: name ?? `${offer.name} – ${target.username}`,
          casinoUrl: offer.casinoUrl ?? "",
          subId,
          offerId,
          affiliateId,
        },
      });

      res.status(201).json({ ...link, trackingUrl: buildTrackingUrl(link.id) });
    } catch {
      res.status(500).json({ error: "Failed to create link" });
    }
  },
);

// ── GET /track/:linkId — Public click tracker + redirect ──────────────────────
router.get("/:linkId", async (req, res) => {
  try {
    const link = await prisma.link.findUnique({
      where: { id: req.params.linkId },
      include: { offer: { select: { status: true } } },
    });

    if (!link || link.offer?.status !== "ACTIVE")
      return res.status(404).send("Link not found");

    await prisma.click.create({
      data: {
        linkId: link.id,
        ipAddress: req.ip ?? null,
        userAgent: req.headers["user-agent"] ?? null,
        country: (req.headers["cf-ipcountry"] as string) ?? null,
        deviceType: /Mobi|Android/i.test(req.headers["user-agent"] ?? "")
          ? "mobile"
          : "desktop",
      },
    });

    const sep = link.casinoUrl.includes("?") ? "&" : "?";
    res.redirect(302, `${link.casinoUrl}${sep}subid=${link.id}`);
  } catch {
    res.status(500).send("Error processing link");
  }
});

// ── POST /track/postback ───────────────────────────────────────────────────────
router.post("/postback", async (req, res) => {
  if (req.headers["x-postback-secret"] !== process.env.POSTBACK_SECRET)
    return res.status(401).json({ error: "Invalid postback secret" });

  const { linkId, amount, currency = "USD", status = "confirmed" } = req.body;

  if (!linkId || typeof amount !== "number" || amount <= 0)
    return res
      .status(400)
      .json({ error: "linkId and a positive numeric amount are required" });

  try {
    const link = await prisma.link.findUnique({
      where: { id: linkId },
      // UPDATED: Removed commissionPct
      include: {
        offer: { select: { status: true, minDeposit: true, regPayout: true } },
      },
    });

    if (!link || link.offer?.status !== "ACTIVE")
      return res
        .status(404)
        .json({ error: "Link or offer not found / inactive" });

    const manager = await prisma.user.findUnique({
      where: { id: link.affiliateId },
      select: { id: true, role: true, supervisorId: true },
    });

    if (!manager || manager.role !== ROLES.MANAGER)
      return res
        .status(400)
        .json({ error: "Link is not assigned to a valid Affiliate Manager" });

    // UPDATED: Affiliate gets the full amount directly (no percentage math)
    const managerAmt = round2(amount);

    // Note: If you have a Basic Sub (Master Affiliate), you might want to adjust
    // this so they get a specific override cut, rather than 100% of the deposit too.
    // For now, it mirrors the manager.
    const basicSubAmt = round2(amount);

    const result = await prisma.$transaction(async (tx) => {
      const deposit = await tx.deposit.create({
        data: { linkId, amount, currency, status },
      });

      await tx.commission.create({
        data: {
          depositId: deposit.id,
          recipientId: manager.id,
          amount: managerAmt,
          percentage: 100, // Just a placeholder now that it's full amount
          status: "PENDING",
        },
      });
      await tx.userProfile.update({
        where: { userId: manager.id },
        data: { pendingBalance: { increment: managerAmt } },
      });

      let basicSubCommission = 0;

      if (manager.supervisorId) {
        const basicSub = await tx.user.findUnique({
          where: { id: manager.supervisorId },
          select: { id: true, role: true },
        });

        if (basicSub?.role === ROLES.BASIC) {
          await tx.commission.create({
            data: {
              depositId: deposit.id,
              recipientId: basicSub.id,
              amount: basicSubAmt,
              percentage: 100,
              status: "PENDING",
            },
          });
          await tx.userProfile.update({
            where: { userId: basicSub.id },
            data: { pendingBalance: { increment: basicSubAmt } },
          });
          basicSubCommission = basicSubAmt;
        }
      }

      return { depositId: deposit.id, managerAmt, basicSubCommission };
    });

    res.json({ success: true, ...result });
  } catch (err) {
    console.error("Postback error:", err);
    res.status(500).json({ error: "Postback processing failed" });
  }
});

function buildTrackingUrl(linkId: string) {
  return `${process.env.TRACKING_BASE_URL ?? "http://localhost:5001"}/track/${linkId}`;
}

function round2(n: number) {
  return Math.round(n * 100) / 100;
}

export default router;
