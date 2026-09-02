#!/usr/bin/env node

import {
  validateExternalHealthConfig,
  waitForExternalRevision,
} from "../lib/external-health.mjs";

try {
  const config = validateExternalHealthConfig({
    baseUrl: process.env.POC_BASE_URL,
    revision: process.env.APP_REVISION,
  });
  await waitForExternalRevision({
    ...config,
    timeoutMs: 10 * 60 * 1_000,
    intervalMs: 5_000,
  });
  console.log(`External POC revision ${config.revision} is ready`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
