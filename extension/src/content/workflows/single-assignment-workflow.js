/**
 * Artifact: extension/src/content/workflows/single-assignment-workflow.js
 * Purpose: Runs single-assignment page flow to detect assignment context, extract data, persist via messaging, and inject the Canvas widget.
 * Author: Ansuman Sharma
 * Created: 2026-02-27
 * Revised:
 * - 2026-03-01: Added standardized file-level prologue metadata and interface contracts. (Ansuman Sharma)
 * Preconditions:
 * - Executed as a content-script module on a Canvas single-assignment page with DOM and chrome.runtime messaging access.
 * Inputs:
 * - Acceptable: `pageInfo` object with valid `courseId` and `assignmentId`, plus optional `courseName` string.
 * - Unacceptable: Null/undefined page info, missing assignment identifiers, or unsupported page contexts.
 * Postconditions:
 * - Sends ASSIGNMENT_DETECTED and ASSIGNMENT_DATA messages to background handlers and injects an assignment widget.
 * Returns:
 * - `runSingleAssignmentFlow` returns `Promise<void>` once extraction, messaging, and UI injection attempts complete.
 * Errors/Exceptions:
 * - Downstream extraction or messaging errors may propagate unless handled by called modules.
 */

import { MESSAGE_TYPES } from "../../shared/contracts/messages.js";
import { createLogger } from "../../shared/logger.js";
import { extractAssignmentData } from "../extractors/assignment-extractor.js";
import { fetchModuleResources } from "../extractors/modules-extractor.js";
import { injectWidget } from "../injectors/widget-injector.js";

const log = createLogger("SingleFlow");

/**
 * End-to-end single assignment page flow.
 */
export async function runSingleAssignmentFlow(pageInfo, courseName) {
  chrome.runtime.sendMessage({
    type: MESSAGE_TYPES.ASSIGNMENT_DETECTED,
    payload: {
      courseId: pageInfo.courseId,
      assignmentId: pageInfo.assignmentId,
      courseName,
      url: window.location.href,
    },
  });

  const [
    assignmentData,
    { resources: moduleResources, meta: moduleResourcesMeta },
  ] = await Promise.all([
    extractAssignmentData(document, pageInfo),
    fetchModuleResources(pageInfo.courseId, pageInfo.assignmentId),
  ]);

  assignmentData.moduleResources = moduleResources;
  assignmentData.moduleResourcesMeta = moduleResourcesMeta;

  log.info(
    "Extracted assignment data:",
    `title=\"${assignmentData.title}\"`,
    `| dueDate=${assignmentData.dueDate ?? "none"}`,
    `| points=${assignmentData.pointsPossible ?? "none"}`,
    `| rubric=${assignmentData.rubric ? assignmentData.rubric.criteria?.length + " criteria" : "none"}`,
    `| descLen=${assignmentData.descriptionText?.length ?? 0}`,
    `| pdfs=${assignmentData.pdfAttachments?.length ?? 0}`,
    `| modules=${moduleResources.length}`,
  );
  log.debug("Full extracted data:", assignmentData);

  chrome.runtime.sendMessage({
    type: MESSAGE_TYPES.ASSIGNMENT_DATA,
    payload: {
      courseId: pageInfo.courseId,
      assignmentId: pageInfo.assignmentId,
      data: assignmentData,
    },
  });

  log.debug("Injecting widget…");
  injectWidget(assignmentData);
}
