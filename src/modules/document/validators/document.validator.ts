/**
 * express-validator chains for the document endpoints.
 *
 * The upload chain validates the multipart *fields*; the file itself is checked
 * in the controller, because multer has already run by then and `req.file` is
 * where the size and mime type live.
 */
import { body, param, query } from "express-validator";

import { DOCUMENT_TYPES } from "../../../schema";

export const listDocumentsValidator = [
  query("search").optional().isString().trim(),
  query("type").optional().isIn(DOCUMENT_TYPES),
  query("isCorpus").optional().isBoolean(),
  query("isActive").optional().isBoolean(),
];

export const uploadDocumentValidator = [
  body("type").isIn(DOCUMENT_TYPES),
  body("title").isString().trim().isLength({ min: 2, max: 300 }),
  body("number")
    .optional({ values: "falsy" })
    .isString()
    .trim()
    .isLength({ max: 120 }),
  body("issuedOn").optional({ values: "falsy" }).isISO8601(),
  body("effectiveFrom").optional({ values: "falsy" }).isISO8601(),
  /**
   * The seam between the corpus and transactional evidence. A wrong `true` here
   * is what would put a customer's waiver photo into Phase 12's retrieval index.
   */
  body("isCorpus").optional().isBoolean(),
];

export const documentIdValidator = [param("id").isUUID()];
