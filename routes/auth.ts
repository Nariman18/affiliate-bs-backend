import { Router } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { PrismaClient } from "@prisma/client";
import { authenticate, AuthRequest, ROLES } from "../middleware/auth";

const router = Router();
const prisma = new PrismaClient();
const JWT_SECRET = process.env.JWT_SECRET || "secret";

const OWNER_CONTACT = {
  username: process.env.OWNER_USERNAME || "bc_admin",
  displayName: process.env.OWNER_DISPLAY_NAME || "BC Partners Support",
  email: process.env.OWNER_EMAIL || "support@bcpartners.io",
  telegramHandle: process.env.OWNER_TELEGRAM || "@BCPartners_Support",
  avatar: process.env.OWNER_AVATAR_INITIALS || "BC",
  isOwner: true,
};

// ── POST /auth/register ────────────────────────────────────────────────────────
router.post("/register", async (req, res) => {
  try {
    const { username, email, password, confirmPassword, role } = req.body;
    const refId = req.query.ref as string | undefined;

    if (!username?.trim())
      return res.status(400).json({ error: "Username is required" });
    if (!/^[a-zA-Z0-9_]{3,30}$/.test(username))
      return res
        .status(400)
        .json({
          error: "Username: 3–30 chars, letters/numbers/underscores only",
        });
    if (!email?.trim())
      return res.status(400).json({ error: "Email is required" });
    if (!password || password.length < 8)
      return res
        .status(400)
        .json({ error: "Password must be at least 8 characters" });
    if (password !== confirmPassword)
      return res.status(400).json({ error: "Passwords do not match" });

    const assignedRole: string = role || ROLES.MANAGER;
    if (!Object.values(ROLES).includes(assignedRole as any))
      return res.status(400).json({ error: "Invalid role" });

    const [existEmail, existUser] = await Promise.all([
      prisma.user.findUnique({ where: { email } }),
      prisma.user.findUnique({ where: { username } }),
    ]);
    if (existEmail)
      return res.status(400).json({ error: "Email already registered" });
    if (existUser)
      return res.status(400).json({ error: "Username already taken" });

    let supervisorId: string | undefined;
    if (refId) {
      const supervisor = await prisma.user.findUnique({ where: { id: refId } });
      if (!supervisor)
        return res.status(400).json({ error: "Referral link is invalid" });
      if (assignedRole === ROLES.MANAGER && supervisor.role !== ROLES.BASIC)
        return res
          .status(400)
          .json({
            error:
              "Affiliate Managers must be invited by a Basic Sub-Affiliate",
          });
      if (assignedRole === ROLES.BASIC && supervisor.role !== ROLES.ADMIN)
        return res
          .status(400)
          .json({
            error:
              "Basic Sub-Affiliates must be invited by an Admin Sub-Affiliate",
          });
      supervisorId = refId;
    }

    const hashed = await bcrypt.hash(password, 10);
    const user = await prisma.user.create({
      data: {
        username,
        email,
        password: hashed,
        role: assignedRole as any,
        ...(supervisorId ? { supervisorId } : {}),
      },
    });
    await prisma.userProfile.create({
      data: { userId: user.id, displayName: username },
    });
    res.status(201).json({ message: "User created", userId: user.id });
  } catch (err: any) {
    if (err.code === "P2002") {
      const field = err.meta?.target?.includes("username")
        ? "Username"
        : "Email";
      return res.status(400).json({ error: `${field} already taken` });
    }
    res.status(500).json({ error: "Registration failed" });
  }
});

// ── POST /auth/login ───────────────────────────────────────────────────────────
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await prisma.user.findFirst({
      where: {
        OR: [{ email: email?.toLowerCase() ?? "" }, { username: email }],
      },
      include: {
        profile: {
          select: {
            approvedBalance: true,
            pendingBalance: true,
            paidBalance: true,
            displayName: true,
            telegramHandle: true,
          },
        },
      },
    });
    if (!user || !(await bcrypt.compare(password, user.password)))
      return res.status(401).json({ error: "Invalid credentials" });

    const token = jwt.sign({ userId: user.id, role: user.role }, JWT_SECRET, {
      expiresIn: "7d",
    });
    res.json({
      token,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        role: user.role,
        displayName: user.profile?.displayName ?? user.username,
        telegramHandle: user.profile?.telegramHandle ?? null,
        approvedBalance: user.profile?.approvedBalance ?? 0,
        pendingBalance: user.profile?.pendingBalance ?? 0,
        paidBalance: user.profile?.paidBalance ?? 0,
        supervisorId: user.supervisorId ?? null,
      },
    });
  } catch {
    res.status(500).json({ error: "Login failed" });
  }
});

// ── GET /auth/me ───────────────────────────────────────────────────────────────
router.get("/me", authenticate, async (req: AuthRequest, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.userId },
      include: {
        profile: true,
        paymentMethods: { where: { isDefault: true }, take: 1 },
      },
    });
    if (!user) return res.status(404).json({ error: "User not found" });

    res.json({
      id: user.id,
      username: user.username,
      email: user.email,
      role: user.role,
      supervisorId: user.supervisorId ?? null,
      displayName: user.profile?.displayName ?? user.username,
      telegramHandle: user.profile?.telegramHandle ?? null,
      approvedBalance: user.profile?.approvedBalance ?? 0,
      pendingBalance: user.profile?.pendingBalance ?? 0,
      paidBalance: user.profile?.paidBalance ?? 0,
      defaultWallet: user.paymentMethods[0] ?? null,
    });
  } catch {
    res.status(500).json({ error: "Failed to fetch user" });
  }
});

// ── PATCH /auth/me ─────────────────────────────────────────────────────────────
router.patch("/me", authenticate, async (req: AuthRequest, res) => {
  try {
    const { displayName, telegramHandle } = req.body;
    await prisma.userProfile.upsert({
      where: { userId: req.user!.userId },
      update: { displayName, telegramHandle },
      create: { userId: req.user!.userId, displayName, telegramHandle },
    });
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: "Failed to update profile" });
  }
});

// ── POST /auth/change-password ─────────────────────────────────────────────────
router.post("/change-password", authenticate, async (req: AuthRequest, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!newPassword || newPassword.length < 8)
      return res
        .status(400)
        .json({ error: "New password must be at least 8 characters" });
    const user = await prisma.user.findUnique({
      where: { id: req.user!.userId },
    });
    if (!user || !(await bcrypt.compare(currentPassword, user.password)))
      return res.status(401).json({ error: "Current password incorrect" });
    await prisma.user.update({
      where: { id: req.user!.userId },
      data: { password: await bcrypt.hash(newPassword, 10) },
    });
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: "Failed to change password" });
  }
});

// ── GET /auth/my-manager ───────────────────────────────────────────────────────
router.get("/my-manager", authenticate, async (req: AuthRequest, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.userId },
      select: { supervisorId: true },
    });
    if (!user?.supervisorId) return res.json({ manager: OWNER_CONTACT });

    const supervisor = await prisma.user.findUnique({
      where: { id: user.supervisorId },
      select: {
        username: true,
        email: true,
        role: true,
        profile: { select: { displayName: true, telegramHandle: true } },
      },
    });
    if (!supervisor) return res.json({ manager: OWNER_CONTACT });

    const displayName = supervisor.profile?.displayName ?? supervisor.username;
    res.json({
      manager: {
        username: supervisor.username,
        displayName,
        email: supervisor.email,
        telegramHandle: supervisor.profile?.telegramHandle ?? null,
        role: supervisor.role,
        avatar: displayName.slice(0, 2).toUpperCase(),
        isOwner: false,
      },
    });
  } catch {
    res.status(500).json({ error: "Failed to fetch manager info" });
  }
});

// ── GET /auth/referral-link ────────────────────────────────────────────────────
router.get("/referral-link", authenticate, async (req: AuthRequest, res) => {
  const { userId, role } = req.user!;
  if (role === ROLES.MANAGER)
    return res.status(403).json({ error: "Managers cannot invite users" });
  const targetRole = role === ROLES.ADMIN ? ROLES.BASIC : ROLES.MANAGER;
  const base = process.env.FRONTEND_URL ?? "http://localhost:3000";
  res.json({
    link: `${base}/register?ref=${userId}&role=${targetRole}`,
    targetRole,
  });
});

export default router;
