import { Storage } from "@google-cloud/storage";
import "dotenv/config";

const storage = new Storage({
  projectId: process.env.GCS_PROJECT_ID,
  credentials: {
    client_email: process.env.GCS_CLIENT_EMAIL,
    private_key: process.env.GCS_PRIVATE_KEY?.replace(/\\n/g, "\n"),
  },
});

async function configureBucketCors() {
  const bucketName = process.env.GCS_BUCKET_NAME || "affiliate-project";

  const corsConfiguration = [
    {
      // Explicitly list your frontend URLs (No slashes at the end!)
      origin: [
        "http://localhost:3000",
        "https://affiliate-bs-partner-frontend.vercel.app",
      ],
      method: ["PUT", "GET", "OPTIONS", "POST"],
      // Standard headers required by Google Cloud Storage uploads
      responseHeader: [
        "Content-Type",
        "Access-Control-Allow-Origin",
        "x-goog-resumable",
      ],
      maxAgeSeconds: 0, // Forces the browser to NEVER cache a blocked request!
    },
  ];

  try {
    console.log(`Updating CORS for bucket: ${bucketName}...`);
    await storage.bucket(bucketName).setCorsConfiguration(corsConfiguration);
    console.log(`✅ CORS configured perfectly for bucket: ${bucketName}!`);
  } catch (error) {
    console.error("❌ Failed to configure CORS:", error);
  }
}

configureBucketCors();
