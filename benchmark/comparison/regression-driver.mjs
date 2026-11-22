import { pathToFileURL } from 'node:url';

const file = process.argv[2];
if (!file) {
  console.error('usage: regression-driver.mjs <test.mjs>');
  process.exit(64);
}
const mod = await import(pathToFileURL(file).href);
if (typeof mod.default !== 'function') throw new TypeError('The retained test must export a default async function.');
await mod.default({
  web: process.env.BENCH_TEST_WEB,
  api: process.env.BENCH_TEST_API,
  email: process.env.DEMO_EMAIL,
  password: process.env.DEMO_PASSWORD,
});
