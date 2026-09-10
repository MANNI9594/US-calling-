/**
 * Storage abstraction. Every place in the app that needs to persist a file
 * (original uploaded Master workbook, original US Calling List, extracted
 * vessel evidence images, generated export XLSX, backups) goes through this
 * interface — never `fs` directly, never a specific cloud SDK directly.
 *
 * This is what makes deployment provider-independent: swapping from local
 * disk (e.g. a Railway/Render persistent volume) to S3-compatible object
 * storage (S3 itself, Cloudflare R2, Backblaze B2, MinIO) is a config change
 * (STORAGE_PROVIDER=s3 + credentials), not a code change.
 */
export interface StoredObjectMeta {
  key: string;
  sizeBytes: number;
  contentType: string;
}

export interface StorageProvider {
  /** Persists a buffer under `key` and returns metadata. Overwrites if key exists. */
  put(key: string, data: Buffer, contentType: string): Promise<StoredObjectMeta>;

  /** Retrieves the full contents of an object. Throws if not found. */
  get(key: string): Promise<Buffer>;

  /** Returns true if an object exists at `key`. */
  exists(key: string): Promise<boolean>;

  /** Deletes an object. Safe to call on a non-existent key (no-op). */
  delete(key: string): Promise<void>;

  /**
   * Generates a namespaced key. Callers should always build keys through
   * this rather than string-concatenating, so the layout stays consistent
   * across providers (e.g. "evidence/2026/09/<uuid>.png").
   */
  buildKey(namespace: 'master-imports' | 'us-calling-uploads' | 'evidence' | 'exports' | 'backups' | 'documents', filename: string): string;
}
