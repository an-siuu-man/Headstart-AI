import { NextResponse } from "next/server";
import {
  assertSessionOwnership,
  getPersistedSessionSnapshot,
} from "@/lib/chat-repository";
import { getRuntimeSession } from "@/lib/chat-runtime-store";
import { buildSessionDto } from "@/lib/chat-types";
import { applyAuthCookies, resolveRequestUser } from "@/lib/auth/session";

export const runtime = "nodejs";

const DEFAULT_WAIT_MS = 25000;
const MIN_WAIT_MS = 0;
const MAX_WAIT_MS = 30000;

function sleep(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function toBoundedWaitMs(rawValue: string | null) {
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed)) return DEFAULT_WAIT_MS;
  return Math.min(MAX_WAIT_MS, Math.max(MIN_WAIT_MS, Math.floor(parsed)));
}

function toSinceEpoch(rawValue: string | null) {
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.floor(parsed);
}

function isTerminalStatus(status: string) {
  return status === "completed" || status === "failed" || status === "archived";
}

async function loadSessionDto(sessionId: string) {
  const snapshot = await getPersistedSessionSnapshot(sessionId);
  if (!snapshot) return null;
  const runtime = getRuntimeSession(sessionId);
  return buildSessionDto(snapshot, runtime);
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const { sessionId } = await params;
  const resolvedUser = await resolveRequestUser(req);
  const userId = resolvedUser?.user.id ?? "";

  if (!userId) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  const ownedSession = await assertSessionOwnership(sessionId, userId);
  if (!ownedSession) {
    return NextResponse.json(
      { error: "session not found or expired" },
      { status: 404 },
    );
  }

  const url = new URL(req.url);
  const sinceEpoch = toSinceEpoch(url.searchParams.get("since"));
  const waitMs = toBoundedWaitMs(url.searchParams.get("wait_ms"));

  let session = await loadSessionDto(sessionId);
  if (!session) {
    return NextResponse.json(
      { error: "session not found or expired" },
      { status: 404 },
    );
  }

  if (
    sinceEpoch &&
    waitMs > 0 &&
    session.updated_at <= sinceEpoch &&
    !isTerminalStatus(session.status)
  ) {
    const startedAt = Date.now();

    while (Date.now() - startedAt < waitMs) {
      await sleep(300);
      const next = await loadSessionDto(sessionId);
      if (!next) {
        return NextResponse.json(
          { error: "session not found or expired" },
          { status: 404 },
        );
      }

      session = next;
      if (session.updated_at > sinceEpoch || isTerminalStatus(session.status)) {
        break;
      }
    }

    if (session.updated_at <= sinceEpoch && !isTerminalStatus(session.status)) {
      return new NextResponse(null, { status: 204 });
    }
  }

  const response = NextResponse.json(session);
  if (resolvedUser?.refreshedSession) {
    applyAuthCookies(response, resolvedUser.refreshedSession);
  }
  return response;
}
