export { documents, documentTypeEnum, DOCUMENT_TYPES } from "../../schema";
export type {
  Document,
  NewDocument,
  UpdateDocument,
  DocumentType,
} from "../../schema";

export { default as S3Service } from "./services/s3.service";
export { default as DocumentService } from "./services/document.service";
export { default as documentRouter } from "./routes/document.routes";
