import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const WORKER_DIR = dirname(fileURLToPath(import.meta.url));
export const WORKER_LOG = join(WORKER_DIR, 'worker.log');
