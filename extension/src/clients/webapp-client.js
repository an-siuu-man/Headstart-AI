/**
 * HTTP client for webapp API routes used by the extension background workflow.
 */

const DEFAULT_BACKEND_BASE_URL = "http://localhost:3000";

function toBaseUrl(baseUrl) {
  return (baseUrl || DEFAULT_BACKEND_BASE_URL).replace(/\/$/, "");
}

function buildWebappHttpError({ endpoint, status, bodyText }) {
  const preview =
    typeof bodyText === "string" ? bodyText.slice(0, 300) : String(bodyText || "");
  const error = new Error(`${endpoint} failed (${status}): ${preview}`);
  error.name = "WebappHttpError";
  error.status = status;
  error.bodyPreview = preview;
  error.isAuthError = status === 401 || status === 403;
  return error;
}

export function isWebappAuthError(error) {
  if (!error || typeof error !== "object") return false;
  if (error.isAuthError === true) return true;
  return error.status === 401 || error.status === 403;
}

export async function createChatSession({ payload, userId }, baseUrl) {
  const backendBaseUrl = toBaseUrl(baseUrl);
  const body = { payload };
  if (typeof userId === "string" && userId.trim()) {
    body.user_id = userId.trim();
  }

  const res = await fetch(`${backendBaseUrl}/api/chat-session`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw buildWebappHttpError({
      endpoint: "chat-session",
      status: res.status,
      bodyText: errText,
    });
  }

  return res.json();
}

export async function getAssignmentGuideStatus(
  { courseId, assignmentId, instanceDomain },
  baseUrl,
) {
  const backendBaseUrl = toBaseUrl(baseUrl);
  const params = new URLSearchParams({
    course_id: String(courseId),
    assignment_id: String(assignmentId),
  });
  if (typeof instanceDomain === "string" && instanceDomain.trim()) {
    params.set("instance_domain", instanceDomain.trim().toLowerCase());
  }

  const res = await fetch(
    `${backendBaseUrl}/api/assignment-guide-status?${params.toString()}`,
    {
      method: "GET",
      credentials: "include",
      headers: { Accept: "application/json" },
    },
  );

  const rawBody = await res.text();

  if (!res.ok) {
    throw buildWebappHttpError({
      endpoint: "assignment-guide-status",
      status: res.status,
      bodyText: rawBody,
    });
  }

  try {
    return JSON.parse(rawBody);
  } catch {
    throw new Error(
      `assignment-guide-status returned non-JSON: ${rawBody.slice(0, 300)}`,
    );
  }
}
