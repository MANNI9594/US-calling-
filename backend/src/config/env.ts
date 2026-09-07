import { z } from 'zod';
import 'dotenv/config';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(4000),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

  // Session/auth
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters'),
  SESSION_TTL_HOURS: z.coerce.number().default(24 * 7),
  COOKIE_SECURE: z
    .string()
    .default('true')
    .transform((v) => v === 'true'),

  // CORS — the single origin the frontend is served from
  CORS_ORIGIN: z.string().min(1, 'CORS_ORIGIN is required'),

  // Storage provider — see src/services/storage
  STORAGE_PROVIDER: z.enum(['local', 's3']).default('local'),
  STORAGE_LOCAL_PATH: z.string().default('./storage'),
  STORAGE_S3_BUCKET: z.string().optional(),
  STORAGE_S3_REGION: z.string().optional(),
  STORAGE_S3_ENDPOINT: z.string().optional(), // set for S3-compatible providers (R2, MinIO, Backblaze B2, etc.)
  STORAGE_S3_ACCESS_KEY_ID: z.string().optional(),
  STORAGE_S3_SECRET_ACCESS_KEY: z.string().optional(),

  MAX_UPLOAD_SIZE_MB: z.coerce.number().default(50),
});

export type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    // eslint-disable-next-line no-console
    console.error('Invalid environment configuration:');
    for (const issue of parsed.error.issues) {
      // eslint-disable-next-line no-console
      console.error(`  - ${issue.path.join('.')}: ${issue.message}`);
    }
    process.exit(1);
  }

  if (parsed.data.STORAGE_PROVIDER === 's3') {
    const required: Array<keyof Env> = [
      'STORAGE_S3_BUCKET',
      'STORAGE_S3_REGION',
      'STORAGE_S3_ACCESS_KEY_ID',
      'STORAGE_S3_SECRET_ACCESS_KEY',
    ];
    const missing = required.filter((key) => !parsed.data[key]);
    if (missing.length > 0) {
      // eslint-disable-next-line no-console
      console.error(`STORAGE_PROVIDER=s3 requires: ${missing.join(', ')}`);
      process.exit(1);
    }
  }

  return parsed.data;
}

export const env = loadEnv();
