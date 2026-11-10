const stripAnsi = text => text.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '');
const assertion = (id, passed, detail = '') => ({ id, passed, detail });

export function parseErrors(log) {
  const groups = new Map();
  let current;
  function finish() {
    if (!current) return;
    const key = JSON.stringify(current);
    const group = groups.get(key);
    if (group) group.count++;
    else groups.set(key, { ...current, count: 1 });
    current = undefined;
  }
  for (const line of stripAnsi(log).split(/\r?\n/)) {
    const header = line.match(/^\s*(SCRIPT ERROR|ERROR|Parse Error):\s*(.*)$/i);
    if (header) {
      finish();
      current = { kind: header[1], location: '', detail: header[2].trim() };
    }
    if (current && !current.location) {
      const location = line.match(/(?:res|user):\/\/[^\r\n()]+?:\d+/);
      if (location) current.location = location[0].trim();
    }
    if (!header && !/^\s|^$/.test(line)) finish();
  }
  finish();
  return [...groups.values()];
}

function assertionsJson(log, files, options) {
  const assertions = [];
  const lines = [];
  let total = 0;
  let passed = 0;
  const json = files.filter(file => /\.json$/i.test(file.path));
  if (!json.length) throw new Error('No JSON assertion results found.');
  for (const file of json) {
    const result = JSON.parse(file.text.replace(/^\uFEFF/, ''));
    const checks = result?.assertions ?? result?.checks;
    const counted = Number.isSafeInteger(checks) && checks > 0;
    const rows = counted ? result.failures : checks;
    if (!Array.isArray(rows) || (counted
      ? rows.length > checks || result.passed !== (rows.length === 0)
      : rows.length === 0)) throw new Error('Invalid JSON check report in ' + file.path);
    const parsed = rows.map(check => {
      if (counted && typeof check === 'string' && check.trim()) return assertion(check, false);
      if (!check || typeof check.id !== 'string' || !check.id || typeof check.passed !== 'boolean') {
        throw new Error('Invalid JSON assertion in ' + file.path);
      }
      if (counted && check.passed) throw new Error('Unexpected passing assertion in ' + file.path);
      const detail = typeof check.detail === 'string' ? check.detail : JSON.stringify(check.detail);
      return assertion(check.id, check.passed, detail);
    });
    if ((result.pass === false || result.passed === false) && !counted && parsed.every(check => check.passed)) {
      parsed.push(assertion('scenario-result', false, result.exit_reason ?? 'Runner reported failure.'));
    }
    assertions.push(...parsed);
    total += counted ? checks : parsed.length;
    // Summary reports can deduplicate failure labels, so the exact failed count is unavailable.
    if (counted && rows.some(row => typeof row === 'string')) passed = null;
    if (passed !== null) passed += counted ? checks - rows.length : parsed.filter(check => check.passed).length;
    const frame = result.frame_times;
    if (options.performance && !options.run?.some(arg => arg.includes('--fixed-fps')) &&
        Number.isFinite(frame?.median_ms) && Number.isFinite(frame.p95_ms)) {
      lines.push('Frame time median ' + frame.median_ms.toFixed(2) + ' ms, p95 ' + frame.p95_ms.toFixed(2) + ' ms');
    }
  }
  return { assertions, lines, counts: { total, passed } };
}

function xmlText(text) {
  return text.replace(/<!\[CDATA\[([\s\S]*?)\]\]>|&(amp|lt|gt|quot|apos);/g,
    (_, literal, entity) => literal ?? ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[entity]);
}

function gutJUnit(text) {
  const assertions = [];
  let skipped = 0;
  let testcase;
  let failure;
  const tokens = text.matchAll(/<!\[CDATA\[[\s\S]*?\]\]>|<!--[\s\S]*?-->|<\/?[\w-]+(?:\s+(?:[^>"']|"[^"]*"|'[^']*')*)?\s*\/?>|[^<]+/g);
  const attr = (tag, key) => xmlText(tag.match(new RegExp('\\b' + key + '=(?:"([^"]*)"|\'([^\']*)\')'))?.slice(1).find(value => value !== undefined) ?? '');
  const root = text.match(/<testsuites(?:\s+[^>]*)?>/);
  if (!root || !/<\/testsuites>\s*$/.test(text)) throw new Error('Incomplete GUT JUnit report.');
  for (const [token] of tokens) {
    if (/^<testcase\b/.test(token)) {
      if (testcase) throw new Error('Incomplete GUT testcase.');
      const name = attr(token, 'name');
      const file = attr(token, 'classname');
      if (!name) throw new Error('Unnamed GUT testcase.');
      const status = attr(token, 'status');
      testcase = { id: file ? 'res://' + file.replace(/^res:\/\//, '') + ':' + name : name,
        skipped: status === 'pending' || status === 'skipped', failed: status === 'fail', detail: '' };
    }
    if (!testcase) continue;
    if (/^<(?:failure|error)\b/.test(token)) {
      testcase.failed = true;
      testcase.detail = attr(token, 'message');
      if (!token.endsWith('/>')) failure = '';
    } else if (/^<\/(?:failure|error)>/.test(token)) {
      testcase.detail = failure?.trim() || testcase.detail;
      failure = undefined;
    } else if (/^<skipped\b/.test(token)) {
      testcase.skipped = true;
    } else if (failure !== undefined) {
      failure += xmlText(token);
    }
    if (token === '</testcase>' || (/^<testcase\b/.test(token) && token.endsWith('/>'))) {
      if (testcase.skipped && !testcase.failed) skipped++;
      else assertions.push(assertion(testcase.id, !testcase.failed, testcase.detail));
      testcase = undefined;
    }
  }
  const total = attr(root[0], 'tests');
  if (testcase || !assertions.length || (total && Number(total) !== assertions.length + skipped)) {
    throw new Error('GUT JUnit report has no completed tests or a mismatched test count.');
  }
  return { assertions, lines: skipped ? ['GUT skipped ' + skipped] : [] };
}

function gut(log, files) {
  const xml = files.find(file => /\.xml$/i.test(file.path));
  if (xml) return gutJUnit(xml.text);
  const summary = log.split('= Run Summary').at(-1);
  const total = Number(summary.match(/^\s*Tests\s+(\d+)\s*$/m)?.[1]);
  const passed = Number(summary.match(/^\s*Passing Tests\s+(\d+)\s*$/m)?.[1] ?? 0);
  const failed = Number(summary.match(/^\s*Failing Tests\s+(\d+)\s*$/m)?.[1] ?? 0);
  if (!Number.isInteger(total) || total < 1 || passed + failed > total || passed + failed < 1) {
    throw new Error('No complete GUT summary found.');
  }
  const failures = new Map();
  let file = '';
  let id = '';
  for (const line of summary.split(/\r?\n/)) {
    const script = line.match(/^\s*(res:\/\/.*\.gd)\s*$/);
    if (script) file = script[1];
    const test = line.match(/^\s*-\s+(test_\S+)/);
    if (test) id = file ? file + ':' + test[1] : test[1];
    const failure = line.match(/^\s*\[Failed\]:\s*(.*)$/);
    if (id && failure && !failures.has(id)) failures.set(id, assertion(id, false, failure[1]));
    const location = line.match(/^\s*at line (\d+)/);
    if (location && failures.has(id) && file) {
      const entry = failures.get(id);
      if (!entry.detail.startsWith('res://')) entry.detail = file + ':' + location[1] + ' ' + entry.detail;
    }
  }
  const assertions = [...failures.values()].slice(0, failed);
  for (let index = assertions.length; index < failed; index++) {
    assertions.push(assertion('gut-failure-' + (index + 1), false, 'Read the GUT log for this failure.'));
  }
  for (let index = 0; index < passed; index++) assertions.push(assertion('gut-pass-' + (index + 1), true));
  const skipped = total - passed - failed;
  return { assertions, lines: skipped ? ['GUT skipped ' + skipped] : [] };
}

const parsers = new Map(Object.entries({
  'assertions-json': assertionsJson, gut,
}));

export function hasParser(parser) {
  return parsers.has(parser);
}

export function parseResult(parser, log, files = [], options = {}) {
  const read = parsers.get(parser);
  if (!read) throw new Error('Unknown RunReceipt parser: ' + parser);
  return { assertions: [], lines: [], hashes: [], ...read(stripAnsi(log), files, options) };
}
