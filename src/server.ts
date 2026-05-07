import "dotenv/config";
import express from "express";
import https from "https";
import { exportSession, markStoriesAsSeen } from "./instagram";

const app = express();
const PORT = process.env.PORT ?? 3000;

function proxyGet(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    https
      .get(url, (apiRes) => {
        let data = "";
        apiRes.on("data", (chunk) => (data += chunk));
        apiRes.on("end", () => resolve(data));
      })
      .on("error", reject);
  });
}

app.get("/indodax-summaries", async (_req, res) => {
  try {
    const data = await proxyGet("https://indodax.com/api/summaries");
    res.setHeader("Content-Type", "application/json");
    res.send(data);
  } catch (err: any) {
    res.status(500).send("Error fetching data: " + (err.message ?? "Unknown error"));
  }
});

app.get("/binance-ticker-price", async (req, res) => {
  const { symbol } = req.query;
  if (!symbol) {
    res.status(400).json({ error: "Missing required query parameter: symbol" });
    return;
  }
  try {
    const url = `https://api.binance.com/api/v3/ticker/price?symbol=${encodeURIComponent(symbol as string)}`;
    const data = await proxyGet(url);
    res.setHeader("Content-Type", "application/json");
    res.send(data);
  } catch (err: any) {
    res.status(500).send("Error fetching data: " + (err.message ?? "Unknown error"));
  }
});

app.get("/stories/seen", async (req, res) => {
  const { targetUsername } = req.query;

  if (!targetUsername || typeof targetUsername !== "string") {
    res.status(400).json({
      error: "Missing required query parameter: targetUsername",
      usage: "GET /stories/seen?targetUsername=natgeo",
    });
    return;
  }

  try {
    const result = await markStoriesAsSeen(targetUsername);

    if (result.storiesFound === 0) {
      res.status(200).json({
        status: "no_stories",
        targetUsername,
        storiesFound: 0,
        markedAsSeen: 0,
        items: [],
      });
      return;
    }

    res.status(200).json({
      status: "marked_as_seen",
      ...result,
    });
  } catch (err: any) {
    const message = err.message ?? "Unknown error";
    console.error(`[error] Failed for @${targetUsername}:`, message);

    if (message.includes("User not found")) {
      res.status(200).json({
        status: "cant_get_stories",
        error: `User @${targetUsername} not found`,
        targetUsername,
      });
      return;
    }

    if (
      message.includes("login") ||
      message.includes("400 Bad Request") ||
      message.includes("Missing cookies") ||
      message.includes("Invalid or expired cookies") ||
      message.includes("Could not extract fb_dtsg/lsd") ||
      message.includes("Failed to get page tokens")
    ) {
      res.status(401).json({
        status: "cookie_expired",
        error: "Instagram cookies invalid or expired.",
        hint: "Export fresh cookies from instagram.com (Cookie-Editor) and set IG_BROWSER_COOKIES.",
      });
      return;
    }

    if (message.includes("checkpoint_required")) {
      res.status(403).json({
        status: "cookie_expired",
        error: "Instagram requires account verification.",
        hint: "Open Instagram app or instagram.com, complete 'Verify it's you', then export fresh cookies to IG_BROWSER_COOKIES.",
      });
      return;
    }

    if (message.includes("two_factor_required")) {
      res.status(403).json({
        status: "cookie_expired",
        error: "2FA is enabled on this account.",
        hint: "Log in via browser/app, then export cookies to IG_BROWSER_COOKIES.",
      });
      return;
    }

    if (message.includes("Failed to save session")) {
      res.status(500).json({
        status: "error",
        error: message,
        hint: "Check IG_SESSION_FILE path and write permissions.",
      });
      return;
    }

    if (message.includes("Failed to mark story")) {
      res.status(502).json({
        status: "mark_failed",
        error: message,
        hint: "Instagram may have changed their API. Try exporting fresh cookies.",
      });
      return;
    }

    res.status(502).json({
      status: "cant_get_stories",
      error: message,
    });
  }
});

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.get("/session/export", async (_req, res) => {
  try {
    const content = await exportSession();
    if (!content) {
      res.status(404).json({
        error: "No session file. Use IG_BROWSER_COOKIES first to create one.",
      });
      return;
    }
    res.json({
      message: "Copy to IG_SESSION or IG_SESSION_FILE.",
      content,
      contentBase64: Buffer.from(content).toString("base64"),
    });
  } catch (err: any) {
    console.error("[error] Session export failed:", err.message);
    res.status(500).json({ error: err.message });
  }
});

export default app;

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`  GET /stories/seen?targetUsername=<username>`);
    console.log(`  GET /session/export  (get session for IG_SESSION / IG_SESSION_FILE)`);
    console.log(`  GET /health`);
  });
}
