import { Router } from "express";
import * as path from "path";
import { getEnvVars } from "../../helpers/getEnvVars";

const router = Router();
const PUBLIC_DIR = path.join(__dirname, "../public");

router.get("/", (_req, res) => res.sendFile(path.join(PUBLIC_DIR, "index.html")));
router.get("/generate", (_req, res) => res.sendFile(path.join(PUBLIC_DIR, "generate.html")));

router.get("/api/config", (_req, res) => {
  const { ISSUE_TRACKER, FAKE_TRACKER_URL } = getEnvVars();
  res.json({
    issueTracker: ISSUE_TRACKER,
    trackerUrl: FAKE_TRACKER_URL,
  });
});

export default router;
