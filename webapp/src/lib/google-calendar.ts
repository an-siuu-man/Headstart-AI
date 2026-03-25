const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const GOOGLE_CALENDAR_EVENTS_URL =
  "https://www.googleapis.com/calendar/v3/calendars/primary/events";
const GOOGLE_CALENDAR_MAX_RESULTS = 2500;

const DEFAULT_SCOPES = [
  "https://www.googleapis.com/auth/calendar.events",
  "openid",
  "email",
];

export type GoogleOAuthConfig = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scopes: string[];
};

export type GoogleTokenSet = {
  accessToken: string;
  refreshToken: string | null;
  expiresIn: number | null;
  scope: string | null;
  tokenType: string | null;
};

export type GoogleCalendarEventInput = {
  summary: string;
  description?: string;
  startIso: string;
  endIso: string;
  timezone?: string;
};

export type GoogleCalendarEventResult = {
  id: string;
  htmlLink: string | null;
  status: string | null;
};

export type GoogleCalendarListedEventDateTime = {
  dateTime: string | null;
  date: string | null;
  timeZone: string | null;
};

export type GoogleCalendarListedEvent = {
  id: string;
  status: string | null;
  summary: string | null;
  htmlLink: string | null;
  start: GoogleCalendarListedEventDateTime;
  end: GoogleCalendarListedEventDateTime;
};

export class GoogleCalendarApiError extends Error {
  status: number;
  details: unknown;

  constructor(message: string, status: number, details: unknown) {
    super(message);
    this.name = "GoogleCalendarApiError";
    this.status = status;
    this.details = details;
  }
}

export function getGoogleOAuthConfig(requestUrl: string): GoogleOAuthConfig {
  const clientId = (process.env.GOOGLE_OAUTH_CLIENT_ID || "").trim();
  const clientSecret = (process.env.GOOGLE_OAUTH_CLIENT_SECRET || "").trim();
  const configuredRedirect = (process.env.GOOGLE_OAUTH_REDIRECT_URI || "").trim();
  const configuredScopes = (process.env.GOOGLE_OAUTH_SCOPES || "").trim();

  if (!clientId) {
    throw new Error("GOOGLE_OAUTH_CLIENT_ID is required.");
  }
  if (!clientSecret) {
    throw new Error("GOOGLE_OAUTH_CLIENT_SECRET is required.");
  }

  const url = new URL(requestUrl);
  const redirectUri =
    configuredRedirect ||
    `${url.protocol}//${url.host}/api/integrations/google-calendar/callback`;

  const scopes =
    configuredScopes.length > 0
      ? configuredScopes.split(/\s+/).filter((value) => value.length > 0)
      : DEFAULT_SCOPES;

  return {
    clientId,
    clientSecret,
    redirectUri,
    scopes,
  };
}

export function buildGoogleOAuthAuthorizeUrl(input: {
  config: GoogleOAuthConfig;
  state: string;
}) {
  const url = new URL(GOOGLE_AUTH_URL);
  url.searchParams.set("client_id", input.config.clientId);
  url.searchParams.set("redirect_uri", input.config.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", input.config.scopes.join(" "));
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("include_granted_scopes", "true");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("state", input.state);
  return url.toString();
}

export async function exchangeGoogleCodeForTokens(input: {
  config: GoogleOAuthConfig;
  code: string;
}): Promise<GoogleTokenSet> {
  const body = new URLSearchParams();
  body.set("client_id", input.config.clientId);
  body.set("client_secret", input.config.clientSecret);
  body.set("code", input.code);
  body.set("redirect_uri", input.config.redirectUri);
  body.set("grant_type", "authorization_code");

  const payload = await postGoogleToken(body);

  return {
    accessToken: readString(payload, "access_token"),
    refreshToken: readNullableString(payload, "refresh_token"),
    expiresIn: readNullableNumber(payload, "expires_in"),
    scope: readNullableString(payload, "scope"),
    tokenType: readNullableString(payload, "token_type"),
  };
}

export async function refreshGoogleAccessToken(input: {
  config: GoogleOAuthConfig;
  refreshToken: string;
}): Promise<GoogleTokenSet> {
  const body = new URLSearchParams();
  body.set("client_id", input.config.clientId);
  body.set("client_secret", input.config.clientSecret);
  body.set("refresh_token", input.refreshToken);
  body.set("grant_type", "refresh_token");

  const payload = await postGoogleToken(body);

  return {
    accessToken: readString(payload, "access_token"),
    refreshToken: readNullableString(payload, "refresh_token"),
    expiresIn: readNullableNumber(payload, "expires_in"),
    scope: readNullableString(payload, "scope"),
    tokenType: readNullableString(payload, "token_type"),
  };
}

export async function revokeGoogleToken(token: string) {
  const trimmed = token.trim();
  if (!trimmed) return;

  const body = new URLSearchParams();
  body.set("token", trimmed);

  const response = await fetch(GOOGLE_REVOKE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
    cache: "no-store",
  });

  if (!response.ok) {
    const raw = await response.text();
    throw new GoogleCalendarApiError(
      `Google token revocation failed (${response.status})`,
      response.status,
      safeParseJson(raw) ?? raw,
    );
  }
}

export async function createGoogleCalendarEvent(input: {
  accessToken: string;
  event: GoogleCalendarEventInput;
}): Promise<GoogleCalendarEventResult> {
  const response = await fetch(GOOGLE_CALENDAR_EVENTS_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.accessToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      summary: input.event.summary,
      description: input.event.description ?? null,
      start: {
        dateTime: input.event.startIso,
        ...(input.event.timezone ? { timeZone: input.event.timezone } : {}),
      },
      end: {
        dateTime: input.event.endIso,
        ...(input.event.timezone ? { timeZone: input.event.timezone } : {}),
      },
    }),
    cache: "no-store",
  });

  const raw = await response.text();
  const parsed = safeParseJson(raw);

  if (!response.ok) {
    throw new GoogleCalendarApiError(
      `Google Calendar event creation failed (${response.status})`,
      response.status,
      parsed ?? raw,
    );
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error("Google Calendar event response was empty.");
  }

  return {
    id: readString(parsed, "id"),
    htmlLink: readNullableString(parsed, "htmlLink"),
    status: readNullableString(parsed, "status"),
  };
}

export async function listGoogleCalendarEvents(input: {
  accessToken: string;
  timeMinIso: string;
  timeMaxIso: string;
}) {
  const events: GoogleCalendarListedEvent[] = [];
  let nextPageToken: string | null = null;

  do {
    const page = await fetchGoogleCalendarEventsPage({
      accessToken: input.accessToken,
      timeMinIso: input.timeMinIso,
      timeMaxIso: input.timeMaxIso,
      pageToken: nextPageToken,
    });

    events.push(...page.items);
    nextPageToken = page.nextPageToken;
  } while (nextPageToken);

  return events;
}

async function fetchGoogleCalendarEventsPage(input: {
  accessToken: string;
  timeMinIso: string;
  timeMaxIso: string;
  pageToken: string | null;
}) {
  const url = new URL(GOOGLE_CALENDAR_EVENTS_URL);
  url.searchParams.set("timeMin", input.timeMinIso);
  url.searchParams.set("timeMax", input.timeMaxIso);
  url.searchParams.set("singleEvents", "true");
  url.searchParams.set("orderBy", "startTime");
  url.searchParams.set("maxResults", String(GOOGLE_CALENDAR_MAX_RESULTS));
  if (input.pageToken) {
    url.searchParams.set("pageToken", input.pageToken);
  }

  const response = await fetch(url.toString(), {
    method: "GET",
    headers: {
      Authorization: `Bearer ${input.accessToken}`,
      Accept: "application/json",
    },
    cache: "no-store",
  });

  const raw = await response.text();
  const parsed = safeParseJson(raw);

  if (!response.ok) {
    throw new GoogleCalendarApiError(
      `Google Calendar events listing failed (${response.status})`,
      response.status,
      parsed ?? raw,
    );
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error("Google Calendar events response was empty.");
  }

  const parsedRecord = parsed as Record<string, unknown>;
  const itemsRaw = parsedRecord.items;
  const items: unknown[] = Array.isArray(itemsRaw) ? itemsRaw : [];

  return {
    items: items
      .filter((value): value is Record<string, unknown> => {
        return Boolean(value && typeof value === "object" && !Array.isArray(value));
      })
      .map((item) => ({
        id: readString(item, "id"),
        status: readNullableString(item, "status"),
        summary: readNullableString(item, "summary"),
        htmlLink: readNullableString(item, "htmlLink"),
        start: readDateTimeObject(item, "start"),
        end: readDateTimeObject(item, "end"),
      })),
    nextPageToken: readNullableString(parsed, "nextPageToken"),
  };
}

async function postGoogleToken(body: URLSearchParams) {
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: body.toString(),
    cache: "no-store",
  });

  const raw = await response.text();
  const parsed = safeParseJson(raw);

  if (!response.ok) {
    throw new GoogleCalendarApiError(
      `Google token exchange failed (${response.status})`,
      response.status,
      parsed ?? raw,
    );
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error("Google token endpoint returned an empty response.");
  }

  return parsed;
}

function readDateTimeObject(source: unknown, key: string): GoogleCalendarListedEventDateTime {
  const value = readNullableObject(source, key);
  return {
    dateTime: readNullableString(value, "dateTime"),
    date: readNullableString(value, "date"),
    timeZone: readNullableString(value, "timeZone"),
  };
}

function readNullableObject(source: unknown, key: string) {
  if (!source || typeof source !== "object") return null;
  const value = (source as Record<string, unknown>)[key];
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function safeParseJson(raw: string) {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function readString(source: unknown, key: string) {
  if (!source || typeof source !== "object") {
    throw new Error(`Missing ${key} in response.`);
  }
  const value = (source as Record<string, unknown>)[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Missing ${key} in response.`);
  }
  return value;
}

function readNullableString(source: unknown, key: string) {
  if (!source || typeof source !== "object") return null;
  const value = (source as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function readNullableNumber(source: unknown, key: string) {
  if (!source || typeof source !== "object") return null;
  const value = (source as Record<string, unknown>)[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

