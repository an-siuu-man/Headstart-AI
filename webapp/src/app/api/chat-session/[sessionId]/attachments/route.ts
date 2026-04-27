import { NextResponse } from "next/server";
import {
  assertSessionOwnership,
} from "@/lib/chat-repository";
import { applyAuthCookies, resolveRequestUser } from "@/lib/auth/session";
import {
  supabaseStorageUploadObject,
  supabaseTableRequest,
} from "@/lib/supabase-rest";
import type { ChatAttachmentKind } from "@/lib/chat-types";

export const runtime = "nodejs";

const PDF_BUCKET =
  (process.env.SUPABASE_ASSIGNMENT_PDF_BUCKET ?? "assignment-pdfs");
// Falls back to the PDF bucket so no second bucket needs to be provisioned.
const IMAGE_BUCKET =
  (process.env.SUPABASE_ASSIGNMENT_IMAGE_BUCKET ?? PDF_BUCKET);
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

type DetectedKind = {
  kind: ChatAttachmentKind;
  mimeType: string;
  ext: string;
} | null;

function detectKind(bytes: Uint8Array): DetectedKind {
  // PDF: %PDF
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46
  ) {
    return { kind: "pdf", mimeType: "application/pdf", ext: "pdf" };
  }
  // PNG: \x89PNG\r\n\x1a\n
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) {
    return { kind: "image", mimeType: "image/png", ext: "png" };
  }
  // JPEG: \xFF\xD8\xFF
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
  ) {
    return { kind: "image", mimeType: "image/jpeg", ext: "jpg" };
  }
  return null;
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
  const detected = detectKind(bytes);

  if (!detected) {
    return NextResponse.json(
      { error: "only PDF, PNG, and JPEG files are accepted" },
      { status: 415 },
    );
  }

  const { kind, mimeType, ext } = detected;
  const fileSha256 = await sha256HexFromBytes(bytes);
  const prefix = fileSha256.slice(0, 2);

  let storagePath: string;
  let bucket: string;
  let dedupTable: string;

  if (kind === "pdf") {
    storagePath = `chat-uploads/${prefix}/${fileSha256}.pdf`;
    bucket = PDF_BUCKET;
    dedupTable = "stored_pdf_blobs";
  } else {
    storagePath = `chat-uploads/images/${prefix}/${fileSha256}.${ext}`;
    bucket = IMAGE_BUCKET;
    dedupTable = "stored_image_blobs";
  }

  const filename = file.name || `attachment-${fileSha256.slice(0, 8)}.${ext}`;

  // Dedup: check if blob already uploaded
  const existingBlobs = await supabaseTableRequest<{ file_sha256: string; uploaded_at: string | null }[]>({
    table: dedupTable,
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
    const blobBody: Record<string, unknown> = {
      file_sha256: fileSha256,
      storage_path: storagePath,
      byte_size: bytes.length,
      uploaded_at: null,
    };
    if (kind === "image") {
      blobBody.mime_type = mimeType;
    }

    await supabaseTableRequest<unknown>({
      table: dedupTable,
      method: "POST",
      query: { on_conflict: "file_sha256" },
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: blobBody,
    });

    await supabaseStorageUploadObject({
      bucket,
      path: storagePath,
      data: bytes,
      contentType: mimeType,
      upsert: true,
    });

    const uploadedAt = new Date().toISOString();
    await supabaseTableRequest<unknown>({
      table: dedupTable,
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
    kind,
    filename,
    file_sha256: fileSha256,
    storage_path: storagePath,
    mime_type: mimeType,
  });
  if (resolvedUser?.refreshedSession) {
    applyAuthCookies(response, resolvedUser.refreshedSession);
  }
  return response;
}
