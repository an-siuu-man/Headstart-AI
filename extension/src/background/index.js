/**
 * Artifact: extension/src/background/index.js
 * Purpose: Registers background message routing and extension install/update lifecycle handlers.
 * Author: Ansuman 'Sharma'
 * Created: 2026-02-27
 * Revised:
 * - 2026-02-27: Split service-worker responsibilities into handlers/workflows with centralized routing. (Ansuman 'Sharma')
 * Preconditions:
 * - Executed in Chrome extension service worker context with runtime/action APIs available.
 * Inputs:
 * - Acceptable: Messages with known types defined in shared contracts and optional payload metadata.
 * - Unacceptable: Messages with unknown type identifiers or malformed payload shapes.
 * Postconditions:
 * - Matching handlers are invoked, response acknowledgements are sent, and lifecycle logs are emitted.
 * Returns:
 * - Listener callbacks return `true` to keep message channel open for async work.
 * Errors/Exceptions:
 * - Unknown message types return `{ status: "unknown" }`; downstream handler errors are logged by handlers.
 */

import { MESSAGE_TYPES } from "../shared/contracts/messages.js";
import { createLogger } from "../shared/logger.js";
import {
  handleAssignmentData,
  handleAssignmentDetected,
} from "./handlers/assignment-handlers.js";
import {
  handleCheckAssignmentGuideStatus,
  handleStartHeadstartRun,
} from "./workflows/headstart-run-workflow.js";

const log = createLogger("SW");

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  log.debug(
    "Message received:",
    message.type,
    "| tab:",
    sender.tab?.id,
    sender.tab?.url?.slice(0, 80),
  );

  switch (message.type) {
    case MESSAGE_TYPES.ASSIGNMENT_DETECTED:
      handleAssignmentDetected(message.payload, sender.tab);
      sendResponse({ status: "ack" });
      break;

    case MESSAGE_TYPES.ASSIGNMENT_DATA:
      handleAssignmentData(message.payload, sender.tab);
      sendResponse({ status: "ack" });
      break;

    case MESSAGE_TYPES.START_HEADSTART_RUN:
      log.info(
        "START_HEADSTART_RUN received for tab:",
        sender.tab?.id,
        "| pageTitle:",
        message.pageTitle,
      );
      // Keep the message channel open until the long-running workflow completes.
      // This helps prevent MV3 service worker suspension before result dispatch.
      (async () => {
        try {
          await handleStartHeadstartRun(sender.tab, message.pageTitle);
          sendResponse({ ok: true });
        } catch (e) {
          const err = String(e?.message || e);
          log.error("START_HEADSTART_RUN failed:", err);
          sendResponse({ ok: false, error: err });
        }
      })();
      break;

    case MESSAGE_TYPES.CHECK_ASSIGNMENT_GUIDE_STATUS:
      (async () => {
        try {
          const status = await handleCheckAssignmentGuideStatus(sender.tab);
          sendResponse({ ok: true, ...status });
        } catch (e) {
          const err = String(e?.message || e);
          log.error("CHECK_ASSIGNMENT_GUIDE_STATUS failed:", err);
          sendResponse({ ok: false, error: err });
        }
      })();
      break;

    default:
      log.warn("Unknown message type:", message.type);
      sendResponse({ status: "unknown" });
  }

  return true;
});

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === "install") {
    log.info("Extension installed.");
  } else if (details.reason === "update") {
    log.info(`Extension updated to v${chrome.runtime.getManifest().version}`);
  }
});
