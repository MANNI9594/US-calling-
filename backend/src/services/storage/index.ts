import path from 'path';
import { env } from '../../config/env';
import type { StorageProvider } from './StorageProvider';
import { LocalStorageProvider } from './LocalStorageProvider';
import { S3StorageProvider } from './S3StorageProvider';

function buildStorageProvider(): StorageProvider {
  if (env.STORAGE_PROVIDER === 's3') {
    return new S3StorageProvider({
      bucket: env.STORAGE_S3_BUCKET as string,
      region: env.STORAGE_S3_REGION as string,
      endpoint: env.STORAGE_S3_ENDPOINT,
      accessKeyId: env.STORAGE_S3_ACCESS_KEY_ID as string,
      secretAccessKey: env.STORAGE_S3_SECRET_ACCESS_KEY as string,
    });
  }
  return new LocalStorageProvider(path.resolve(env.STORAGE_LOCAL_PATH));
}

export const storage: StorageProvider = buildStorageProvider();
export type { StorageProvider, StoredObjectMeta } from './StorageProvider';
