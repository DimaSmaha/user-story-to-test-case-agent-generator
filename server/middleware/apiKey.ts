import type { Request, Response, NextFunction } from "express";
import { config } from "../config";

export function apiKeyAuth(req: Request, res: Response, next: NextFunction): void {
  if (!config.apiKey) {
    next();
    return;
  }
  // EventSource can't set headers, so also accept key as ?apiKey= query param
  const provided = (req.headers["x-api-key"] as string) ?? (req.query["apiKey"] as string);
  if (provided !== config.apiKey) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}
