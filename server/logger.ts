const isProd = process.env["NODE_ENV"] === "production";

type Meta = Record<string, unknown>;

function log(level: string, msg: string, meta?: Meta): void {
  if (isProd) {
    process.stdout.write(
      JSON.stringify({ level, msg, ts: new Date().toISOString(), ...meta }) + "\n",
    );
  } else {
    const suffix = meta && Object.keys(meta).length ? " " + JSON.stringify(meta) : "";
    const stream = level === "error" || level === "warn" ? process.stderr : process.stdout;
    stream.write(`[${level.toUpperCase()}] ${msg}${suffix}\n`);
  }
}

export const logger = {
  info: (msg: string, meta?: Meta) => log("info", msg, meta),
  warn: (msg: string, meta?: Meta) => log("warn", msg, meta),
  error: (msg: string, meta?: Meta) => log("error", msg, meta),
};
