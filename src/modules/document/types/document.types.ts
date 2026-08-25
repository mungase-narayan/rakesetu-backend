/**
 * Document module type contracts.
 */
import type { Document, DocumentType, NewDocument } from "../../../schema";
import type { PaginateOptions } from "../../../types/pagination.types";

export type { Document, NewDocument, DocumentType };

export interface IListDocumentsQuery extends Partial<PaginateOptions> {
  search?: string;
  type?: DocumentType;
  isCorpus?: boolean;
  isActive?: boolean;
}

/** The multipart fields that accompany the file itself. */
export interface IUploadDocumentBody {
  type: DocumentType;
  title: string;
  number?: string;
  issuedOn?: string;
  effectiveFrom?: string;
  isCorpus?: boolean | string;
}
