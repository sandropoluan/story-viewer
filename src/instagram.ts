/**
 * Instagram story viewer - uses manual HTTP client (no third-party IG libraries).
 * Authentication is cookie-only: IG_BROWSER_COOKIES or IG_SESSION/IG_SESSION_FILE.
 */

import * as fs from "fs";
import * as path from "path";
import { InstagramClient } from "./instagram-manual";

let client: InstagramClient | null = null;
let loggedInUser: string | null = null;

const SESSION_FILE = process.env.IG_SESSION_FILE ?? "ig-session.json";

function getSessionFromEnv(): string | undefined {
  const raw = process.env.IG_SESSION;
  if (!raw?.trim()) return undefined;
  try {
    if (raw.startsWith("{")) return raw;
    return Buffer.from(raw, "base64").toString("utf-8");
  } catch {
    return undefined;
  }
}

function loadSessionFile(): string | undefined {
  try {
    const resolved = path.resolve(SESSION_FILE);
    if (fs.existsSync(resolved)) return fs.readFileSync(resolved, "utf-8");
  } catch {
    /* ignore */
  }
  return undefined;
}

function saveSession(session: string): void {
  if (process.env.VERCEL) return;
  try {
    const resolved = path.resolve(SESSION_FILE);
    fs.writeFileSync(resolved, session, "utf-8");
    console.log(`[ig] Session saved to ${resolved}`);
  } catch (e) {
    throw new Error(`Failed to save session: ${(e as Error).message}`);
  }
}

function getBrowserCookies(): string | undefined {
  const raw = process.env.IG_BROWSER_COOKIES;
  if (!raw?.trim()) return undefined;
  const trimmed = raw.trim();
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) return trimmed;
  try {
    const resolved = path.resolve(trimmed);
    if (fs.existsSync(resolved)) return fs.readFileSync(resolved, "utf-8");
  } catch {
    /* ignore */
  }
  return undefined;
}

export async function getClient(): Promise<InstagramClient> {
  const browserCookies = getBrowserCookies();
  const sessionEnv = getSessionFromEnv();
  const sessionFile = loadSessionFile();
  const sessionData = sessionEnv ?? sessionFile;

  if (!browserCookies && !sessionData) {
    throw new Error(
      "Missing cookies. Set IG_BROWSER_COOKIES (path or JSON) or IG_SESSION/IG_SESSION_FILE."
    );
  }

  if (client) return client;

  client = new InstagramClient();

  if (browserCookies) {
    const ok = await client.loadSessionFromCookies(browserCookies);
    if (ok) {
      // Skip getProfile() - it can trigger checkpoint for non-browser clients.
      // Cookies will be validated on first real request (getStoryItems etc).
      loggedInUser = "cookies";
      console.log(`[ig] Using browser cookies (will validate on first request)`);
      saveSession(client.getSession());
      return client;
    }
  }

  if (sessionData) {
    if (!client) client = new InstagramClient();
    const ok = client.loadSession(sessionData);
    if (ok) {
      loggedInUser = "session";
      console.log(`[ig] Using saved session (will validate on first request)`);
      return client;
    }
  }

  throw new Error(
    "Invalid or expired cookies. Export fresh cookies from instagram.com (Cookie-Editor) to IG_BROWSER_COOKIES."
  );
}

export async function exportSession(): Promise<string | null> {
  await getClient();
  const resolved = path.resolve(SESSION_FILE);
  if (!fs.existsSync(resolved)) return null;
  return fs.readFileSync(resolved, "utf-8");
}

export interface MarkSeenResult {
  targetUsername: string;
  storiesFound: number;
  markedAsSeen: number;
  items: { id: string; takenAt: string; mediaType: "photo" | "video" }[];
}

export async function markStoriesAsSeen(
  targetUsername: string
): Promise<MarkSeenResult> {
  const ig = await getClient();

  const items = await ig.getStoryItems(targetUsername);
  if (!items || items.length === 0) {
    return {
      targetUsername,
      storiesFound: 0,
      markedAsSeen: 0,
      items: [],
    };
  }

  const user = await ig.getUserByUsername(targetUsername);
  const reelId = user?.id ?? targetUsername;

  // Use GraphQL PolarisStoriesV3SeenMutation (actual endpoint from HAR when you click a story)
  await ig.refreshCsrf();
  const viewSeenAt = Math.floor(Date.now() / 1000);
  let tokens: { fb_dtsg: string; lsd: string } | undefined;
  try {
    tokens = await ig.getPageTokens();
  } catch (err) {
    throw new Error(`Failed to get page tokens: ${(err as Error).message}`);
  }
  for (const item of items) {
    const pk = (item as { pk?: string }).pk;
    const id = item.id ?? pk;
    const mediaId = pk ?? (typeof id === "string" && id.includes("_") ? id.split("_")[0] : id);
    const takenAt = item.taken_at ?? (item as { taken_at_timestamp?: number }).taken_at_timestamp;
    const ownerId = item.owner?.id ?? reelId;
    if (!mediaId || takenAt == null) continue;
    const takenAtSec = Math.floor(takenAt);
    try {
      await ig.markStoryAsSeenViaGraphQL(
        {
          reelMediaId: String(mediaId),
          reelMediaOwnerId: String(ownerId),
          reelId: String(reelId),
          reelMediaTakenAt: takenAtSec,
          viewSeenAt,
        },
        targetUsername,
        tokens
      );
    } catch (err) {
      try {
        await ig.markStoryItemAsSeen(
          {
            reelMediaId: String(mediaId),
            reelMediaOwnerId: String(ownerId),
            reelId: String(reelId),
            reelMediaTakenAt: String(takenAtSec),
            viewSeenAt: String(viewSeenAt),
          },
          targetUsername
        );
      } catch (err2) {
        const msg = (err2 as Error).message;
        throw new Error(`Failed to mark story ${mediaId} as seen: ${msg}`);
      }
    }
    await new Promise((r) => setTimeout(r, 200));
  }

  const resultItems = items.map((item) => ({
    id: String(item.id ?? (item as { pk?: string }).pk ?? ""),
    takenAt: new Date((item.taken_at ?? (item as { taken_at_timestamp?: number }).taken_at_timestamp ?? 0) * 1000).toISOString(),
    mediaType: (item.media_type === 2 ? "video" : "photo") as "photo" | "video",
  }));

  console.log(
    `[ig] Marked ${items.length} story item(s) as seen for @${targetUsername}`
  );

  return {
    targetUsername,
    storiesFound: items.length,
    markedAsSeen: items.length,
    items: resultItems,
  };
}
