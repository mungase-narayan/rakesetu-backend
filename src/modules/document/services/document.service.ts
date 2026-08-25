/**
 * documents — the index over the object store.
 *
 * Tenant-scoped: a document belongs to the organization that uploaded it, and
 * `ScopedRepository` is what stops one zone's admin listing another's evidence.
 *
 * Two behaviours here are worth stating outright, because both are the kind of
 * thing a later phase would otherwise re-decide:
 *
 *  - **Duplicate uploads are rejected, not silently re-stored.** The unique key
 *    is `(sha256, org_id)`. Re-uploading the same PDF returns 409 with the id of
 *    the row that already holds it — because in Phase 12 two rows with identical
 *    content compete in retrieval, and the loser is invisible.
 *  - **Deletion is soft and the object stays.** A charge rule that priced a
 *    two-year-old invoice must remain re-fetchable when that invoice is
 *    disputed, and an S3 object costs almost nothing to keep.
 */
import { createHash } from "node:crypto";
import { and, desc, eq, ilike, or, type SQL } from "drizzle-orm";

import { documents, type Document } from "../../../schema";
import ApiError from "../../../utils/api-error";
import { db, type DB } from "../../../database/connection";
import {
  ScopedRepository,
  type ScopedInsert,
} from "../../../database/scoped-repository";
import type { IListDocumentsQuery } from "../types/document.types";
import S3Service from "./s3.service";

export interface UploadInput {
  buffer: Buffer;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  uploadedBy: string | null;
  meta: Omit<
    ScopedInsert<typeof documents>,
    "s3Key" | "mimeType" | "sizeBytes" | "sha256" | "uploadedBy"
  >;
}

class DocumentService {
  constructor(
    private readonly s3Service: S3Service = new S3Service(),
    private readonly database: DB = db,
  ) {}

  private repo(orgId: string) {
    return new ScopedRepository(documents, orgId, this.database);
  }

  async list(orgId: string, query: IListDocumentsQuery = {}) {
    return this.repo(orgId).paginate(
      {
        ...query,
        sort: query.sort ?? "createdAt",
        order: query.order ?? "desc",
      },
      this.filters(query),
    );
  }

  async findById(orgId: string, id: string): Promise<Document | null> {
    return this.repo(orgId).findById(id);
  }

  /**
   * Hashes, stores the object, then writes the row — in that order.
   *
   * The order matters on failure. An object with no row is orphaned storage,
   * which a sweep can find and remove; a row with no object is a document the
   * product believes it has and cannot produce, which is discovered by a user.
   */
  async upload(orgId: string, input: UploadInput): Promise<Document> {
    const sha256 = createHash("sha256").update(input.buffer).digest("hex");

    const existing = await this.repo(orgId).selectOne(
      eq(documents.sha256, sha256),
    );
    if (existing) {
      throw new ApiError(
        409,
        `This file is already stored as "${existing.title}" (${existing.id})`,
      );
    }

    const key = this.buildKey(orgId, sha256, input.originalName);
    await this.s3Service.uploadFile(input.buffer, key, input.mimeType);

    return this.repo(orgId).insert({
      ...input.meta,
      s3Key: key,
      mimeType: input.mimeType,
      sizeBytes: input.sizeBytes,
      sha256,
      uploadedBy: input.uploadedBy,
    });
  }

  /**
   * A 15-minute URL, generated per request and **never persisted**. The row
   * holds `s3_key`; the capability to read it is minted on demand for whoever
   * has just proved they may.
   */
  async getDownloadUrl(orgId: string, id: string): Promise<string> {
    const document = await this.findById(orgId, id);
    if (!document) throw new ApiError(404, "Document not found");
    return this.s3Service.getPresignedDownloadUrl(document.s3Key);
  }

  /** Soft delete. The S3 object is deliberately retained — see the file header. */
  async deactivate(orgId: string, id: string): Promise<Document | null> {
    return this.repo(orgId).update(id, { isActive: false });
  }

  async update(
    orgId: string,
    id: string,
    values: Partial<ScopedInsert<typeof documents>>,
  ): Promise<Document | null> {
    return this.repo(orgId).update(id, values);
  }

  /** Corpus documents, for Phase 12's ingest to walk. */
  async listCorpus(orgId: string): Promise<Document[]> {
    return this.repo(orgId).select(
      and(eq(documents.isCorpus, true), eq(documents.isActive, true)) as SQL,
      desc(documents.createdAt),
    );
  }

  /**
   * `org/<orgId>/<sha-prefix>/<safe-name>`.
   *
   * Content-addressed by prefix so the same file uploaded twice would land on
   * the same key, and namespaced by org so a bucket listing does not mix
   * tenants. The original name is kept — mangled to be key-safe — because
   * "which file is this" is otherwise unanswerable from the bucket alone.
   */
  private buildKey(
    orgId: string,
    sha256: string,
    originalName: string,
  ): string {
    const safeName = originalName
      .toLowerCase()
      .replace(/[^a-z0-9.\-_]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 120);
    return `org/${orgId}/${sha256.slice(0, 8)}/${safeName || "document"}`;
  }

  private filters(query: IListDocumentsQuery): SQL | undefined {
    const conditions: SQL[] = [];

    if (query.search) {
      const pattern = `%${query.search}%`;
      conditions.push(
        or(
          ilike(documents.title, pattern),
          ilike(documents.number, pattern),
        ) as SQL,
      );
    }
    if (query.type) conditions.push(eq(documents.type, query.type));
    if (query.isCorpus !== undefined) {
      conditions.push(eq(documents.isCorpus, query.isCorpus));
    }
    // Defaults to active-only: a soft-deleted document is gone as far as every
    // screen is concerned, and `?isActive=false` is how an admin finds it again.
    conditions.push(eq(documents.isActive, query.isActive ?? true));

    return conditions.length === 1 ? conditions[0] : and(...conditions);
  }
}

export default DocumentService;
