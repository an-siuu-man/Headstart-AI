import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const body = await req.json(); // expects { assignment_uuid, payload, pdf_extractions?, pdf_files? }

  const { assignment_uuid, payload } = body;
  const title = payload?.title ?? "(no title)";
  const courseId = payload?.courseId ?? "?";

  console.log(
    `[run-agent] POST | uuid=${assignment_uuid} | course=${courseId} | title=${JSON.stringify(title)}`,
  );

  const agentUrl = process.env.AGENT_SERVICE_URL;
  if (!agentUrl) {
    console.error("[run-agent] AGENT_SERVICE_URL is not set");
    return NextResponse.json(
      { error: "AGENT_SERVICE_URL not set" },
      { status: 500 },
    );
  }

  const targetUrl = `${agentUrl}/run-agent`;
  console.log(`[run-agent] Forwarding to agent service: ${targetUrl}`);

  const t0 = Date.now();

  const resp = await fetch(targetUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const elapsed = Date.now() - t0;
  const text = await resp.text();

  console.log(
    `[run-agent] Agent service responded | status=${resp.status} | elapsed=${elapsed}ms | bodyLen=${text.length}`,
  );

  if (!resp.ok) {
    console.error(
      `[run-agent] Agent service error (${resp.status}):`,
      text.slice(0, 500),
    );
    return NextResponse.json(
      { error: "Agent service error", detail: text },
      { status: 500 },
    );
  }

  console.log("[run-agent] Returning agent response to caller");

  return new NextResponse(text, {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
