import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { REPO } from '../benchmark/comparison/lib.mjs';

test('the standalone regression driver passes context and preserves assertion failures', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'sh-regression-driver-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const driver = path.join(REPO, 'benchmark', 'comparison', 'regression-driver.mjs');
  const file = path.join(dir, 'test.mjs');
  const env = { ...process.env, BENCH_TEST_WEB: 'http://web', BENCH_TEST_API: 'http://api/api', DEMO_EMAIL: 'demo@example.com', DEMO_PASSWORD: 'secret' };
  writeFileSync(file, `import assert from 'node:assert/strict'; export default async function (x) { assert.deepEqual(x, { web: 'http://web', api: 'http://api/api', email: 'demo@example.com', password: 'secret' }); }`);
  const pass = spawnSync(process.execPath, [driver, file], { encoding: 'utf8', env });
  assert.equal(pass.status, 0, pass.stderr);

  writeFileSync(file, `import assert from 'node:assert/strict'; export default async function () { assert.equal('buggy', 'correct'); }`);
  const fail = spawnSync(process.execPath, [driver, file], { encoding: 'utf8', env });
  assert.equal(fail.status, 1);
  assert.match(fail.stderr, /ERR_ASSERTION/);

  writeFileSync(file, 'export default async function () { throw new Error("browser crashed"); }');
  const crash = spawnSync(process.execPath, [driver, file], { encoding: 'utf8', env });
  assert.equal(crash.status, 1);
  assert.match(crash.stderr, /browser crashed/);
});
