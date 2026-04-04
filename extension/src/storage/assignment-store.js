/**
 * Assignment storage access layer for chrome.storage.local.
 */

const ASSIGNMENT_PREFIX = "assignment::";

export function buildAssignmentStorageKey(courseId, assignmentId) {
  return `${ASSIGNMENT_PREFIX}${courseId}::${assignmentId}`;
}

export async function getAssignmentRecord(courseId, assignmentId) {
  const storageKey = buildAssignmentStorageKey(courseId, assignmentId);
  const obj = await chrome.storage.local.get(storageKey);
  return { key: storageKey, record: obj?.[storageKey] || null };
}

export async function setAssignmentRecord(courseId, assignmentId, record) {
  const storageKey = buildAssignmentStorageKey(courseId, assignmentId);
  await chrome.storage.local.set({ [storageKey]: record });
  return storageKey;
}

export async function upsertDetectedAssignment(payload) {
  const { courseId, assignmentId, url, title, courseName, dueDate } = payload;
  const { key, record: existing } = await getAssignmentRecord(
    courseId,
    assignmentId,
  );

  const isNew = !existing;
  const next = {
    courseId,
    assignmentId,
    url,
    detectedAt: existing?.detectedAt || new Date().toISOString(),
    status: existing?.status || "detected",
    title: title || existing?.title || null,
    courseName: courseName || existing?.courseName || null,
    dueDate: dueDate || existing?.dueDate || null,
  };

  await chrome.storage.local.set({ [key]: next });
  return { key, isNew, record: next };
}

export async function mergeExtractedAssignment(payload, tabUrl) {
  const { courseId, assignmentId, data } = payload;
  const { key, record: prev } = await getAssignmentRecord(courseId, assignmentId);
  const previous = prev || {};

  const next = {
    courseId,
    assignmentId,
    url: tabUrl,
    detectedAt: previous.detectedAt || new Date().toISOString(),
    status: "extracted",
    title:
      data?.title && data.title.trim() !== ""
        ? data.title
        : (previous.title ?? null),
    courseName:
      data?.courseName && data.courseName.trim() !== ""
        ? data.courseName
        : (previous.courseName ?? null),
    dueDate:
      data?.dueDate && data.dueDate.trim() !== ""
        ? data.dueDate
        : (previous.dueDate ?? null),
    pointsPossible: data?.pointsPossible ?? previous.pointsPossible ?? null,
    descriptionText: data?.descriptionText ?? previous.descriptionText ?? null,
    rubric: data?.rubric ?? previous.rubric ?? null,
    userTimezone: data?.userTimezone ?? previous.userTimezone ?? null,
    pdfs: data?.pdfs ?? previous.pdfs ?? [],
    pdfAttachments: data?.pdfAttachments ?? previous.pdfAttachments ?? [],
    moduleResources: data?.moduleResources ?? previous.moduleResources ?? [],
    moduleResourcesMeta: data?.moduleResourcesMeta ?? previous.moduleResourcesMeta ?? null,
  };

  await chrome.storage.local.set({ [key]: next });
  return { key, record: next };
}
