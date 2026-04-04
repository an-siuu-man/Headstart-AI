/**
 * Canvas Modules Page Resource Extractor
 *
 * Fetches resources linked to the current assignment via the Canvas modules API.
 * Instructors often attach files/resources to a module rather than directly on
 * the assignment page — this extractor captures those so the agent has full context.
 *
 * API docs: https://canvas.instructure.com/doc/api/modules.html
 */

import { createLogger } from "../../shared/logger.js";

const log = createLogger("ModulesExtractor");

/**
 * Fetch resources from the Canvas modules that contain the given assignment.
 *
 * @param {string} courseId
 * @param {string} assignmentId
 * @returns {Promise<{ resources: ModuleResource[], meta: object }>}
 */
export async function fetchModuleResources(courseId, assignmentId) {
  try {
    log.info(
      `Fetching module resources: course=${courseId} assignment=${assignmentId}`,
    );

    const modules = await fetchModulesFromAPI(courseId);
    if (!modules) {
      return emptyResult("none");
    }

    if (modules.length === 0) {
      log.info("No modules found for course");
      return emptyResult("none");
    }

    log.debug(`Found ${modules.length} module(s)`);

    // Find modules that contain the current assignment
    const targetAssignmentId = Number(assignmentId);
    const matchingModules = modules.filter((mod) =>
      Array.isArray(mod.items) &&
      mod.items.some(
        (item) =>
          item.type === "Assignment" &&
          item.content_id === targetAssignmentId,
      ),
    );

    if (matchingModules.length === 0) {
      log.info(
        `Assignment ${assignmentId} not found in any module — skipping module resource extraction`,
      );
      return emptyResult("none");
    }

    log.info(
      `Assignment found in ${matchingModules.length} module(s): ${matchingModules.map((m) => `"${m.name}"`).join(", ")}`,
    );

    // Collect all items from matching modules (skip structural SubHeaders)
    const itemsToProcess = [];
    for (const mod of matchingModules) {
      for (const item of mod.items) {
        if (item.type === "SubHeader") continue;
        itemsToProcess.push({ module: mod, item });
      }
    }

    log.debug(`Processing ${itemsToProcess.length} module item(s)`);

    // Resolve file metadata in parallel — one failure must not abort the rest
    const settled = await Promise.allSettled(
      itemsToProcess.map(({ module: mod, item }) =>
        buildModuleResource(mod, item),
      ),
    );

    const resources = [];
    let pdfsDownloaded = 0;

    for (const result of settled) {
      if (result.status === "fulfilled" && result.value) {
        if (result.value.base64Data) pdfsDownloaded++;
        resources.push(result.value);
      } else if (result.status === "rejected") {
        log.warn("Failed to build module resource:", result.reason?.message);
      }
    }

    log.info(
      `Module extraction complete: ${resources.length} resource(s), ${pdfsDownloaded} PDF(s) downloaded`,
    );

    return {
      resources,
      meta: {
        source: "modules-api",
        modulesFound: matchingModules.length,
        itemsFound: itemsToProcess.length,
        pdfsDownloaded,
        extractedAt: new Date().toISOString(),
      },
    };
  } catch (err) {
    log.error("Module extraction failed:", err?.message || err);
    return emptyResult("none");
  }
}

// ──────────────────────────────────────────────
// Internal helpers
// ──────────────────────────────────────────────

/**
 * Fetch all modules with their items from the Canvas API.
 *
 * @param {string} courseId
 * @returns {Promise<object[]|null>} Array of modules, or null on API failure
 */
async function fetchModulesFromAPI(courseId) {
  const resp = await fetch(
    `/api/v1/courses/${courseId}/modules?include[]=items&per_page=100`,
    { credentials: "include" },
  );

  if (!resp.ok) {
    log.warn(`Modules API returned ${resp.status} — skipping module extraction`);
    return null;
  }

  return resp.json();
}

/**
 * Build a ModuleResource object for a single module item.
 * Fetches file metadata for File items and downloads PDFs.
 *
 * @param {object} mod - Canvas module object
 * @param {object} item - Canvas module item object
 * @returns {Promise<ModuleResource>}
 */
async function buildModuleResource(mod, item) {
  const base = {
    moduleId: mod.id,
    moduleName: mod.name || "",
    itemId: item.id,
    title: item.title || "",
    type: item.type || "Unknown",
    contentId: item.content_id ?? null,
    htmlUrl: item.html_url ?? null,
    apiUrl: item.url ?? null,
    published: item.published ?? false,
    // File-specific fields (populated below for File items)
    filename: null,
    mimeType: null,
    downloadUrl: null,
    base64Data: null,
  };

  if (item.type !== "File" || !item.url) {
    return base;
  }

  // Resolve file metadata from the Canvas files API
  const fileMeta = await fetchFileMetadata(item.url);
  if (!fileMeta) {
    return base;
  }

  base.filename = fileMeta.filename || fileMeta.display_name || item.title || null;
  base.mimeType = fileMeta["content-type"] || null;
  base.downloadUrl = fileMeta.url ?? null;

  const isPdf =
    base.mimeType === "application/pdf" ||
    base.filename?.toLowerCase().endsWith(".pdf");

  if (isPdf && base.downloadUrl) {
    const downloaded = await downloadPdf(base.downloadUrl, base.filename);
    if (downloaded) {
      base.base64Data = downloaded.base64Data;
    }
  }

  return base;
}

/**
 * Fetch Canvas file metadata from the given API URL.
 *
 * @param {string} apiUrl - Canvas file API URL (e.g. /api/v1/files/123)
 * @returns {Promise<object|null>}
 */
async function fetchFileMetadata(apiUrl) {
  try {
    const resp = await fetch(apiUrl, { credentials: "include" });
    if (!resp.ok) {
      log.warn(`File metadata fetch returned ${resp.status} for ${apiUrl}`);
      return null;
    }
    return resp.json();
  } catch (err) {
    log.warn(`File metadata fetch failed for ${apiUrl}:`, err?.message);
    return null;
  }
}

/**
 * Download a PDF from the given URL and return it as base64.
 *
 * Canvas file API endpoints return JSON metadata with a `url` field pointing
 * to the actual download location (usually an S3 presigned URL). This function
 * detects JSON responses and follows the `url` automatically.
 *
 * @param {string} url
 * @param {string} filename
 * @returns {Promise<{filename: string, base64Data: string}|null>}
 */
async function downloadPdf(url, filename) {
  try {
    log.debug(`Downloading PDF: "${filename}" from ${url.slice(0, 120)}`);

    let resp = await fetch(url, { credentials: "include" });

    if (!resp.ok) {
      log.warn(`Failed to download "${filename}" – HTTP ${resp.status}`);
      return null;
    }

    const contentType = resp.headers.get("content-type") || "";

    // Canvas API file endpoints return JSON metadata, not the file itself.
    // If we detect JSON, extract the real download URL from the `url` field.
    if (contentType.includes("application/json")) {
      const meta = await resp.json();
      const realUrl = meta.url;
      if (!realUrl) {
        log.warn(`"${filename}" API response has no url field:`, Object.keys(meta));
        return null;
      }
      log.debug(
        `"${filename}" following real download URL: ${realUrl.slice(0, 120)}`,
      );

      resp = await fetch(realUrl);
      if (!resp.ok) {
        log.warn(
          `Failed to download "${filename}" from real URL – HTTP ${resp.status}`,
        );
        return null;
      }
    }

    const buffer = await resp.arrayBuffer();
    const base64Data = arrayBufferToBase64(buffer);

    log.debug(
      `Downloaded "${filename}" – ${buffer.byteLength} bytes, ${base64Data.length} chars base64`,
    );
    return { filename, base64Data };
  } catch (err) {
    log.warn(`Error downloading PDF "${filename}":`, err?.message || err);
    return null;
  }
}

/**
 * Convert an ArrayBuffer to a base64-encoded string.
 */
function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * @returns {{ resources: [], meta: object }}
 */
function emptyResult(source) {
  return {
    resources: [],
    meta: {
      source,
      modulesFound: 0,
      itemsFound: 0,
      pdfsDownloaded: 0,
      extractedAt: new Date().toISOString(),
    },
  };
}
