import { NextResponse } from "next/server";
import {
  assertSessionOwnership,
} from "@/lib/chat-repository";
import { applyAuthCookies, resolveRequestUser } from "@/lib/auth/session";
import {
  supabaseStorageUploadObject,
  supabaseTableRequest,
} from "@/lib/supabase-rest";

export const runtime = "nodejs";

const CHAT_UPLOAD_BUCKET =
  (process.env.SUPABASE_ASSIGNMENT_PDF_BUCKET ?? "assignment-pdfs");
const CHAT_UPLOAD_MAX_BYTES = 10 * 1024 * 1024; // 10 MB

function bufferToHex(buffer: ArrayBuffer) {
  return Array.from(new Uint8Array(buffer))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function sha256HexFromBytes(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy.buffer);
  return bufferToHex(digest);
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const { sessionId } = await params;

  const resolvedUser = await resolveRequestUser(req);
  const userId = resolvedUser?.user.id ?? "";

  if (!userId) {
    return NextResponse.json(
      { error: "Authentication required" },
      { status: 401 },
    );
  }

  const session = await assertSessionOwnership(sessionId, userId);
  if (!session) {
    return NextResponse.json(
      { error: "session not found for user" },
      { status: 404 },
    );
  }

  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return NextResponse.json(
      { error: "Expected multipart/form-data" },
      { status: 400 },
    );
  }

  const file = formData.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json(
      { error: "file field is required" },
      { status: 400 },
    );
  }

  if (file.size > CHAT_UPLOAD_MAX_BYTES) {
    return NextResponse.json(
      { error: "file exceeds 10 MB limit" },
      { status: 413 },
    );
  }

  const bytes = new Uint8Array(await file.arrayBuffer());

  // Validate PDF magic bytes (%PDF)
  if (
    bytes.length < 4 ||
    bytes[0] !== 0x25 || // %
    bytes[1] !== 0x50 || // P
    bytes[2] !== 0x44 || // D
    bytes[3] !== 0x46    // F
  ) {
    return NextResponse.json(
      { error: "only PDF files are accepted" },
      { status: 415 },
    );
  }

  const fileSha256 = await sha256HexFromBytes(bytes);
  const prefix = fileSha256.slice(0, 2);
  const storagePath = `chat-uploads/${prefix}/${fileSha256}.pdf`;
  const filename = file.name || `attachment-${fileSha256.slice(0, 8)}.pdf`;

  // Dedup: check if blob already uploaded
  const existingBlobs = await supabaseTableRequest<{ file_sha256: string; uploaded_at: string | null }[]>({
    table: "stored_pdf_blobs",
    method: "GET",
    query: {
      file_sha256: `eq.${fileSha256}`,
      select: "file_sha256,uploaded_at",
    },
  });

  const alreadyUploaded =
    Array.isArray(existingBlobs) &&
    existingBlobs.length > 0 &&
    typeof existingBlobs[0].uploaded_at === "string" &&
    existingBlobs[0].uploaded_at.trim().length > 0;

  if (!alreadyUploaded) {
    // Upsert row in stored_pdf_blobs
    await supabaseTableRequest<unknown>({
      table: "stored_pdf_blobs",
      method: "POST",
      query: { on_conflict: "file_sha256" },
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: {
        file_sha256: fileSha256,
        storage_path: storagePath,
        byte_size: bytes.length,
        uploaded_at: null,
      },
    });

    await supabaseStorageUploadObject({
      bucket: CHAT_UPLOAD_BUCKET,
      path: storagePath,
      data: bytes,
      contentType: "application/pdf",
      upsert: true,
    });

    const uploadedAt = new Date().toISOString();
    await supabaseTableRequest<unknown>({
      table: "stored_pdf_blobs",
      method: "PATCH",
      query: {
        file_sha256: `eq.${fileSha256}`,
        uploaded_at: "is.null",
      },
      headers: { Prefer: "return=minimal" },
      body: { uploaded_at: uploadedAt },
    });
  }

  const response = NextResponse.json({
    filename,
    file_sha256: fileSha256,
    storage_path: storagePath,
  });
  if (resolvedUser?.refreshedSession) {
    applyAuthCookies(response, resolvedUser.refreshedSession);
  }
  return response;
}
