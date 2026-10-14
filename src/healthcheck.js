import { isHealthy } from './health.js';

process.exitCode = isHealthy() ? 0 : 1;
