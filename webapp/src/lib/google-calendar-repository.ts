import { supabaseTableRequest } from "@/lib/supabase-rest";
import { toOptionalString } from "@/lib/utils";

const GOOGLE_CALENDAR_TABLE = "google_calendar_integrations";
const GOOGLE_CALENDAR_SELECT =
  "user_id,status,google_email,scope,refresh_token,access_token,token_expires_at,connected_at,last_error,created_at,updated_at";

export type GoogleCalendarIntegrationStatus =
  | "connected"
  | "disconnected"
  | "needs_attention";

type DbGoogleCalendarIntegration = {
  user_id: string;
  status: GoogleCalendarIntegrationStatus;
  google_email?: string | null;
  scope?: string | null;
  refresh_token?: string | null;
  access_token?: string | null;
  token_expires_at?: string | null;
  connected_at?: string | null;
  last_error?: string | null;
  created_at?: string;
  updated_at?: string;
};

type DbAssignment = {
  id: string;
  course_id: string;
  canvas_url?: string | null;
};

type DbCourse = {
  id: string;
  integration_id: string;
  name?: string | null;
};

type DbLmsIntegration = {
  id: string;
  user_id: string;
};

type DbAssignmentSnapshot = {
  title?: string | null;
  due_at?: string | null;
  raw_payload: unknown;
};

export type GoogleCalendarIntegration = {
  userId: string;
  status: GoogleCalendarIntegrationStatus;
  googleEmail: string | null;
  scope: string | null;
  refreshToken: string | null;
  accessToken: string | null;
  tokenExpiresAt: string | null;
  connectedAt: string | null;
  lastError: string | null;
};

export type AssignmentCalendarMetadata = {
  assignmentId: string;
  title: string;
  dueAtISO: string | null;
  courseName: string | null;
  assignmentUrl: string | null;
  timezone: string | null;
};

export async function getGoogleCalendarIntegration(userId: string) {
  const row = await selectFirst<DbGoogleCalendarIntegration>({
    table: GOOGLE_CALENDAR_TABLE,
    query: {
      user_id: eq(userId),
      select: GOOGLE_CALENDAR_SELECT,
      limit: 1,
    },
  });

  return row ? toGoogleCalendarIntegration(row) : null;
}

export async function upsertConnectedGoogleCalendarIntegration(input: {
  userId: string;
  accessToken: string;
  refreshToken: string | null;
  scope: string | null;
  tokenExpiresAt: string | null;
  googleEmail?: string | null;
}) {
  const now = nowIso();
  const rows = await upsertRows<DbGoogleCalendarIntegration>({
    table: GOOGLE_CALENDAR_TABLE,
    onConflict: "user_id",
    select: GOOGLE_CALENDAR_SELECT,
    rows: [
      {
        user_id: input.userId,
        status: "connected",
        google_email: input.googleEmail ?? null,
        scope: input.scope,
        refresh_token: input.refreshToken,
        access_token: input.accessToken,
        token_expires_at: input.tokenExpiresAt,
        connected_at: now,
        last_error: null,
        updated_at: now,
      },
    ],
  });

  return toGoogleCalendarIntegration(rows[0]);
}

export async function updateGoogleCalendarAccessToken(input: {
  userId: string;
  accessToken: string;
  tokenExpiresAt: string | null;
  scope?: string | null;
}) {
  const rows = await supabaseTableRequest<DbGoogleCalendarIntegration[]>({
    table: GOOGLE_CALENDAR_TABLE,
    method: "PATCH",
    query: {
      user_id: eq(input.userId),
      select: GOOGLE_CALENDAR_SELECT,
    },
    headers: {
      Prefer: "return=representation",
    },
    body: {
      access_token: input.accessToken,
      token_expires_at: input.tokenExpiresAt,
      ...(input.scope ? { scope: input.scope } : {}),
      status: "connected",
      last_error: null,
      updated_at: nowIso(),
    },
  });

  if (!rows[0]) return null;
  return toGoogleCalendarIntegration(rows[0]);
}

export async function upsertDisconnectedGoogleCalendarIntegration(input: {
  userId: string;
  lastError?: string | null;
}) {
  const rows = await upsertRows<DbGoogleCalendarIntegration>({
    table: GOOGLE_CALENDAR_TABLE,
    onConflict: "user_id",
    select: GOOGLE_CALENDAR_SELECT,
    rows: [
      {
        user_id: input.userId,
        status: "disconnected",
        google_email: null,
        scope: null,
        refresh_token: null,
        access_token: null,
        token_expires_at: null,
        connected_at: null,
        last_error: input.lastError ?? null,
        updated_at: nowIso(),
      },
    ],
  });

  return toGoogleCalendarIntegration(rows[0]);
}

export async function upsertNeedsAttentionGoogleCalendarIntegration(input: {
  userId: string;
  lastError: string;
}) {
  const rows = await upsertRows<DbGoogleCalendarIntegration>({
    table: GOOGLE_CALENDAR_TABLE,
    onConflict: "user_id",
    select: GOOGLE_CALENDAR_SELECT,
    rows: [
      {
        user_id: input.userId,
        status: "needs_attention",
        last_error: input.lastError,
        updated_at: nowIso(),
      },
    ],
  });

  return toGoogleCalendarIntegration(rows[0]);
}

export async function getAssignmentCalendarMetadataForUser(input: {
  userId: string;
  assignmentId: string;
}): Promise<AssignmentCalendarMetadata | null> {
  const assignment = await selectFirst<DbAssignment>({
    table: "assignments",
    query: {
      id: eq(input.assignmentId),
      select: "id,course_id,canvas_url",
      limit: 1,
    },
  });

  if (!assignment) {
    return null;
  }

  const course = await selectFirst<DbCourse>({
    table: "courses",
    query: {
      id: eq(assignment.course_id),
      select: "id,integration_id,name",
      limit: 1,
    },
  });

  if (!course) {
    return null;
  }

  const integration = await selectFirst<DbLmsIntegration>({
    table: "lms_integrations",
    query: {
      id: eq(course.integration_id),
      user_id: eq(input.userId),
      select: "id,user_id",
      limit: 1,
    },
  });

  if (!integration) {
    return null;
  }

  const snapshot = await selectFirst<DbAssignmentSnapshot>({
    table: "assignment_snapshots",
    query: {
      assignment_id: eq(assignment.id),
      select: "title,due_at,raw_payload",
      order: "captured_at.desc",
      limit: 1,
    },
  });

  const payload = asObject(snapshot?.raw_payload);
  const title =
    toOptionalString(snapshot?.title) ??
    toOptionalString(payload.title) ??
    "Untitled assignment";

  return {
    assignmentId: assignment.id,
    title,
    dueAtISO:
      toOptionalString(snapshot?.due_at) ??
      toOptionalString(payload.dueAtISO) ??
      null,
    courseName:
      toOptionalString(course.name) ?? toOptionalString(payload.courseName) ?? null,
    assignmentUrl:
      toOptionalString(assignment.canvas_url) ?? toOptionalString(payload.url) ?? null,
    timezone: toOptionalString(payload.userTimezone) ?? null,
  };
}

async function selectFirst<T>(input: {
  table: string;
  query: Record<string, string | number | boolean | undefined>;
}) {
  const rows = await supabaseTableRequest<T[]>({
    table: input.table,
    method: "GET",
    query: input.query,
  });
  return rows[0] ?? null;
}

async function upsertRows<T>(input: {
  table: string;
  onConflict: string;
  select: string;
  rows: unknown[];
}) {
  return supabaseTableRequest<T[]>({
    table: input.table,
    method: "POST",
    query: {
      on_conflict: input.onConflict,
      select: input.select,
    },
    headers: {
      Prefer: "resolution=merge-duplicates,return=representation",
    },
    body: input.rows,
  });
}

function toGoogleCalendarIntegration(row: DbGoogleCalendarIntegration): GoogleCalendarIntegration {
  return {
    userId: row.user_id,
    status: row.status,
    googleEmail: toOptionalString(row.google_email),
    scope: toOptionalString(row.scope),
    refreshToken: toOptionalString(row.refresh_token),
    accessToken: toOptionalString(row.access_token),
    tokenExpiresAt: toOptionalString(row.token_expires_at),
    connectedAt: toOptionalString(row.connected_at),
    lastError: toOptionalString(row.last_error),
  };
}

function eq(value: string | number | boolean) {
  return `eq.${value}`;
}

function nowIso() {
  return new Date().toISOString();
}

function asObject(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}
