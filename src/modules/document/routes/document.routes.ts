/**
 * Document routes — `/api/v1/documents`.
 *
 * `multer.memoryStorage()` sits between `verifyJWT` and the validator, exactly
 * as the College-Level file-storage module does. Memory rather than disk
 * because the buffer is hashed and forwarded to S3 in one pass — a temp file
 * would be a second copy on a disk nobody cleans up, and the 50 MB cap is what
 * makes holding it in memory reasonable.
 */
import { Router } from "express";
import multer from "multer";

import env from "../../../config/env.config";
import logger from "../../../logger/winston.logger";
import asyncHandler from "../../../utils/async-handler";
import validateMiddleware from "../../../middlewares/validate.middleware";
import { verifyJWT } from "../../../middlewares/auth.middleware";
import { withTenant } from "../../../middlewares/tenant.middleware";
import { requirePermission } from "../../../middlewares/permission.middleware";

import AuditService from "../../audit/services/audit.service";
import S3Service from "../services/s3.service";
import DocumentService from "../services/document.service";
import DocumentController from "../controllers/document.controller";
import {
  documentIdValidator,
  listDocumentsValidator,
  uploadDocumentValidator,
} from "../validators/document.validator";

const documentRouter: Router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.storage.maxUploadBytes },
});

const controller = new DocumentController(
  new DocumentService(new S3Service()),
  new AuditService(logger),
);

const readGuards = [
  verifyJWT,
  requirePermission("masterdata:read"),
  withTenant,
];
const writeGuards = [
  verifyJWT,
  requirePermission("masterdata:write"),
  withTenant,
];

documentRouter.get(
  "/",
  ...readGuards,
  listDocumentsValidator,
  validateMiddleware,
  asyncHandler((req, res) => controller.list(req, res)),
);

documentRouter.post(
  "/upload",
  ...writeGuards,
  upload.single("file"),
  uploadDocumentValidator,
  validateMiddleware,
  asyncHandler((req, res) => controller.upload(req, res)),
);

documentRouter.get(
  "/:id/download-url",
  ...readGuards,
  documentIdValidator,
  validateMiddleware,
  asyncHandler((req, res) => controller.getDownloadUrl(req, res)),
);

documentRouter.delete(
  "/:id",
  ...writeGuards,
  documentIdValidator,
  validateMiddleware,
  asyncHandler((req, res) => controller.remove(req, res)),
);

export default documentRouter;
