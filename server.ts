import express from "express";
import cors from "cors";
import helmet from "helmet";
import authRoutes from "./routes/auth";
import trackingRoutes from "./routes/tracking";
import payoutRoutes from "./routes/payouts";
import "dotenv/config";
import offersRoutes from "./routes/offers";
import reportsRoutes from "./routes/reports";
import transactionsRoutes from "./routes/transactions";
import billingRoutes from "./routes/billing";
import referralsRoutes from "./routes/referrals";
import affiliatesRoutes from "./routes/affiliates";

const server = express();
const port = process.env.PORT || 5001;

server.use(
  helmet({
    contentSecurityPolicy: false,
  }),
);

const allowedOrigins = [
  process.env.APP_URL,
  "http://localhost:3000",
  "https://affiliate-bs-partner-frontend.vercel.app",
].filter(Boolean) as string[];

server.use(
  cors({
    origin: function (origin, callback) {
      // Allow requests with no origin (like mobile apps or curl requests)
      if (!origin) return callback(null, true);

      if (allowedOrigins.indexOf(origin) !== -1) {
        callback(null, true);
      } else {
        callback(new Error("Not allowed by CORS"));
      }
    },
    credentials: true,
  }),
);
server.use(express.json());
server.use(express.urlencoded({ extended: true }));

// API Routes
server.use("/api/auth", authRoutes);
server.use("/api/offers", offersRoutes);
server.use("/api/reports", reportsRoutes);
server.use("/api/transactions", transactionsRoutes);
server.use("/api/payouts", payoutRoutes);
server.use("/api/billing", billingRoutes);
server.use("/api/referrals", referralsRoutes);
server.use("/api/affiliates", affiliatesRoutes);

// Health check
server.get("/api/health", (req, res) => {
  res.json({ status: "ok" });
});

server.listen(port, () => {
  console.log(`-> Backend API ready on http://localhost:${port}`);
});
