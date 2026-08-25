/**
 * documents — the object-store index (DESIGN.md §4.7, §8).
 *
 * Moved forward from the RAG phase, because three earlier phases need to point
 * at a document before any of it is chunked or embedded:
 * `consignments.forwarding_note_doc_id` (Phase 6),
 * `exemption_claims.evidence_doc_ids[]` (Phase 10) and
 * `ai_extractions.source_doc_id` (Phase 11). Only `document_chunks` stays in
 * Phase 12.
 *
 * The row is the index; the bytes live in S3/MinIO under `s3_key`. **No
 * presigned URL is ever stored here.** A URL is a 15-minute capability, and
 * persisting one turns a short-lived grant into a permanent, shareable one that
 * outlives whatever authorisation produced it.
 */
import {
  boolean,
  date,
  index,
  integer,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

import { users } from "./user.schema";
import { organizations } from "./organization.schema";
import { documentTypeEnum } from "./enums.schema";

export const documents = pgTable(
  "documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** `restrict` — deleting a tenant must not orphan objects that still exist in the bucket. */
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    type: documentTypeEnum("type").notNull(),
    title: varchar("title", { length: 300 }).notNull(),
    /** "Rate Circular 14 of 2024" — how a human cites it. */
    number: varchar("number", { length: 120 }),
    issuedOn: date("issued_on"),
    effectiveFrom: date("effective_from"),
    /**
     * Self-reference: circular 14 of 2026 supersedes circular 9 of 2024. Filled
     * in by an admin confirming Phase 12's suggestion, never by the ingest
     * pipeline on its own — "this document replaces that one" is a legal claim.
     */
    supersededById: uuid("superseded_by_id").references(
      (): AnyPgColumn => documents.id,
      { onDelete: "set null" },
    ),
    supersededAt: date("superseded_at"),

    s3Key: varchar("s3_key", { length: 500 }).notNull(),
    mimeType: varchar("mime_type", { length: 100 }).notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    /**
     * Content hash. §6.4 re-embeds only on change, and this is how "unchanged"
     * is decided — re-uploading the same PDF must not spend a second embedding
     * pass, nor create a second row competing with the first in retrieval.
     */
    sha256: varchar("sha256", { length: 64 }).notNull(),
    pageCount: integer("page_count"),

    /**
     * **The seam that lets one table do two jobs.** True → Phase 12 chunks and
     * embeds it into the RAG corpus. False → it is transactional evidence (a
     * forwarding note, a waiver photo) that must never end up as an answer to
     * somebody's question about tariff policy.
     */
    isCorpus: boolean("is_corpus").notNull().default(false),

    /** `set null`: a departed uploader must not block deleting their account. */
    uploadedBy: uuid("uploaded_by").references(() => users.id, {
      onDelete: "set null",
    }),
    /**
     * Soft delete. The row goes, the S3 object stays — a document referenced by
     * a charge rule that priced a two-year-old invoice has to remain
     * re-fetchable when that invoice is disputed.
     */
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("documents_org_id_type_idx").on(table.orgId, table.type),
    index("documents_number_idx").on(table.number),
    /**
     * Scoped to the org, not global: two zones legitimately hold their own copy
     * of the same national circular, and deduplicating across tenants would let
     * one tenant's upload be silently rejected because of a file it cannot see.
     */
    uniqueIndex("documents_sha256_org_id_key").on(table.sha256, table.orgId),
  ],
);

export type Document = typeof documents.$inferSelect;
export type NewDocument = typeof documents.$inferInsert;
export type UpdateDocument = Partial<NewDocument>;
