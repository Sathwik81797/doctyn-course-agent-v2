/**
 * npm run dashboard
 *
 * Local backend for the web dashboard. Accepts PPTX/DOCX uploads into ./input, runs the
 * existing validate / preview-tts / build-course commands one at a time, and serves the
 * finished videos from ./output. Listens on 127.0.0.1 only; nothing leaves this machine.
 *
 * The same dashboard UI (public/) is served at http://127.0.0.1:8788 and can also be
 * hosted on Vercel, in which case the browser talks to this backend over localhost.
 */
import net from "node:net";
import path from "node:path";
import { createDashboardServer } from "./server/app.js";
import { loadConfig, PROJECT_ROOT } from "./utils/config.js";
import { PipelineError, runMain } from "./utils/errors.js";

/** Origins allowed to call the backend besides itself. The Vercel project and its preview deployments. */
const DEFAULT_ALLOWED_ORIGINS = ["https://doctyn-course-ai-agent.vercel.app", "https://doctyn-course-ai-agent-*.vercel.app"];

runMain(async () => {
  const config = loadConfig();
  const rawPort = process.env.DASHBOARD_PORT?.trim() || "8788";
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new PipelineError(`Invalid value in .env: DASHBOARD_PORT=${rawPort}`, "Use a port number such as 8788.");
  }
  const extraOrigins = (process.env.DASHBOARD_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const allowedOrigins = [...DEFAULT_ALLOWED_ORIGINS, ...extraOrigins];

  const { server } = await createDashboardServer({
    projectRoot: PROJECT_ROOT,
    inputDir: config.inputDir,
    outputDir: config.outputDir,
    publicDir: path.join(PROJECT_ROOT, "public"),
    allowedOrigins,
    tts:
      config.tts.provider === "kokoro"
        ? { provider: "kokoro", voice: config.kokoro.voice, speed: config.kokoro.speed }
        : config.tts.provider === "openai"
          ? { provider: "openai", voice: config.tts.voice, speed: config.tts.speed }
          : { provider: "windows", voice: config.windowsTts.voice ?? "auto", speed: config.windowsTts.rate },
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", (err: NodeJS.ErrnoException) => {
      reject(
        err.code === "EADDRINUSE"
          ? new PipelineError(
              `Port ${port} is already in use.`,
              "Another dashboard may already be running. Close it, or set DASHBOARD_PORT in .env to a free port.",
            )
          : err,
      );
    });
    server.listen(port, "127.0.0.1", () => resolve());
  });

  // "localhost" resolves to ::1 first on many Windows setups; listen there too so both addresses work.
  // Best effort: machines without IPv6 loopback simply skip it.
  const v6 = net.createServer((socket) => server.emit("connection", socket));
  v6.on("error", () => {});
  v6.listen(port, "::1");

  console.log("DOCTYN COURSE DASHBOARD — local backend");
  console.log("");
  console.log(`Dashboard:  http://127.0.0.1:${port}`);
  console.log(`Animation Studio:  http://127.0.0.1:${port}/#/studio`);
  console.log(`Input:      ${config.inputDir}`);
  console.log(`Output:     ${config.outputDir}`);
  console.log(`Allowed web origins: ${allowedOrigins.join(", ")}`);
  console.log("");
  console.log("Keep this window open while using the dashboard. Press Ctrl+C to stop.");

  await new Promise<void>((resolve) => {
    const stop = () => {
      v6.close();
      server.close(() => resolve());
      server.closeAllConnections();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  return 0;
});
