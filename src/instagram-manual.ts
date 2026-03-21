/**
 * Manual Instagram HTTP client - no third-party Instagram libraries.
 * Uses www.instagram.com directly.
 *
 * When Instagram changes their site, update:
 * - getProfile: _sharedData or embedded JSON patterns
 * - getStoryItems: query_hash (extract from Network tab if 403/empty)
 * - markStoryItemAsSeen: /stories/reel/seen
 */

const BASE = "https://www.instagram.com";

type CookieJar = Map<string, string>;

function parseSetCookie(header: string): { name: string; value: string } | null {
  const part = header.split(";")[0].trim();
  const eq = part.indexOf("=");
  if (eq < 0) return null;
  return { name: part.slice(0, eq), value: part.slice(eq + 1) };
}

function cookieHeader(jar: CookieJar, domain: string): string {
  return Array.from(jar.entries())
    .filter(([k]) => domain.includes("instagram"))
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

async function fetchIG(
  url: string,
  options: RequestInit & { cookieJar?: CookieJar; apiRequest?: boolean; baseUrl?: string } = {}
): Promise<Response> {
  const { cookieJar = new Map(), apiRequest = false, baseUrl = BASE, ...fetchOpts } = options;
  const base = baseUrl;
  const fullUrl = url.startsWith("http") ? url : base + url;

  const headers = new Headers(fetchOpts.headers);
  if (cookieJar.size) {
    headers.set("Cookie", cookieHeader(cookieJar, new URL(fullUrl).hostname));
  }
  if (!headers.has("User-Agent")) {
    headers.set(
      "User-Agent",
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
    );
  }
  if (!headers.has("Accept")) {
    headers.set("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8");
  }
  headers.set("Accept-Language", "en-US,en;q=0.9");
  headers.set("Accept-Encoding", "gzip, deflate, br");
  headers.set("Origin", base);
  if (!headers.has("Referer")) headers.set("Referer", base + "/");
  headers.set("Sec-Ch-Ua", '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"');
  headers.set("Sec-Ch-Ua-Mobile", "?0");
  headers.set("Sec-Ch-Ua-Platform", '"macOS"');
  headers.set("Sec-Fetch-Dest", apiRequest ? "empty" : "document");
  headers.set("Sec-Fetch-Mode", apiRequest ? "cors" : "navigate");
  headers.set("Sec-Fetch-Site", "same-origin");
  if (!headers.has("X-Instagram-AJAX")) headers.set("X-Instagram-AJAX", "1");
  if (!headers.has("X-Requested-With")) headers.set("X-Requested-With", "XMLHttpRequest");

  const res = await fetch(fullUrl, {
    ...fetchOpts,
    headers,
    redirect: "manual",
  });

  if (cookieJar) {
    const headers = res.headers as Headers & { getSetCookie?(): string[] };
    if (typeof headers.getSetCookie === "function") {
      for (const c of headers.getSetCookie()) {
        const parsed = parseSetCookie(c);
        if (parsed) cookieJar.set(parsed.name, parsed.value);
      }
    } else {
      const setCookie = res.headers.get("set-cookie");
      if (setCookie) {
        const parsed = parseSetCookie(setCookie);
        if (parsed) cookieJar.set(parsed.name, parsed.value);
      }
    }
  }

  return res;
}

function getCsrfFromJar(jar: CookieJar): string {
  return jar.get("csrftoken") || jar.get("ig_csrf_token") || "";
}

export class InstagramClient {
  private jar: CookieJar = new Map();
  private csrf: string = "";
  private username: string = "";

  constructor() {}

  async loadSessionFromCookies(cookiesJson: string): Promise<boolean> {
    try {
      const raw = JSON.parse(cookiesJson);
      const arr = Array.isArray(raw) ? raw : raw.cookies ?? [raw];
      for (const c of arr) {
        const name = c.name ?? c.key;
        const value = c.value;
        if (name && value) this.jar.set(name, String(value));
      }
      this.csrf = getCsrfFromJar(this.jar);
      return this.csrf.length > 0 && this.jar.has("sessionid");
    } catch {
      return false;
    }
  }

  /** Verify session - uses homepage (less likely to trigger checkpoint than /accounts/edit/) */
  async getProfile(): Promise<{ username: string }> {
    const res = await fetchIG("/", { cookieJar: this.jar });
    const html = await res.text();

    if (html.includes("login_and_signup") && html.includes("Log In")) {
      throw new Error("Could not get profile. Session may be expired.");
    }
    if (html.includes("checkpoint") || html.includes("ChallengeRequired") || res.url.includes("/challenge/")) {
      throw new Error(
        "checkpoint_required: Account verification needed. Complete it at instagram.com, then export fresh cookies."
      );
    }

    const sharedMatch = html.match(/window\._sharedData\s*=\s*({.+?});?\s*<\/script>/s);
    if (sharedMatch) {
      const data = JSON.parse(sharedMatch[1]);
      const user = data?.config?.viewer ?? data?.viewer;
      if (user?.username) return { username: user.username };
    }

    const dataMatch = html.match(/require\("Sentry"\)\.__additionalDataLoaded\('extra',(\{.+?\})\)/);
    if (dataMatch) {
      try {
        const parsed = JSON.parse(dataMatch[1]);
        const username = parsed?.viewer?.username ?? parsed?.username;
        if (username) return { username };
      } catch {
        /* ignore */
      }
    }

    if (this.username) return { username: this.username };
    throw new Error("Could not get profile. Session may be expired.");
  }

  async getUserByUsername(username: string): Promise<{ id: string } | null> {
    // Try web_profile_info API first (returns clean JSON)
    const apiRes = await fetchIG(`/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`, {
      headers: {
        "X-IG-App-ID": "936619743392459",
        "X-Requested-With": "XMLHttpRequest",
        "Accept": "*/*",
      },
      cookieJar: this.jar,
    });
    if (apiRes.ok) {
      try {
        const data = await apiRes.json() as Record<string, unknown>;
        const user = (data?.data as Record<string, unknown>|undefined)?.user as Record<string, unknown>|undefined;
        const id = user?.id ?? user?.pk;
        if (id != null) return { id: String(id) };
      } catch {
        /* fall through to HTML parsing */
      }
    }

    // Fallback: parse profile page HTML
    const res = await fetchIG(`/${username}/`, { cookieJar: this.jar });
    const html = await res.text();
    const escaped = username.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    // profilePage_123456_json or profilePage_123456
    const dataMatch = html.match(/profilePage_(\d+)(?:_json)?/);
    if (dataMatch) return { id: dataMatch[1] };

    // id/pk near username (order varies); allow ~300 chars between for nested JSON
    const patterns = [
      new RegExp(`"id":"(\\d+)"[\\s\\S]{0,300}?"username":"${escaped}"`),
      new RegExp(`"pk":"(\\d+)"[\\s\\S]{0,300}?"username":"${escaped}"`),
      new RegExp(`"username":"${escaped}"[\\s\\S]{0,300}?"id":"(\\d+)"`),
      new RegExp(`"username":"${escaped}"[\\s\\S]{0,300}?"pk":"(\\d+)"`),
    ];
    for (const re of patterns) {
      const m = html.match(re);
      if (m) return { id: m[1] };
    }

    return null;
  }

  async getStoryItems(username: string): Promise<
    Array<{ id: string; pk?: string; taken_at?: number; taken_at_timestamp?: number; media_type?: number; owner?: { id: string } }>
  > {
    const user = await this.getUserByUsername(username);
    if (!user) return [];

    const queryHash = "297c491471fff978fa2ab83c0673a618";
    const variables = JSON.stringify({
      reel_ids: [user.id],
      tag_names: [],
      location_ids: [],
      precomposed_overlay: false,
    });

    const url = `/graphql/query/?query_hash=${queryHash}&variables=${encodeURIComponent(variables)}`;
    const res = await fetchIG(url, {
      headers: { "X-CSRFToken": this.csrf },
      cookieJar: this.jar,
    });

    const data = (await res.json()) as {
      data?: { reels_media?: Array<{ items?: unknown[] }> };
      message?: string;
      require_login?: boolean;
    };

    if (data?.message?.includes("checkpoint") || data?.require_login) {
      throw new Error(
        "checkpoint_required: Account verification needed. Complete it at instagram.com, then export fresh cookies."
      );
    }

    const reels = data?.data?.reels_media ?? [];
    if (reels.length === 0) return [];
    const items = reels[0]?.items ?? [];
    return items as typeof items & Array<{ id: string; taken_at?: number; owner?: { id: string } }>;
  }

  /** Get fb_dtsg and lsd from homepage (for GraphQL mutations). */
  async getPageTokens(): Promise<{ fb_dtsg: string; lsd: string }> {
    const res = await fetchIG("/", { cookieJar: this.jar });
    const html = await res.text();
    const t = this.extractPageTokens(html);
    const fb_dtsg = t.fb_dtsg ?? "";
    const lsd = t.lsd ?? this.jar.get("lsd") ?? "";
    if (!fb_dtsg || !lsd) throw new Error("Could not extract fb_dtsg/lsd from homepage");
    return { fb_dtsg, lsd };
  }

  /** Refresh CSRF token from homepage (302 on seen often means stale token) */
  async refreshCsrf(): Promise<void> {
    const res = await fetchIG("/", { cookieJar: this.jar });
    if (res.ok) {
      const html = await res.text();
      const match = html.match(/"csrf_token":"(\w+)"/) ?? html.match(/csrf_token["\s:]+["']?(\w+)/);
      if (match?.[1]) this.csrf = match[1];
    }
  }

  /** Extract fb_dtsg and lsd from page HTML (required for video/unified_cvc) */
  private extractPageTokens(html: string): { fb_dtsg?: string; lsd?: string } {
    const out: { fb_dtsg?: string; lsd?: string } = {};

    // fb_dtsg: multiple Meta patterns (DTSG, fb_dtsg, fb_dtsg_ag)
    const dtsgPatterns = [
      /"DTSGInitialData",\[\],\{"token":"([^"]+)"\}/,
      /"token":"([^"]+)"[^}]*"__fixFor"[^}]*DTSGInitialData/,
      /DTSGInitialData[^}]*"token":"([^"]+)"/,
      /"fb_dtsg":"([^"]+)"/,
      /"fb_dtsg_ag":"([^"]+)"/,
      /require\s*\(\s*["']DTSGInitialData["'][^)]*\)\s*,\s*\[\][^}]*"token"\s*:\s*"([^"]+)"/,
    ];
    for (const re of dtsgPatterns) {
      const m = html.match(re);
      if (m?.[1] && m[1].length > 10) {
        out.fb_dtsg = m[1];
        break;
      }
    }

    // lsd: Meta LSD token
    const lsdPatterns = [
      /"LSD",\[\],\{"token":"([^"]+)"\}/,
      /"lsd"\s*:\s*"([^"]+)"/,
      /LSD[^}]*"token"\s*:\s*"([^"]+)"/,
      /<meta[^>]+name=["']lsd["'][^>]+content=["']([^"']+)["']/i,
    ];
    for (const re of lsdPatterns) {
      const m = html.match(re);
      if (m?.[1] && m[1].length > 5) {
        out.lsd = m[1];
        break;
      }
    }
    return out;
  }

  /**
   * Mark story as seen via /video/unified_cvc (actual endpoint used by Instagram web when you view a story).
   * Requires fb_dtsg and lsd tokens (from story page or homepage).
   */
  async markStoryAsSeenViaCvc(mediaId: string, username: string): Promise<void> {
    const storyUrl = `/stories/${username}/${mediaId}/`;
    // Try story page first for tokens
    const pageRes = await fetchIG(storyUrl, { cookieJar: this.jar });
    const html = await pageRes.text();
    let tokens = this.extractPageTokens(html);
    // Fallback: homepage has tokens if story page doesn't (e.g. redirect, different HTML)
    if (!tokens.fb_dtsg || !tokens.lsd) {
      const homeRes = await fetchIG("/", { cookieJar: this.jar });
      const homeHtml = await homeRes.text();
      const homeTokens = this.extractPageTokens(homeHtml);
      tokens = { fb_dtsg: tokens.fb_dtsg ?? homeTokens.fb_dtsg, lsd: tokens.lsd ?? homeTokens.lsd };
    }
    const lsd = tokens.lsd ?? this.jar.get("lsd") ?? "";
    const fb_dtsg = tokens.fb_dtsg ?? "";
    if (!fb_dtsg || !lsd) {
      throw new Error(`Could not extract fb_dtsg/lsd from page. fb_dtsg=${!!fb_dtsg} lsd=${!!lsd}`);
    }

    const si = Array.from({ length: 16 }, () => Math.floor(Math.random() * 16).toString(16)).join("");
    const d = JSON.stringify({
      pps: null,
      ps: { m: true, pf: 9, s: "playing", sa: 1 },
      si,
      so: "inline::inline",
      vi: mediaId,
    });

    const form = new URLSearchParams();
    form.set("d", d);
    form.set("__d", "www");
    form.set("__user", "0");
    form.set("__a", "1");
    form.set("__comet_req", "7");
    form.set("__crn", "comet.igweb.PolarisStoriesV3Route");
    form.set("fb_dtsg", fb_dtsg);
    form.set("jazoest", "26645");
    form.set("lsd", lsd);

    const res = await fetchIG("/video/unified_cvc/", {
      method: "POST",
      body: form,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Referer": `${BASE}${storyUrl}`,
        "Accept": "*/*",
        "X-CSRFToken": this.csrf,
        "X-ASBD-ID": "359341",
        "X-FB-LSD": lsd,
        "X-IG-D": "www",
      },
      cookieJar: this.jar,
      apiRequest: true,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`video/unified_cvc failed ${res.status}: ${text.slice(0, 150)}`);
    }
  }

  /**
   * Mark story as seen via GraphQL PolarisStoriesV3SeenMutation.
   * This is the actual endpoint Instagram web uses when you view a story (from HAR).
   * Requires fb_dtsg and lsd from page. Pass cached tokens to avoid re-fetching.
   */
  async markStoryAsSeenViaGraphQL(params: {
    reelMediaId: string;
    reelMediaOwnerId: string;
    reelId: string;
    reelMediaTakenAt: number;
    viewSeenAt: number;
  }, username: string, tokens?: { fb_dtsg: string; lsd: string }): Promise<void> {
    const variables = {
      reelId: params.reelId,
      reelMediaId: params.reelMediaId,
      reelMediaOwnerId: params.reelMediaOwnerId,
      reelMediaTakenAt: params.reelMediaTakenAt,
      viewSeenAt: params.viewSeenAt,
    };

    let fb_dtsg = tokens?.fb_dtsg ?? "";
    let lsd = tokens?.lsd ?? this.jar.get("lsd") ?? "";
    if (!fb_dtsg || !lsd) {
      const homeRes = await fetchIG("/", { cookieJar: this.jar });
      const html = await homeRes.text();
      const t = this.extractPageTokens(html);
      fb_dtsg = t.fb_dtsg ?? fb_dtsg;
      lsd = t.lsd ?? lsd;
    }
    if (!fb_dtsg || !lsd) {
      throw new Error(`Could not extract fb_dtsg/lsd for GraphQL seen mutation`);
    }

    const form = new URLSearchParams();
    form.set("av", "17841401631646403");
    form.set("__d", "www");
    form.set("__user", "0");
    form.set("__a", "1");
    form.set("__comet_req", "7");
    form.set("__crn", "comet.igweb.PolarisStoriesV3Route");
    form.set("fb_dtsg", fb_dtsg);
    form.set("jazoest", "26300");
    form.set("lsd", lsd);
    form.set("fb_api_caller_class", "RelayModern");
    form.set("fb_api_req_friendly_name", "PolarisStoriesV3SeenMutation");
    form.set("server_timestamps", "true");
    form.set("variables", JSON.stringify(variables));
    form.set("doc_id", "24372833149008516");

    const referer = `${BASE}/stories/${username}/`;
    const res = await fetchIG("/graphql/query", {
      method: "POST",
      body: form,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Referer": referer,
        "Accept": "*/*",
        "X-CSRFToken": this.csrf,
        "X-ASBD-ID": "359341",
        "X-FB-LSD": lsd,
        "X-IG-App-ID": "936619743392459",
        "X-FB-Friendly-Name": "PolarisStoriesV3SeenMutation",
        "X-Root-Field-Name": "xdt_api__v1__stories__reel__seen",
      },
      cookieJar: this.jar,
      apiRequest: true,
    });

    const text = await res.text();
    if (!res.ok) {
      throw new Error(`GraphQL seen mutation failed ${res.status}: ${text.slice(0, 200)}`);
    }
    const json = JSON.parse(text) as { status?: string; data?: { xdt_api__v1__stories__reel__seen?: unknown }; message?: string };
    if (json.status !== "ok" || !json.data?.xdt_api__v1__stories__reel__seen) {
      throw new Error(json.message ?? `GraphQL seen returned: ${text.slice(0, 150)}`);
    }
  }

  async markStoryItemAsSeen(params: {
    reelMediaId: string;
    reelMediaOwnerId: string;
    reelId: string;
    reelMediaTakenAt: string;
    viewSeenAt: string;
  }, username?: string): Promise<void> {
    const form = new URLSearchParams(params);
    const referer = username ? `${BASE}/stories/${username}/` : `${BASE}/`;

    const res = await fetchIG("/stories/reel/seen", {
      method: "POST",
      body: form,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-CSRFToken": this.csrf,
        "Referer": referer,
        "X-IG-App-ID": "936619743392459",
      },
      cookieJar: this.jar,
      apiRequest: true,
    });

    const text = await res.text();
    const location = res.headers.get("Location") ?? "";
    if (process.env.DEBUG) {
      console.log("[ig DEBUG] POST /stories/reel/seen", res.status, "Location:", location, "body:", text.slice(0, 300));
    }
    if (!res.ok) {
      const hint = res.status === 302 && location ? ` → redirects to ${location}` : "";
      throw new Error(`markStoryItemAsSeen failed ${res.status}${hint}`);
    }

    if (text && text.startsWith("{")) {
      const json = JSON.parse(text) as { status?: string; message?: string };
      if (json.status === "fail" || json.status === "error") {
        throw new Error(json.message ?? "markStoryItemAsSeen returned fail");
      }
    }
  }

  getSession(): string {
    return JSON.stringify(
      Object.fromEntries(this.jar.entries()),
      null,
      0
    );
  }

  loadSession(sessionJson: string): boolean {
    try {
      const obj = JSON.parse(sessionJson);
      this.jar = new Map(Object.entries(obj).map(([k, v]) => [k, String(v)]));
      this.csrf = getCsrfFromJar(this.jar);
      return this.jar.has("sessionid");
    } catch {
      return false;
    }
  }
}
