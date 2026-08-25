/**
 * Object storage — S3 in a deployed environment, MinIO in development.
 *
 * Mirrors `college-level-backend/src/modules/file-storage/services/s3.service.ts`
 * with two additions this project needs:
 *
 *  - **an endpoint override**, so one client serves both AWS and the MinIO in
 *    `docker compose`. Local development therefore exercises the real upload,
 *    the real presigned URL and the real expiry, instead of a filesystem stub
 *    that proves none of them.
 *  - **a 15-minute default on download URLs** (§8). The value lives in config,
 *    but the default is short on purpose: a presigned URL is a bearer token for
 *    the object, and it is never persisted — see `documents`.
 */
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

import env from "../../../config/env.config";

/**
 * Everything the client needs, so a test can point one at its own container.
 *
 * The override exists for exactly one reason worth having it: the presigned-URL
 * *expiry* is only provable against a real S3 implementation, and a suite that
 * spins up its own MinIO cannot be reading the developer's `.env` to find it.
 */
export interface S3ServiceConfig {
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  privateBucket: string;
  publicBucket: string;
  endpoint: string;
  forcePathStyle: boolean;
}

class S3Service {
  private readonly client: S3Client;
  private readonly privateBucket: string;
  private readonly publicBucket: string;
  private readonly endpoint: string;
  private readonly region: string;

  constructor(config?: Partial<S3ServiceConfig>) {
    const resolved: S3ServiceConfig = {
      region: config?.region ?? env.storage.region,
      accessKeyId: config?.accessKeyId ?? env.storage.accessKeyId,
      secretAccessKey: config?.secretAccessKey ?? env.storage.secretAccessKey,
      privateBucket: config?.privateBucket ?? env.storage.privateBucket,
      publicBucket: config?.publicBucket ?? env.storage.publicBucket,
      endpoint: config?.endpoint ?? env.storage.endpoint,
      forcePathStyle: config?.forcePathStyle ?? env.storage.forcePathStyle,
    };

    this.client = new S3Client({
      region: resolved.region,
      credentials: {
        accessKeyId: resolved.accessKeyId,
        secretAccessKey: resolved.secretAccessKey,
      },
      // Absent against real AWS, which is what selects its own hostnames and
      // virtual-host addressing.
      ...(resolved.endpoint ? { endpoint: resolved.endpoint } : {}),
      forcePathStyle: resolved.forcePathStyle,
    });
    this.privateBucket = resolved.privateBucket;
    this.publicBucket = resolved.publicBucket;
    this.endpoint = resolved.endpoint;
    this.region = resolved.region;
  }

  /** The underlying client, for a caller that must send a command of its own. */
  getClient(): S3Client {
    return this.client;
  }

  private resolveBucket(isPublic: boolean): string {
    return isPublic ? this.publicBucket : this.privateBucket;
  }

  async uploadFile(
    buffer: Buffer,
    key: string,
    contentType: string,
    isPublic = false,
  ): Promise<string> {
    const bucket = this.resolveBucket(isPublic);

    await this.client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: buffer,
        ContentType: contentType,
      }),
    );

    // An `s3://` URI for private objects, deliberately: it is not fetchable, so
    // it cannot be mistaken for a link and pasted somewhere.
    return isPublic ? this.getPublicUrl(key) : `s3://${bucket}/${key}`;
  }

  async deleteFile(key: string, isPublic = false): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({
        Bucket: this.resolveBucket(isPublic),
        Key: key,
      }),
    );
  }

  /**
   * A short-lived capability to read one object.
   *
   * **Never store the return value.** It is a credential; persisting it turns a
   * fifteen-minute grant into a permanent one that outlives whatever
   * authorisation produced it, and no revocation reaches it.
   */
  async getPresignedDownloadUrl(
    key: string,
    expiresIn: number = env.storage.downloadUrlTtlSeconds,
  ): Promise<string> {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.privateBucket, Key: key }),
      { expiresIn },
    );
  }

  async getPresignedUploadUrl(
    key: string,
    contentType: string,
    expiresIn: number = env.storage.downloadUrlTtlSeconds,
    isPublic = false,
  ): Promise<string> {
    return getSignedUrl(
      this.client,
      new PutObjectCommand({
        Bucket: this.resolveBucket(isPublic),
        Key: key,
        ContentType: contentType,
      }),
      { expiresIn },
    );
  }

  async fileExists(key: string, isPublic = false): Promise<boolean> {
    try {
      await this.client.send(
        new HeadObjectCommand({
          Bucket: this.resolveBucket(isPublic),
          Key: key,
        }),
      );
      return true;
    } catch {
      return false;
    }
  }

  getBucketName(isPublic = false): string {
    return this.resolveBucket(isPublic);
  }

  getPublicUrl(key: string): string {
    if (this.endpoint) {
      return `${this.endpoint}/${this.publicBucket}/${key}`;
    }
    return `https://${this.publicBucket}.s3.${this.region}.amazonaws.com/${key}`;
  }
}

export default S3Service;
