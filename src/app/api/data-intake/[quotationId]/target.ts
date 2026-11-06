import { NextResponse } from "next/server";
import type { AuthenticatedUser } from "@/lib/api-auth";
import { canActForQuoteOwner } from "@/lib/quotation-access";
import {
  getFilmOrderForInternalIntakeUpload,
  type InternalCustomerDesignIntakeTarget,
} from "@/lib/film-orders";
import type { FilmOrderFileRecord } from "@/lib/film-order-shared";

export type Context = { params: Promise<{ quotationId: string }> };

export async function loadAuthorizedIntakeTarget(
  user: AuthenticatedUser,
  quotationId: number,
): Promise<{ response?: NextResponse; target?: InternalCustomerDesignIntakeTarget }> {
  if (!Number.isInteger(quotationId) || quotationId <= 0) {
    return { response: NextResponse.json({ error: "invalid_quotation_id" }, { status: 400 }) };
  }
  const target = await getFilmOrderForInternalIntakeUpload(quotationId);
  if (!target) return { response: NextResponse.json({ error: "film_order_not_found" }, { status: 404 }) };
  if (!canActForQuoteOwner(user.email, target.ownerDomain)) {
    return { response: NextResponse.json({ error: "intake_upload_forbidden" }, { status: 403 }) };
  }
  return { target };
}

export function customerDesignSummary(
  target: InternalCustomerDesignIntakeTarget,
  order = target.order,
) {
  return {
    quotationId: target.quotationId,
    quotationNumber: target.quotationNumber,
    ownerDomain: target.ownerDomain,
    order: {
      id: order.id,
      orderNumber: order.order_number,
      designStatus: order.customerDesign.status,
    },
    files: order.files
      .filter((file: FilmOrderFileRecord) => file.category === "customer_design")
      .map((file) => ({
        id: file.id,
        fileName: file.file_name,
        version: file.version,
        sizeBytes: file.file_size_bytes,
        contentType: file.content_type,
        checksum: file.checksum,
        checksumAlgorithm: file.checksum_algorithm,
        driveFileId: file.drive_file_id,
        uploadedVia: file.uploaded_via,
        uploadedAt: file.created_at,
      })),
  };
}

export function intakeUploadErrorStatus(message: string): number {
  if (message === "invalid_status_transition" || message === "ai_file_required") return 409;
  if (message === "file_too_large") return 413;
  if (message === "uploaded_file_not_found") return 404;
  if (message === "ambiguous_uploaded_file") return 409;
  if (
    message === "invalid_file_name"
    || message === "unsupported_file_type"
    || message === "invalid_upload_request"
    || message === "upload_guide_acknowledgement_required"
    || message === "uploaded_file_mismatch"
  ) return 400;
  return 502;
}
