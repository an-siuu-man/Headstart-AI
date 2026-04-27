import { NextResponse } from "next/server";
import { applyAuthCookies, resolveRequestUser } from "@/lib/auth/session";
import { supabaseStorageCreateSignedUrl } from "@/lib/supabase-rest";

export const runtime = "nodejs";

const PDF_BUCKET = process.env.SUPABASE_ASSIGNMENT_PDF_BUCKET ?? "assignment-pdfs";
const IMAGE_BUCKET = process.env.SUPABASE_ASSIGNMENT_IMAGE_BUCKET ?? PDF_BUCKET;
const SIGNED_URL_TTL =
  Number(process.env.SUPABASE_ASSIGNMENT_PDF_SIGNED_URL_TTL_SECONDS ?? "600") || 600;

export async function GET(req: Request) {
  const resolvedUser = await resolveRequestUser(req);
  const userId = resolvedUser?.user.id ?? "";

  if (!userId) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const storagePath = searchParams.get("path");
  if (!storagePath) {
    return NextResponse.json({ error: "path is required" }, { status: 400 });
  }

  // Basic path validation: must be under chat-uploads/images/ and not contain traversal
  if (!storagePath.startsWith("chat-uploads/images/") || storagePath.includes("..")) {
    return NextResponse.json({ error: "invalid path" }, { status: 400 });
  }

  try {
    const signedUrl = await supabaseStorageCreateSignedUrl({
      bucket: IMAGE_BUCKET,
      path: storagePath,
      expiresInSeconds: SIGNED_URL_TTL,
    });

    const response = NextResponse.json({ url: signedUrl });
    if (resolvedUser?.refreshedSession) {
      applyAuthCookies(response, resolvedUser.refreshedSession);
    }
    return response;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: "Failed to generate signed URL", detail: message }, { status: 500 });
  }
}
