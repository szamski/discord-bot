import "dotenv/config";

/**
 * Bot-level configuration loaded from the environment. This is intentionally
 * minimal — PostHog credentials are NOT here, because they are configured
 * per-guild at runtime via the `/ph connect` flow and stored in
 * SQLite. See {@link file://./db.ts}.
 */
export interface BotConfig {
  discordToken: string;
  discordClientId: string;
  databasePath: string;
  /** How often to emit the server_snapshot event, in hours (default 1). */
  snapshotIntervalHours: number;
  /** How often to emit the member_roster event set, in hours (default 24). */
  rosterIntervalHours: number;
  /**
   * Shared secret for the PostHog Code bridge, used as a bearer token in BOTH
   * directions: the bot sends it when forwarding interactions to PostHog, and
   * requires it on inbound calls to the actions API. See `src/bridge/`.
   */
  sharedSecret: string;
  /** host:port the bot's inbound actions API binds to (PostHog → bot). */
  actionsBind: { host: string; port: number };
  /**
   * Dev-only override for the PostHog app host the bridge forwards to. When set,
   * it replaces the per-guild region derivation (us/eu cloud) entirely — point
   * it at a local PostHog, e.g. http://127.0.0.1:8000. Unset in production.
   */
  bridgeBaseUrl?: string;
  /**
   * PostHog Support (tickets) integration. Optional: when absent the bot behaves
   * exactly as before and never touches the tickets API.
   */
  tickets?: TicketsConfig;
}

export interface TicketsConfig {
  /**
   * The project's **public** conversations token (from Settings → Support).
   * Publishable, like the analytics key — it only opens tickets.
   */
  conversationsToken: string;
  /**
   * Origin sent with widget calls. Must be one of the domains on the project's
   * Support allowlist, or PostHog answers 403 "Origin not allowed".
   */
  origin: string;
  /** Capture host the widget endpoint lives on (e.g. https://us.i.posthog.com). */
  captureHost: string;
  /** App host the REST tickets API lives on (e.g. https://us.posthog.com). */
  appHost: string;
  /**
   * Optional personal API key with the `ticket:write` scope, needed only to
   * append messages to an existing ticket. Creating tickets doesn't use it.
   * It carries real write authority, so it stays in env and never in SQLite.
   */
  restApiKey?: string;
  /** Numeric project id — required alongside {@link restApiKey}. */
  projectId?: string;
}

function positiveNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(
      `Missing required environment variable: ${name}. ` +
        `Copy .env.example to .env and fill it in.`
    );
  }
  return value.trim();
}

/** Parse a required `host:port` env var (e.g. `0.0.0.0:8080`). */
function requiredBind(name: string): { host: string; port: number } {
  const raw = required(name);
  const idx = raw.lastIndexOf(":");
  if (idx === -1) {
    throw new Error(`${name} must be in host:port form, e.g. 0.0.0.0:8080 (got "${raw}").`);
  }
  const host = raw.slice(0, idx) || "0.0.0.0";
  const port = Number(raw.slice(idx + 1));
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${name} has an invalid port: "${raw}".`);
  }
  return { host, port };
}

/** Default PostHog Cloud hosts for the tickets integration (US region). */
const DEFAULT_TICKETS_APP_HOST = "https://us.posthog.com";
const DEFAULT_TICKETS_CAPTURE_HOST = "https://us.i.posthog.com";

/**
 * Read the tickets config, or return undefined when the integration isn't
 * configured. The conversations token and origin are what make it work at all,
 * so they're required together; the REST key is a separate, optional half that
 * only enables appending to existing tickets.
 */
function ticketsConfig(): TicketsConfig | undefined {
  const conversationsToken = process.env.POSTHOG_CONVERSATIONS_TOKEN?.trim();
  const origin = process.env.POSTHOG_CONVERSATIONS_ORIGIN?.trim().replace(/\/+$/, "");
  if (!conversationsToken && !origin) return undefined;
  if (!conversationsToken || !origin) {
    throw new Error(
      "POSTHOG_CONVERSATIONS_TOKEN and POSTHOG_CONVERSATIONS_ORIGIN must be set " +
        "together (or both left unset to disable the tickets integration). The " +
        "origin must be a domain on the project's Support allowlist."
    );
  }

  const restApiKey = process.env.POSTHOG_TICKETS_API_KEY?.trim() || undefined;
  const projectId = process.env.POSTHOG_TICKETS_PROJECT_ID?.trim() || undefined;
  if (Boolean(restApiKey) !== Boolean(projectId)) {
    throw new Error(
      "POSTHOG_TICKETS_API_KEY and POSTHOG_TICKETS_PROJECT_ID must be set together " +
        "(both are only needed to append messages to existing tickets)."
    );
  }
  if (projectId && !/^\d+$/.test(projectId)) {
    throw new Error(
      `POSTHOG_TICKETS_PROJECT_ID must be a numeric project id (got "${projectId}").`
    );
  }

  return {
    conversationsToken,
    origin,
    captureHost:
      process.env.POSTHOG_TICKETS_CAPTURE_HOST?.trim().replace(/\/+$/, "") ||
      DEFAULT_TICKETS_CAPTURE_HOST,
    appHost:
      process.env.POSTHOG_TICKETS_HOST?.trim().replace(/\/+$/, "") ||
      DEFAULT_TICKETS_APP_HOST,
    restApiKey,
    projectId,
  };
}

export const config: BotConfig = {
  discordToken: required("DISCORD_BOT_TOKEN"),
  discordClientId: required("DISCORD_APPLICATION_ID"),
  databasePath: process.env.DATABASE_PATH?.trim() || "./data/bot.sqlite",
  // Hourly, because the presence count is only interesting as a shape over the
  // day: sampled once every 24h it lands on the same hour every time, which
  // describes one moment rather than when the server is actually busy. The cost is
  // one REST call and one event per server per hour.
  snapshotIntervalHours: positiveNumber("SNAPSHOT_INTERVAL_HOURS", 1),
  rosterIntervalHours: positiveNumber("ROSTER_INTERVAL_HOURS", 24),
  sharedSecret: required("POSTHOG_DISCORD_SHARED_SECRET"),
  actionsBind: requiredBind("BOT_ACTIONS_BIND"),
  bridgeBaseUrl: process.env.POSTHOG_BRIDGE_BASE_URL?.trim().replace(/\/+$/, "") || undefined,
  tickets: ticketsConfig(),
};
