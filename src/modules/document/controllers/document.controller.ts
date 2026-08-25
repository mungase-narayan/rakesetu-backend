/**
 * Document controller — upload, list, presigned download, soft delete.
 */
import type { Response } from "express";

import ApiError from "../../../utils/api-error";
import ApiResponse from "../../../utils/api-response";
import env from "../../../config/env.config";
import type { CustomRequest } from "../../../types/common.types";
import { requireTenant } from "../../../middlewares/tenant.middleware";
import {
  actorRole,
  asBoolean,
  asString,
  paginationFrom,
  pathParam,
} from "../../../utils/controller";
import type { DocumentType } from "../../../schema";

import AuditService from "../../audit/services/audit.service";
import DocumentService from "../services/document.service";
import type { IUploadDocumentBody } from "../types/document.types";

class DocumentController {
  constructor(
    private readonly documentService: DocumentService,
    private readonly auditService: AuditService,
  ) {}

  async list(req: CustomRequest, res: Response) {
    const { orgId } = requireTenant(req);

    const data = await this.documentService.list(orgId, {
      ...paginationFrom(req),
      search: asString(req.query.search),
      type: asString(req.query.type) as DocumentType | undefined,
      isCorpus: asBoolean(req.query.isCorpus),
      isActive: asBoolean(req.query.isActive),
    });

    return res
      .status(200)
      .json(new ApiResponse(200, data, "Documents fetched successfully."));
  }

  async upload(req: CustomRequest<IUploadDocumentBody>, res: Response) {
    const { orgId } = requireTenant(req);
    const file = req.file;

    if (!file) {
      throw new ApiError(422, "A file is required on the `file` field");
    }
    if (file.size > env.storage.maxUploadBytes) {
      // multer has already enforced this; the check is here so the limit is
      // stated once in a message a person can act on.
      throw new ApiError(
        413,
        `File exceeds the ${Math.round(env.storage.maxUploadBytes / (1024 * 1024))} MB limit`,
      );
    }

    const body = req.body;
    const created = await this.documentService.upload(orgId, {
      buffer: file.buffer,
      originalName: file.originalname,
      mimeType: file.mimetype,
      sizeBytes: file.size,
      uploadedBy: req.user?.id ?? null,
      meta: {
        type: body.type,
        title: body.title,
        number: body.number ?? null,
        issuedOn: body.issuedOn ?? null,
        effectiveFrom: body.effectiveFrom ?? null,
        // Multipart carries strings; `"true"` is what a form sends.
        isCorpus: body.isCorpus === true || body.isCorpus === "true",
      },
    });

    await this.auditService.record({
      orgId,
      actorId: req.user?.id ?? null,
      actorRole: actorRole(req),
      action: "document.upload",
      entityType: "documents",
      entityId: created.id,
      after: {
        title: created.title,
        type: created.type,
        number: created.number,
        sha256: created.sha256,
        sizeBytes: created.sizeBytes,
        isCorpus: created.isCorpus,
      },
      ip: req.ip,
    });

    return res
      .status(201)
      .json(new ApiResponse(201, created, "Document uploaded successfully."));
  }

  /**
   * Mints a 15-minute URL. The URL is returned and **not** recorded: the audit
   * row says who asked and when, which is the fact worth keeping, while the URL
   * itself is a live credential that an append-only table could never redact.
   */
  async getDownloadUrl(req: CustomRequest, res: Response) {
    const { orgId } = requireTenant(req);
    const id = pathParam(req.params.id);

    const url = await this.documentService.getDownloadUrl(orgId, id);

    await this.auditService.record({
      orgId,
      actorId: req.user?.id ?? null,
      actorRole: actorRole(req),
      action: "document.download",
      entityType: "documents",
      entityId: id,
      ip: req.ip,
    });

    return res
      .status(200)
      .json(
        new ApiResponse(
          200,
          { url, expiresInSeconds: env.storage.downloadUrlTtlSeconds },
          "Download URL generated.",
        ),
      );
  }

  async remove(req: CustomRequest, res: Response) {
    const { orgId } = requireTenant(req);
    const id = pathParam(req.params.id);

    const before = await this.documentService.findById(orgId, id);
    if (!before) throw new ApiError(404, "Document not found");

    const deactivated = await this.documentService.deactivate(orgId, id);

    await this.auditService.record({
      orgId,
      actorId: req.user?.id ?? null,
      actorRole: actorRole(req),
      action: "document.delete",
      entityType: "documents",
      entityId: id,
      before: { title: before.title, isActive: before.isActive },
      after: { title: before.title, isActive: false },
      ip: req.ip,
    });

    return res
      .status(200)
      .json(
        new ApiResponse(
          200,
          deactivated,
          "Document deleted. The stored object is retained.",
        ),
      );
  }
}

export default DocumentController;
