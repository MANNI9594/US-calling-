import { createApp, logger } from './app';
import { env } from './config/env';
import { prisma } from './db/prisma';

async function main() {
  await prisma.$connect();
  logger.info('Database connected');

  const app = createApp();
  app.listen(env.PORT, () => {
    logger.info(`US Calling Master Manager API listening on port ${env.PORT} (${env.NODE_ENV})`);
  });
}

main().catch((err) => {
  logger.error({ err }, 'Fatal startup error');
  process.exit(1);
});

process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, closing database connections');
  await prisma.$disconnect();
  process.exit(0);
});
