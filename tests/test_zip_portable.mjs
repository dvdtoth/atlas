import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(execFile);
const root = new URL('../', import.meta.url);

test('Safari ZIP reads use portable streams without changing browser globals', async () => {
  const { stdout } = await run(process.execPath, ['tests/fixtures/zip-native-guard.mjs'], {
    cwd: root,
    env: Object.fromEntries(
      Object.entries(process.env).filter(([key]) => key !== 'NODE_TEST_CONTEXT'),
    ),
  });
  assert.match(stdout, /portable ZIP passed/);
});

test('portable ZIP engine preserves the complete native import and range-cache contract', async () => {
  const { stdout } = await run(
    process.execPath,
    [
      '--import',
      './tests/fixtures/safari-environment.mjs',
      '--test',
      '--test-reporter=tap',
      'tests/test_zip_import.mjs',
      'tests/test_zip_reader.mjs',
    ],
    {
      cwd: root,
      env: Object.fromEntries(
        Object.entries(process.env).filter(([key]) => key !== 'NODE_TEST_CONTEXT'),
      ),
    },
  );
  assert.match(stdout, /# fail 0/);
});

test('Chromium retains native ZIP streams and exact source import', async () => {
  const { stdout } = await run(
    process.execPath,
    ['tests/fixtures/zip-native-guard.mjs', '--chromium'],
    { cwd: root },
  );
  assert.match(stdout, /native ZIP passed/);
});
