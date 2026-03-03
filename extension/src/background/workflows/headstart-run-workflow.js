/**
 * Artifact: extension/src/background/workflows/headstart-run-workflow.js
 * Purpose: Orchestrates START_HEADSTART_RUN handling by building a normalized payload and creating a dashboard chat session handoff.
 * Author: Ansuman Sharma
 * Created: 2026-02-27
 * Revised:
 * - 2026-03-01: Added standardized file-level prologue metadata and interface contracts. (Ansuman Sharma)
 * Preconditions:
 * - Executed in Chrome extension background service-worker context with runtime, tabs, and storage APIs available.
 * Inputs:
 * - Acceptable: A Canvas assignment `tab` object (with `id` and assignment URL) and optional `pageTitle` string.
 * - Unacceptable: Missing/invalid tab references, non-assignment URLs, or missing stored assignment records.
 * Postconditions:
 * - On success, creates a webapp chat session and sends HEADSTART_RESULT with dashboard redirect URL to the source tab.
 * - On failure, sends HEADSTART_ERROR with a user-safe message to the source tab.
 * Returns:
 * - `handleStartHeadstartRun` returns `Promise<void>` after completing messaging side effects.
 * Errors/Exceptions:
 * - Network, storage, and runtime messaging failures are caught and surfaced via HEADSTART_ERROR messages.
 */

import {
  createChatSession,
  getAssignmentGuideStatus,
} from "../../clients/webapp-client.js";
import { MESSAGE_TYPES } from "../../shared/contracts/messages.js";
import { createLogger } from "../../shared/logger.js";
import { getAssignmentRecord } from "../../storage/assignment-store.js";
import {
  buildHeadstartPayload,
  getCanvasIdsFromUrl,
} from "./headstart-payload.js";

const log = createLogger("SW.Run");

const BACKEND_BASE_URL = "http://localhost:3000";

function buildChatUrl(sessionId) {
  const base = BACKEND_BASE_URL.replace(/\/$/, "");
  return `${base}/dashboard/chat?session=${encodeURIComponent(sessionId)}`;
}

function getTabHostname(tabUrl) {
  if (!tabUrl || typeof tabUrl !== "string") return null;
  try {
    return new URL(tabUrl).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function isNoResponseMessagePortError(message) {
  if (!message || typeof message !== "string") return false;
  return message.includes("The message port closed before a response was received");
}

function sendToTabWithLogging(tabId, message, logContext) {
  if (!tabId) {
    log.error(`${logContext}: missing tab id; cannot send message`);
    return;
  }

  chrome.tabs.sendMessage(tabId, message, () => {
    if (chrome.runtime.lastError) {
      const errorMessage = chrome.runtime.lastError.message || "unknown runtime error";
      if (isNoResponseMessagePortError(errorMessage)) {
        // One-way messages in the widget do not call sendResponse.
        // Treat this as delivered to avoid noisy false alarms in console logs.
        log.debug(`${logContext}: delivered to tab ${tabId} (no response expected)`);
        return;
      }
      log.warn(`${logContext}: delivery warning:`, errorMessage);
      return;
    }
    log.info(`${logContext}: delivered to tab ${tabId}`);
  });
}

/**
 * Build payload from the currently-open assignment tab and hand off to webapp chat UI.
 */
export async function handleStartHeadstartRun(tab, pageTitle) {
  const ids = getCanvasIdsFromUrl(tab?.url || "");
  if (!ids) {
    log.warn("START_HEADSTART_RUN: not on a Canvas assignment URL:", tab?.url);
    sendToTabWithLogging(tab?.id, {
      type: MESSAGE_TYPES.HEADSTART_ERROR,
      error: "Not on a Canvas assignment page.",
    }, "HEADSTART_ERROR");
    return;
  }

  const { key, record: stored } = await getAssignmentRecord(
    ids.courseId,
    ids.assignmentId,
  );

  log.info("Loading stored assignment:", key);

  if (!stored) {
    log.warn("No stored record for:", key);
    sendToTabWithLogging(tab?.id, {
      type: MESSAGE_TYPES.HEADSTART_ERROR,
      error: `No stored assignment found for key ${key}`,
    }, "HEADSTART_ERROR");
    return;
  }

  const payload = buildHeadstartPayload(stored);

  log.info(
    "Built payload:",
    `title="${payload.title}"`,
    `dueAtISO=${payload.dueAtISO}`,
    `daysToDue=${payload.flags.daysToDue}`,
  );
  log.debug("Full payload:", payload);

  if ((!payload.title || payload.title.trim() === "") && pageTitle) {
    payload.title = pageTitle.replace(" - Assignments", "").trim();
    log.debug("Applied pageTitle fallback:", payload.title);
  }

  try {
    log.info(`POST ${BACKEND_BASE_URL}/api/chat-session`);
    const sessionStart = Date.now();
    const session = await createChatSession(
      { payload, userId: payload.userId || payload.user_id },
      BACKEND_BASE_URL,
    );
    log.info(`/api/chat-session -> 200 (${Date.now() - sessionStart}ms)`);
    log.debug("/api/chat-session response:", session);

    if (!session?.session_id) {
      throw new Error("chat-session response missing session_id");
    }

    const redirectUrl = buildChatUrl(session.session_id);
    log.info("Created dashboard chat URL:", redirectUrl);

    sendToTabWithLogging(tab?.id, {
      type: MESSAGE_TYPES.HEADSTART_RESULT,
      result: {
        status: "chat_session_created",
        sessionId: session.session_id,
        redirectUrl,
      },
    }, "HEADSTART_RESULT");
  } catch (e) {
    log.error("handleStartHeadstartRun failed:", e?.message || e);
    sendToTabWithLogging(tab?.id, {
      type: MESSAGE_TYPES.HEADSTART_ERROR,
      error: String(e?.message || e),
    }, "HEADSTART_ERROR");
  }
}

export async function handleCheckAssignmentGuideStatus(tab) {
  const ids = getCanvasIdsFromUrl(tab?.url || "");
  if (!ids) {
    return {
      exists: false,
      latestSessionId: null,
      latestSessionUpdatedAt: null,
      status: null,
    };
  }

  const instanceDomain = getTabHostname(tab?.url);

  try {
    log.info(
      "Checking existing guide status:",
      `course=${ids.courseId}`,
      `assignment=${ids.assignmentId}`,
      `domain=${instanceDomain ?? "unknown"}`,
    );
    const result = await getAssignmentGuideStatus(
      {
        courseId: ids.courseId,
        assignmentId: ids.assignmentId,
        instanceDomain,
      },
      BACKEND_BASE_URL,
    );

    return {
      exists: Boolean(result?.exists),
      latestSessionId:
        typeof result?.latest_session_id === "string" ? result.latest_session_id : null,
      latestSessionUpdatedAt:
        typeof result?.latest_session_updated_at === "number"
          ? result.latest_session_updated_at
          : null,
      status: typeof result?.status === "string" ? result.status : null,
    };
  } catch (e) {
    log.warn(
      "Existing guide status lookup failed:",
      e?.message || e,
    );
    return {
      exists: false,
      latestSessionId: null,
      latestSessionUpdatedAt: null,
      status: null,
    };
  }
}
