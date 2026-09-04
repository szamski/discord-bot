import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The tickets client reads `config.tickets`, which vitest's env deliberately
// leaves unset (the integration is opt-in). Mock the whole module so both the
// configured and unconfigured paths are testable.
const FULL_CONFIG = {
  conversationsToken: "conv-token",
  origin: "https://discord-bot.example.com",
  captureHost: "https://us.i.posthog.com",
  appHost: "https://us.posthog.com",
  restApiKey: "phx_test",
  projectId: "11111",
};

const { configMock } = vi.hoisted(() => ({
  configMock: { tickets: undefined as Record<string, unknown> | undefined },
}));
vi.mock("@/config.js", () => ({ config: configMock }));

const {
  clampMessage,
  createTicket,
  distinctIdFor,
  MAX_MESSAGE_CHARS,
  replyToTicket,
  ticketsEnabled,
  widgetSessionId,
} = await import("@/tickets/client.js");

const WIDGET_URL = "https://us.i.posthog.com/api/conversations/v1/widget/message";
const REST_BASE =
  "https://us.posthog.com/api/projects/11111/conversations/tickets";

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  configMock.tickets = { ...FULL_CONFIG };
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const jsonResponse = (status: number, body: unknown): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  }) as Response;

describe("clampMessage", () => {
  it("leaves a short message untouched", () => {
    expect(clampMessage("hello")).toBe("hello");
  });

  it("truncates to the API limit and marks the cut", () => {
    const out = clampMessage("x".repeat(MAX_MESSAGE_CHARS + 500));
    expect(out).toHaveLength(MAX_MESSAGE_CHARS);
    expect(out.endsWith("[truncated]")).toBe(true);
  });
});

describe("widgetSessionId", () => {
  it("is a valid v5-shaped uuid", () => {
    expect(widgetSessionId("123")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
  });

  it("is stable for the same user and distinct across users", () => {
    expect(widgetSessionId("123")).toBe(widgetSessionId("123"));
    expect(widgetSessionId("123")).not.toBe(widgetSessionId("124"));
  });
});

describe("ticketsEnabled", () => {
  it("is false when unconfigured, true when configured", () => {
    configMock.tickets = undefined;
    expect(ticketsEnabled()).toBe(false);
    configMock.tickets = { ...FULL_CONFIG };
    expect(ticketsEnabled()).toBe(true);
  });
});

describe("createTicket", () => {
  const args = {
    title: "App crashes",
    message: "It crashes on launch.",
    authorName: "@poster",
    discordUserId: "42",
  };

  it("posts to the widget endpoint with the public token and origin", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { ticket_id: "uuid-1", message_id: "m-1" })
    );

    const ticket = await createTicket(args);

    // The widget endpoint returns no ticket number.
    expect(ticket).toEqual({ id: "uuid-1", ticketNumber: null });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(WIDGET_URL);
    expect(init.headers["X-Conversations-Token"]).toBe("conv-token");
    // Required: PostHog enforces the Support domain allowlist server-side.
    expect(init.headers.Origin).toBe("https://discord-bot.example.com");
    expect(init.headers.Authorization).toBeUndefined();

    const body = JSON.parse(init.body);
    expect(body.message).toContain("**App crashes**");
    expect(body.message).toContain("It crashes on launch.");
    expect(body.distinct_id).toBe(distinctIdFor("42"));
    expect(body.widget_session_id).toBe(widgetSessionId("42"));
    expect(body.user_traits).toEqual({ name: "@poster" });
  });

  it("returns null on an API error", async () => {
    fetchMock.mockResolvedValue(jsonResponse(403, { error: "Origin not allowed" }));
    expect(await createTicket(args)).toBeNull();
  });

  it("returns null when the response carries no ticket_id", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { message_id: "m" }));
    expect(await createTicket(args)).toBeNull();
  });

  it("returns null (and never calls the API) when unconfigured", async () => {
    configMock.tickets = undefined;
    expect(await createTicket(args)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("survives a network failure", async () => {
    fetchMock.mockRejectedValue(new Error("offline"));
    expect(await createTicket(args)).toBeNull();
  });

  it("does not need the REST key", async () => {
    configMock.tickets = { ...FULL_CONFIG, restApiKey: undefined, projectId: undefined };
    fetchMock.mockResolvedValue(jsonResponse(200, { ticket_id: "u" }));
    expect(await createTicket(args)).toEqual({ id: "u", ticketNumber: null });
  });
});

describe("replyToTicket", () => {
  it("posts to the REST reply route with the personal API key", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, {}));

    const ok = await replyToTicket({
      ticketId: "uuid-1",
      message: "a follow-up",
      isPrivate: true,
    });

    expect(ok).toBe(true);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${REST_BASE}/uuid-1/reply/`);
    expect(init.headers.Authorization).toBe("Bearer phx_test");
    expect(JSON.parse(init.body)).toEqual({
      message: "a follow-up",
      is_private: true,
    });
  });

  it("url-encodes the ticket reference", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, {}));
    await replyToTicket({ ticketId: "a/b", message: "m", isPrivate: false });
    expect(fetchMock.mock.calls[0][0]).toBe(`${REST_BASE}/a%2Fb/reply/`);
  });

  it("returns false on an API error", async () => {
    fetchMock.mockResolvedValue(jsonResponse(403, { error: "forbidden" }));
    expect(
      await replyToTicket({ ticketId: "x", message: "m", isPrivate: true })
    ).toBe(false);
  });

  it("is a no-op without the REST key — creating tickets doesn't need it", async () => {
    configMock.tickets = { ...FULL_CONFIG, restApiKey: undefined, projectId: undefined };
    expect(
      await replyToTicket({ ticketId: "x", message: "m", isPrivate: true })
    ).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
