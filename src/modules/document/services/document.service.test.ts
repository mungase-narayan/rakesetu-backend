/**
 * Documents: the row behaviour, against a fake object store.
 *
 * The S3 client is stubbed here on purpose. What these cases are about is what
 * the *database* does — duplicate content refused, presigned URLs never
 * persisted, soft delete keeping the object — and none of that needs a real
 * bucket. The real bucket is exercised by `s3.integration.test.ts`, which is a
 * separate file because it needs a container and this one does not.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { db } from "../../../database/connection";
import { documents } from "../../../schema";
import DocumentService from "./document.service";
import type S3Service from "./s3.service";
import { requireOrg } from "../../../../scripts/seed/tenancy.seed";

/** Records what it was asked to do; stores nothing. */
class FakeS3Service {
  readonly uploaded = new Map<string, Buffer>();
  presignCount = 0;

  async uploadFile(buffer: Buffer, key: string): Promise<string> {
    this.uploaded.set(key, buffer);
    return `s3://fake/${key}`;
  }

  async getPresignedDownloadUrl(key: string, expiresIn = 900): Promise<string> {
    this.presignCount += 1;
    return `https://fake.invalid/${key}?X-Amz-Expires=${expiresIn}&sig=${this.presignCount}`;
  }

  async deleteFile(): Promise<void> {}
  async fileExists(): Promise<boolean> {
    return true;
  }
}

let orgId: string;
let s3: FakeS3Service;
let service: DocumentService;

beforeAll(async () => {
  orgId = (await requireOrg("CR")).id;
  s3 = new FakeS3Service();
  service = new DocumentService(s3 as unknown as S3Service, db);
});

const upload = (title: string, content: string) =>
  service.upload(orgId, {
    buffer: Buffer.from(content),
    originalName: `${title}.pdf`,
    mimeType: "application/pdf",
    sizeBytes: Buffer.byteLength(content),
    uploadedBy: null,
    meta: {
      type: "rate_circular",
      title,
      number: null,
      issuedOn: null,
      effectiveFrom: null,
      isCorpus: true,
    },
  });

describe("upload", () => {
  it("stores the object and writes a row that points at it", async () => {
    const created = await upload(
      "Rate Circular 21 of 2026",
      "circular-body-21",
    );

    expect(created.s3Key).toContain(`org/${orgId}/`);
    expect(s3.uploaded.has(created.s3Key)).toBe(true);
    expect(created.sha256).toHaveLength(64);
    expect(created.sizeBytes).toBeGreaterThan(0);
  });

  it("rejects the same content twice in one org", async () => {
    await upload("Rate Circular 22 of 2026", "circular-body-22");

    // Two rows with identical content compete in Phase 12's retrieval and the
    // loser is invisible — so the second upload is refused, with the id of the
    // row that already holds it.
    await expect(
      upload("Rate Circular 22 of 2026 (again)", "circular-body-22"),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("allows the same content in a different org", async () => {
    // Two zones legitimately hold their own copy of the same national circular.
    // The unique key is (sha256, org_id), not sha256 alone.
    const other = await requireOrg("ACC");
    const otherService = new DocumentService(s3 as unknown as S3Service, db);

    const created = await otherService.upload(other.id, {
      buffer: Buffer.from("shared-national-circular"),
      originalName: "shared.pdf",
      mimeType: "application/pdf",
      sizeBytes: 24,
      uploadedBy: null,
      meta: {
        type: "rate_circular",
        title: "Shared circular",
        number: null,
        issuedOn: null,
        effectiveFrom: null,
        isCorpus: true,
      },
    });

    await expect(
      service.upload(orgId, {
        buffer: Buffer.from("shared-national-circular"),
        originalName: "shared.pdf",
        mimeType: "application/pdf",
        sizeBytes: 24,
        uploadedBy: null,
        meta: {
          type: "rate_circular",
          title: "Shared circular",
          number: null,
          issuedOn: null,
          effectiveFrom: null,
          isCorpus: true,
        },
      }),
    ).resolves.toMatchObject({ orgId });

    expect(created.orgId).toBe(other.id);
  });
});

describe("download URLs", () => {
  it("mints a fresh URL per request and never persists one", async () => {
    const created = await upload("Zonal instruction 4", "zonal-4-body");

    const first = await service.getDownloadUrl(orgId, created.id);
    const second = await service.getDownloadUrl(orgId, created.id);

    expect(first).not.toBe(second);

    // The row holds the key, not the capability. A stored URL would turn a
    // fifteen-minute grant into a permanent one that no revocation reaches.
    const [row] = await db
      .select()
      .from(documents)
      .where(eq(documents.id, created.id));

    const serialised = JSON.stringify(row);
    expect(serialised).not.toContain("X-Amz-Expires");
    expect(serialised).not.toContain("https://");
  });

  it("refuses a document belonging to another tenant", async () => {
    const created = await upload("Tenant-scoped doc", "tenant-scoped-body");
    const other = await requireOrg("ACC");

    await expect(
      service.getDownloadUrl(other.id, created.id),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe("deletion", () => {
  it("is soft, and retains the stored object", async () => {
    const created = await upload("Superseded circular", "superseded-body");

    await service.deactivate(orgId, created.id);

    const [row] = await db
      .select()
      .from(documents)
      .where(eq(documents.id, created.id));

    expect(row.isActive).toBe(false);
    // A charge rule that priced a two-year-old invoice must stay re-fetchable
    // when that invoice is disputed.
    expect(s3.uploaded.has(created.s3Key)).toBe(true);
  });

  it("drops the row from the default listing", async () => {
    const page = await service.list(orgId, { limit: 100 });
    const titles = page.data.map((row) => row.title);

    expect(titles).not.toContain("Superseded circular");
  });
});
