import { promises as fs } from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import type { StorageProvider, StoredObjectMeta } from './StorageProvider';

/**
 * Stores files on local disk under a configured root directory.
 *
 * IMPORTANT for deployment: this requires the root directory to be a
 * PERSISTENT volume. On most container hosts (Railway, Render, Fly.io) the
 * container filesystem is ephemeral by default — you must explicitly attach
 * a persistent volume and point STORAGE_LOCAL_PATH at it, or use the S3
 * provider instead. See docs/DEPLOYMENT.md.
 */
export class LocalStorageProvider implements StorageProvider {
  constructor(private readonly rootDir: string) {}

  private resolvePath(key: string): string {
    const resolved = path.resolve(this.rootDir, key);
    // Defense against path traversal via a malicious/malformed key.
    if (!resolved.startsWith(path.resolve(this.rootDir))) {
      throw new Error(`Refusing to resolve storage key outside root: ${key}`);
    }
    return resolved;
  }

  async put(key: string, data: Buffer, contentType: string): Promise<StoredObjectMeta> {
    const fullPath = this.resolvePath(key);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, data);
    return { key, sizeBytes: data.length, contentType };
  }

  async get(key: string): Promise<Buffer> {
    return fs.readFile(this.resolvePath(key));
  }

  async exists(key: string): Promise<boolean> {
    try {
      await fs.access(this.resolvePath(key));
      return true;
    } catch {
      return false;
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await fs.unlink(this.resolvePath(key));
    } catch (err) {
      const nodeErr = err as NodeJS.ErrnoException;
      if (nodeErr.code !== 'ENOENT') throw err;
    }
  }

  buildKey(namespace: Parameters<StorageProvider['buildKey']>[0], filename: string): string {
    const now = new Date();
    const yyyy = now.getUTCFullYear();
    const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
    const ext = path.extname(filename);
    return path.posix.join(namespace, String(yyyy), mm, `${randomUUID()}${ext}`);
  }
}
