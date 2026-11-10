import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseErrors, parseResult } from '../lib/probe-parsers.mjs';

test('Godot error grouping retains count and resource line', () => {
  const error = 'SCRIPT ERROR: Invalid call.\n   GDScript backtrace (most recent call first):\n       [0] _initialize (res://src/broken.gd:42)\n';
  assert.deepEqual(parseErrors(error + error), [
    { kind: 'SCRIPT ERROR', count: 2, location: 'res://src/broken.gd:42', detail: 'Invalid call.' },
  ]);
});

test('JSON assertion results fail the assertion and gate frame metrics on performance mode', () => {
  const file = { path: 'results/scenario.json', text: JSON.stringify({
    assertions: [{ id: 'faulty-turn', passed: false, detail: { actual: 0 } }],
    frame_times: { median_ms: 2.5, p95_ms: 8.3 },
  }) };
  const result = parseResult('assertions-json', '', [file], { performance: true, run: ['--fixed-fps', '60'] });
  assert.deepEqual(result.assertions, [{ id: 'faulty-turn', passed: false, detail: '{"actual":0}' }]);
  assert.deepEqual(result.lines, []);
  assert.deepEqual(parseResult('assertions-json', '', [file], { performance: true }).lines,
    ['Frame time median 2.50 ms, p95 8.30 ms']);
  assert.deepEqual(parseResult('assertions-json', '', [file]), parseResult('assertions-json', '', [file]));
  assert.throws(() => parseResult('assertions-json', '', [{ path: 'results/bad.json', text: '{"checks":[]}' }]));
});

test('JSON assertion summary-only reports preserve totals without inventing unnamed passes', () => {
  const report = (passed, failures) => parseResult('assertions-json', '', [{
    path: 'results/smoke-check.json', text: JSON.stringify({ passed, checks: 20, failures }),
  }]);
  assert.deepEqual(report(true, []).counts, { total: 20, passed: 20 });
  const failed = report(false, [{ id: 'preview_pause', passed: false, detail: 'still moving' }]);
  assert.deepEqual(failed.counts, { total: 20, passed: 19 });
  assert.equal(failed.assertions[0].id, 'preview_pause');
  const grouped = report(false, ['edge lower length']);
  assert.deepEqual(grouped.counts, { total: 20, passed: null });
  assert.deepEqual(grouped.assertions, [{ id: 'edge lower length', passed: false, detail: '' }]);
  assert.throws(() => report(false, []));
});

test('GUT JUnit handles failure text with literal XML and skips pending cases', () => {
  const text = '<testsuites name="GutTests" tests="3"><testsuite name="tests/test.gd">' +
    '<testcase name="test_pass" classname="tests/test.gd" status="pass">\n</testcase>' +
    '<testcase name="test_fail" classname="tests/test.gd" status="fail">' +
    '<failure message="failed"><![CDATA[expected <tag> & thing]]></failure></testcase>' +
    '<testcase name="test_pending" classname="tests/test.gd" status="pending">' +
    '<skipped message="pending">Not ready</skipped></testcase></testsuite></testsuites>';
  const { assertions, lines } = parseResult('gut', '', [{ path: 'out/gut.xml', text }]);
  assert.deepEqual(assertions, [
    { id: 'res://tests/test.gd:test_pass', passed: true, detail: '' },
    { id: 'res://tests/test.gd:test_fail', passed: false, detail: 'expected <tag> & thing' },
  ]);
  assert.deepEqual(lines, ['GUT skipped 1']);
  assert.throws(() => parseResult('gut', '', [{ path: 'out/gut.xml', text: text.slice(0, -13) }]));
});

test('GUT text fallback keeps the failing test name and line', () => {
  const log = '= Run Summary\nres://tests/test.gd\n- test_broken\n    [Failed]: no\n at line 12\n' +
    'Totals\nTests 2\nPassing Tests 1\nFailing Tests 1\n';
  const { assertions } = parseResult('gut', log);
  assert.deepEqual(assertions[0],
    { id: 'res://tests/test.gd:test_broken', passed: false, detail: 'res://tests/test.gd:12 no' });
  assert.equal(assertions[1].passed, true);
});
