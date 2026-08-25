/**
 * The object store, against a **real MinIO** in a container.
 *
 * This is the one suite that cannot use a stub. What it proves — that a
 * presigned URL grants access, and that the *same* URL stops working when its
 * clock runs out — is a property of the S3 signature algorithm, not of our
 * code, and a fake would only prove that the fake agrees with itself. §8 rests
 * the whole private-document story on short-lived URLs, so it is worth a
 * container.
 *
 * `document.service.test.ts` covers the row behaviour with a stub, because none
 * of that needs a bucket.
 */
import { setTimeout as sleep } from "node:timers/promises";
import { CreateBucketCommand } from "@aws-sdk/client-s3";
import { GenericContainer, type StartedTestContainer } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import S3Service from "./s3.service";

const BUCKET = "rakesetu-test";
const CREDENTIALS = {
  accessKeyId: "minioadmin",
  secretAccessKey: "minioadmin",
};

let container: StartedTestContainer;
let s3: S3Service;

beforeAll(async () => {
  container = await new GenericContainer("minio/minio:latest")
    .withCommand(["server", "/data"])
    .withEnvironment({
      MINIO_ROOT_USER: CREDENTIALS.accessKeyId,
      MINIO_ROOT_PASSWORD: CREDENTIALS.secretAccessKey,
    })
    .withExposedPorts(9000)
    .start();

  const endpoint = `http://${container.getHost()}:${container.getMappedPort(9000)}`;

  s3 = new S3Service({
    ...CREDENTIALS,
    region: "ap-south-1",
    privateBucket: BUCKET,
    publicBucket: `${BUCKET}-public`,
    endpoint,
    // MinIO only understands path-style addressing.
    forcePathStyle: true,
  });

  await s3.getClient().send(new CreateBucketCommand({ Bucket: BUCKET }));
}, 240_000);

afterAll(async () => {
  await container?.stop();
});

describe("uploadFile", () => {
  it("stores an object and reports it exists", async () => {
    await s3.uploadFile(
      Buffer.from("circular body"),
      "org/test/aa/circular.pdf",
      "application/pdf",
    );

    await expect(s3.fileExists("org/test/aa/circular.pdf")).resolves.toBe(true);
    await expect(s3.fileExists("org/test/aa/missing.pdf")).resolves.toBe(false);
  });

  it("returns an s3:// URI for a private object, not a fetchable link", async () => {
    const uri = await s3.uploadFile(
      Buffer.from("private body"),
      "org/test/bb/private.pdf",
      "application/pdf",
    );

    // Deliberately not a URL: it cannot be mistaken for a link and pasted
    // somewhere, which is the failure mode a private object has to survive.
    expect(uri).toMatch(/^s3:\/\//);
    expect(uri).not.toMatch(/^https?:/);
  });
});

describe("presigned download URLs", () => {
  const key = "org/test/cc/expiring.pdf";

  beforeAll(async () => {
    await s3.uploadFile(Buffer.from("expiring body"), key, "application/pdf");
  });

  it("grants access while it is live", async () => {
    const url = await s3.getPresignedDownloadUrl(key, 300);
    const response = await fetch(url);

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("expiring body");
  });

  it("stops working once it expires", async () => {
    // One second, then wait it out. This is the assertion the whole suite is
    // for: §8 promises a *short-lived* capability, and "short-lived" is only a
    // promise if the URL actually dies.
    const url = await s3.getPresignedDownloadUrl(key, 1);
    await expect(fetch(url).then((r) => r.status)).resolves.toBe(200);

    await sleep(2_000);

    const expired = await fetch(url);
    expect(expired.status).toBe(403);
  });

  it("mints a different URL each time", async () => {
    const first = await s3.getPresignedDownloadUrl(key, 300);
    await sleep(1_100);
    const second = await s3.getPresignedDownloadUrl(key, 300);

    // Signed over a timestamp, so two URLs for one object differ. A cached URL
    // is therefore never "the" URL — which is why nothing caches one.
    expect(first).not.toBe(second);
  });

  it("refuses a tampered signature", async () => {
    const url = await s3.getPresignedDownloadUrl(key, 300);
    const tampered = url.replace(/X-Amz-Signature=[0-9a-f]+/, (match) =>
      match.slice(0, -1).concat(match.endsWith("0") ? "1" : "0"),
    );

    const response = await fetch(tampered);
    expect(response.status).toBe(403);
  });
});

describe("deleteFile", () => {
  it("removes the object", async () => {
    const key = "org/test/dd/temporary.pdf";
    await s3.uploadFile(Buffer.from("temp"), key, "application/pdf");
    await expect(s3.fileExists(key)).resolves.toBe(true);

    await s3.deleteFile(key);

    await expect(s3.fileExists(key)).resolves.toBe(false);
  });
});
