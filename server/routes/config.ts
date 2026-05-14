import { Router } from "express";
import * as path from "path";
import { config } from "../config";

const router = Router();
const PUBLIC_DIR = path.join(__dirname, "../public");

router.get("/", (_req, res) => res.sendFile(path.join(PUBLIC_DIR, "index.html")));
router.get("/generate", (_req, res) => res.sendFile(path.join(PUBLIC_DIR, "generate.html")));

router.get("/api/config", (_req, res) => {
  res.json({
    issueTracker: config.issueTracker,
    trackerUrl: config.fakeTrackerUrl,
  });
});

export default router;
