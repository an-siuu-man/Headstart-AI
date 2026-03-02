/**
 * HTTP client for webapp API routes used by the extension background workflow.
 */

const DEFAULT_BACKEND_BASE_URL = "http://localhost:3000";

function toBaseUrl(baseUrl) {
  return (baseUrl || DEFAULT_BACKEND_BASE_URL).replace(/\/$/, "");
}

export async function ingestAssignment(payload, baseUrl) {
  const backendBaseUrl = toBaseUrl(baseUrl);
  const res = await fetch(`${backendBaseUrl}/api/ingest-assignment`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Ingest failed (${res.status}): ${errText}`);
  }

  return res.json();
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
    throw new Error(`chat-session failed (${res.status}): ${errText}`);
  }

  return res.json();
}

export async function runAgent({ assignmentUuid, payload, pdfFiles }, baseUrl) {
  const backendBaseUrl = toBaseUrl(baseUrl);

  const res = await fetch(`${backendBaseUrl}/api/run-agent`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      assignment_uuid: assignmentUuid,
      payload: {
        ...payload,
        assignment_uuid: assignmentUuid,
      },
      pdf_text: "",
      pdf_files: pdfFiles,
    }),
  });

  const rawBody = await res.clone().text();

  if (!res.ok) {
    throw new Error(`run-agent failed (${res.status}): ${rawBody.slice(0, 300)}`);
  }

  try {
    return JSON.parse(rawBody);
  } catch {
    throw new Error(`run-agent returned non-JSON: ${rawBody.slice(0, 300)}`);
  }
}
