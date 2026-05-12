import { Router } from "express";
import * as path from "path";

const router = Router();
const PUBLIC_DIR = path.join(__dirname, "../public");

router.get("/", (_req, res) => res.sendFile(path.join(PUBLIC_DIR, "index.html")));
router.get("/generate", (_req, res) => res.sendFile(path.join(PUBLIC_DIR, "generate.html")));

router.get("/api/config", (_req, res) => {
  res.json({
    issueTracker: process.env["ISSUE_TRACKER"] ?? "fake",
    trackerUrl: process.env["FAKE_TRACKER_URL"] ?? "http://localhost:3000",
  });
});

export default router;
