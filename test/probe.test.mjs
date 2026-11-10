import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const cli = fileURLToPath(new URL('../bin/run-receipt.mjs', import.meta.url));

test('real Godot pass, repeat, assertion failure, script error and stale evidence', () => {
  const trials = fileURLToPath(new URL('../.gt/tests/', import.meta.url));
  mkdirSync(trials, { recursive: true });
  const root = mkdtempSync(join(trials, 'probe-'));
  for (const file of ['gt.json', 'project.godot', 'check.gd']) {
    copyFileSync(new URL(`../fixtures/probe/${file}`, import.meta.url), join(root, file));
  }
  const call = (...args) => spawnSync(process.execPath, [cli, ...args, '--cwd', root], { encoding: 'utf8', timeout: 10000 });
  const first = call('run', 'pass');
  assert.equal(first.status, 0, first.stderr || first.stdout);
  assert.match(first.stdout, /^PASS pass \| 1\/1 checks/);
  const digest = join(root, '.gt', 'probe', 'pass', 'digest.json');
  const firstBytes = readFileSync(digest);
  const second = call('run', 'pass');
  assert.equal(second.status, 0, second.stderr || second.stdout);
  assert.equal(second.stdout, first.stdout);
  assert.deepEqual(readFileSync(digest), firstBytes);
  assert.equal(call('last', 'pass').stdout, first.stdout);

  const broken = call('run', 'broken');
  assert.equal(broken.status, 1);
  assert.match(broken.stdout, /FAIL fixture_contract expected 2, saw 1/);
  assert.match(broken.stdout, /SCRIPT ERROR x1 res:\/\/check\.gd:17/);
  const shown = call('show', 'broken', '--grep', 'SCRIPT ERROR');
  assert.equal(shown.status, 1);
  assert.match(shown.stdout, /^SCRIPT ERROR:/);
  assert.equal(shown.stdout.trimEnd().split('\n').length, 2);

  appendFileSync(join(root, 'check.gd'), '\n# Changed after the result\n');
  const stale = call('last', 'pass');
  assert.equal(stale.status, 3);
  assert.match(stale.stdout, /^STALE pass/);
  assert.equal(call('show', 'broken', '--log').status, 3);

  const configPath = join(root, 'gt.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  config.checks[0].run = [process.execPath, '-e', ''];
  writeFileSync(configPath, JSON.stringify(config));
  const leftOver = call('run', 'pass');
  assert.equal(leftOver.status, 3);
  assert.match(leftOver.stdout, /No newly written result files/);

  config.checks[0].run = config.checks[1].run.slice();
  config.checks[0].run[config.checks[0].run.length - 1] = 'pass';
  writeFileSync(configPath, JSON.stringify(config));
  writeFileSync(join(root, 'compile-broken.gd'), 'extends RefCounted\nvar broken = undefined_fixture_name\n');
  appendFileSync(join(root, 'check.gd'), '\nconst CompileBroken = preload("res://compile-broken.gd")\n');
  const compile = call('run', 'pass', 'broken', '--full');
  assert.equal(compile.status, 1, compile.stderr || compile.stdout);
  assert.match(compile.stdout, /^SCRIPT ERROR x1 res:\/\/compile-broken\.gd:2 Parse Error/);
  assert.equal((compile.stdout.match(/undefined_fixture_name/g) ?? []).length, 1);
  assert.match(compile.stdout, /\+1 script failed to compile because of it/);
  assert.match(compile.stdout, /FAIL pass \| \d+ Godot error groups/);
  assert.doesNotMatch(compile.stdout, /0\/0 checks|Failed to compile depended scripts/);
  assert.equal(call('last', 'pass').status, 1);

  config.checks[0].parser = 'assertions-json';
  config.checks[0].run = [process.execPath, '-e', 'setInterval(() => {}, 1000)'];
  config.checks[0].timeout_s = 0.2;
  writeFileSync(configPath, JSON.stringify(config));
  const timedOut = call('run', 'pass');
  assert.equal(timedOut.status, 2);
  assert.match(timedOut.stdout, /^ERROR pass \| timed out/);

  config.checks[0].run = [process.execPath, '-e',
    'console.error(\'ERROR: Failed to load script "res://check.gd" with error "Parse error".\'); setInterval(() => {}, 1000)',
    '--', '-s', 'check.gd'];
  config.checks[0].timeout_s = 300;
  writeFileSync(configPath, JSON.stringify(config));
  const loadFailed = call('run', 'pass');
  assert.equal(loadFailed.status, 1, loadFailed.error?.message ?? loadFailed.stderr);
  assert.match(loadFailed.stdout, /^FAIL pass \| 1 Godot error group/);
  assert.doesNotMatch(loadFailed.stdout, /timed out|stopped without an exit code/);

  config.checks[0].run[2] = config.checks[0].run[2].replace('check.gd', 'optional.gd')
    .replace('setInterval(() => {}, 1000)', 'setTimeout(() => console.log("finished"), 650)');
  writeFileSync(configPath, JSON.stringify(config));
  assert.equal(call('run', 'pass').status, 1);
  assert.match(call('show', 'pass', '--log').stdout, /finished/);
});
