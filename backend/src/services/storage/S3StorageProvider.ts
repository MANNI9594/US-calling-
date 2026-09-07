import { randomUUID } from 'crypto';
import path from 'path';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import type { StorageProvider, StoredObjectMeta } from './StorageProvider';

export interface S3StorageConfig {
  bucket: string;
  region: string;
  endpoint?: string; // set for non-AWS S3-compatible providers
  accessKeyId: string;
  secretAccessKey: string;
}

/**
 * Works with AWS S3 and any S3-compatible provider (Cloudflare R2,
 * Backblaze B2, MinIO, DigitalOcean Spaces) via the `endpoint` override.
 * This is the recommended provider for production: unlike local disk it
 * needs no persistent-volume configuration on the host, and survives a
 * container redeploy with zero data-loss risk.
 */
export class S3StorageProvider implements StorageProvider {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(config: S3StorageConfig) {
    this.bucket = config.bucket;
    this.client = new S3Client({
      region: config.region,
      endpoint: config.endpoint,
      forcePathStyle: Boolean(config.endpoint), // required by most non-AWS S3-compatible providers
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });
  }

  async put(key: string, data: Buffer, contentType: string): Promise<StoredObjectMeta> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: data,
        ContentType: contentType,
      }),
    );
    return { key, sizeBytes: data.length, contentType };
  }

  async get(key: string): Promise<Buffer> {
    const result = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    const stream = result.Body as NodeJS.ReadableStream;
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return true;
    } catch {
      return false;
    }
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  buildKey(namespace: Parameters<StorageProvider['buildKey']>[0], filename: string): string {
    const now = new Date();
    const yyyy = now.getUTCFullYear();
    const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
    const ext = path.extname(filename);
    return path.posix.join(namespace, String(yyyy), mm, `${randomUUID()}${ext}`);
  }
}
