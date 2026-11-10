import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, globSync, lstatSync, mkdirSync, readFileSync, readSync, openSync, closeSync, realpathSync, renameSync, rmSync, rmdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, delimiter, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { hasParser, parseErrors, parseResult } from './probe-parsers.mjs';

const version = 'run-receipt/1';
const kinds = ['unit', 'scenario', 'soak', 'replay', 'export'];
const read = (file) => {
  const bytes = readFileSync(file);
  return bytes.toString(bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf16le' : 'utf8').replace(/^\uFEFF/, '');
};
const json = (file) => JSON.parse(read(file));
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const shorten = (text) => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 220);

function matches(root, patterns, results = false) {
  if (!Array.isArray(patterns) || patterns.some((p) =>
    typeof p !== 'string' || !p || isAbsolute(p) || p.includes('\\') || p.split('/').includes('..'))) {
    throw new Error('Use project-relative glob paths with forward slashes.');
  }
  const exclude = results ? ['.git', '.godot'] : ['.git', '.gt', '.godot'];
  return [...new Set(globSync(patterns, { cwd: root, exclude }))]
    .filter((file) => lstatSync(join(root, file)).isFile()).map((file) => file.replaceAll('\\', '/')).sort();
}

function config(root) {
  const path = join(root, 'gt.json');
  const value = json(path);
  if (typeof value.name !== 'string' || typeof value.engine !== 'string' ||
      !value.sources?.length || !Array.isArray(value.checks) || !value.checks.length) {
    throw new Error('gt.json needs name, engine, sources and checks.');
  }
  const ids = new Set();
  for (const check of value.checks) {
    if (typeof check.id !== 'string' || !/^[a-z0-9][a-z0-9_-]*$/.test(check.id) || ids.has(check.id) || !kinds.includes(check.kind) ||
        !Array.isArray(check.run) || !check.run[0] || check.run.some((arg) => typeof arg !== 'string') ||
        !Number.isFinite(check.timeout_s) || check.timeout_s <= 0 || check.timeout_s > 3600 ||
        !Array.isArray(check.results) || !hasParser(check.parser)) {
      throw new Error(`Invalid check config: ${check.id}`);
    }
    ids.add(check.id);
  }
  return value;
}

function command(file, args, cwd) {
  return spawnSync(file, args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 15000 });
}

function expand(value, root, engine) {
  return value.replace(/\{(engine|root)\}/g, (_, key) => key === 'engine' ? engine : root);
}

function engineInfo(root, setting) {
  const explicit = setting === 'auto' ? process.env.GODOT_BIN : setting;
  const names = process.platform === 'win32' ? ['godot.exe', 'godot4.exe'] : ['godot', 'godot4'];
  const search = (process.env.PATH ?? '').split(delimiter).filter(Boolean);
  const candidates = explicit ? [resolve(root, expand(explicit, root))]
    : search.flatMap(directory => names.map(name => resolve(root, directory, name)));
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    const result = command(path, ['--version'], root);
    if (result.status === 0 && result.stdout?.trim()) return { path, version: result.stdout.trim() };
  }
  throw new Error('Godot executable not found. Set GODOT_BIN or the engine field in gt.json.');
}

function sourceStamp(root, settings) {
  const head = command('git', ['rev-parse', '--verify', 'HEAD'], root);
  const gitRoot = command('git', ['rev-parse', '--show-toplevel'], root);
  const ownGit = gitRoot.status === 0 && relative(root, gitRoot.stdout.trim()) === '';
  let git = null;
  if (ownGit) {
    const status = command('git', ['status', '--porcelain', '--untracked-files=normal'], root);
    if (head.status !== 0 || status.status !== 0) throw new Error('Cannot read project git state.');
    git = { commit: head.stdout.trim(), dirty: !!status.stdout.trim() };
  }
  const source = matches(root, settings.sources);
  if (!source.length) throw new Error('No files match the declared source globs.');
  const hash = createHash('sha256');
  for (const file of source) {
    hash.update(JSON.stringify([file, sha(readFileSync(join(root, file)))]));
  }
  return { git, sourceSha256: hash.digest('hex'), configSha256: sha(readFileSync(join(root, 'gt.json'))) };
}

function identity(root, settings, check) {
  const engine = engineInfo(root, settings.engine);
  const args = check.run.map((arg) => expand(arg, root, engine.path));
  return {
    tool: version, check: check.id, ...sourceStamp(root, settings), engine,
    renderer: check.renderer ?? null, seed: check.seed ?? null, args,
  };
}

function execute(args, root, output, timeout, appdata) {
  return new Promise((done) => {
    const env = { ...process.env, APPDATA: appdata, XDG_DATA_HOME: appdata };
    if (process.platform === 'win32' && env.SystemRoot && basename(args[0]).toLowerCase() === 'powershell.exe') {
      // An isolated APPDATA can stop Windows PowerShell from finding its own utility module.
      const modules = join(env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules');
      env.PSModulePath = [modules, env.PSModulePath].filter(Boolean).join(delimiter);
    }
    const fd = openSync(output, 'w');
    const reader = openSync(output, 'r');
    let child;
    try {
      child = spawn(args[0], args.slice(1), {
        cwd: root, stdio: ['ignore', fd, fd], windowsHide: true,
        env,
      });
    } catch (error) {
      closeSync(reader);
      throw error;
    } finally {
      closeSync(fd);
    }
    let timedOut = false;
    let loadStopped = false;
    let failure;
    const stop = () => {
      clearTimeout(timer);
      clearInterval(watch);
      if (child.pid === undefined) return;
      if (process.platform === 'win32') command('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], root);
      child.kill('SIGKILL');
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeout * 1000);
    const scriptFlag = args.findIndex((arg) => arg === '-s' || arg === '--script');
    const scriptPath = (value) => resolve(root, value.replace(/^res:\/\//, ''));
    const runner = scriptFlag < 0 || !args[scriptFlag + 1] ? null : scriptPath(args[scriptFlag + 1]);
    let offset = 0;
    let remainder = '';
    const bytes = Buffer.alloc(65536);
    const watch = setInterval(() => {
      let count;
      if (!runner) return;
      try { count = readSync(reader, bytes, 0, bytes.length, offset); } catch { return; }
      if (!count) return;
      offset += count;
      const lines = (remainder + bytes.toString('utf8', 0, count)).split('\n');
      remainder = lines.pop().slice(-4096);
      const fatal = lines.some((line) => {
        const match = line.replace(/\x1b\[[0-9;]*m/g, '').match(/^\s*ERROR:\s*(?:(?:Failed|Unable) to|Cannot) load script "([^"]+)" with error "(?:Parse|Compilation|Compile) error"/i);
        return match && scriptPath(match[1]) === runner;
      });
      if (fatal) {
        loadStopped = true;
        stop();
      }
    }, 200);
    child.once('error', (error) => { failure = error.message; });
    child.once('close', (code) => {
      clearTimeout(timer);
      clearInterval(watch);
      closeSync(reader);
      done({ code: loadStopped ? 1 : code, failure: timedOut ? `Timed out after ${timeout}s` : failure ?? (!loadStopped && code === null ? 'Runner stopped without an exit code' : null) });
    });
  });
}

function snapshot(root, globs) {
  return new Map(matches(root, globs, true).map((path) => {
    const { mtimeNs, ctimeNs, ino, size } = statSync(join(root, path), { bigint: true });
    return [path, [mtimeNs, ctimeNs, ino, size].join('/')];
  }));
}

function print(lines, full, footer) {
  console.log([...lines.slice(0, full ? undefined : 14), ...(footer ? [footer] : [])].join('\n'));
}

function clear(root, folder) {
  if (!existsSync(folder)) return;
  const subpath = relative(realpathSync(root), realpathSync(folder));
  if (!subpath.startsWith(join('.gt', 'probe') + sep)) {
    throw new Error('Check output directory points outside .gt/probe.');
  }
  rmSync(folder, { recursive: true, force: true });
}

function uniqueErrors(groups) {
  const unique = new Map();
  for (const group of groups) {
    const { kind, location, detail, count } = group;
    const key = JSON.stringify([kind, location, detail]);
    const previous = unique.get(key);
    if (!previous || previous.count < count) unique.set(key, group);
  }
  return [...unique.values()];
}

function formatError({ kind, count, location, detail }) {
  return shorten([kind, 'x' + count, location, detail].filter(Boolean).join(' '));
}

function compileLines(roots, dependents) {
  const causes = uniqueErrors(roots);
  const count = uniqueErrors(dependents).length;
  return [
    ...causes.slice(0, 3).map(formatError),
    ...(count ? ['+' + count + (count === 1 ? ' script failed' : ' scripts failed') +
      (causes.length === 1 ? ' to compile because of it.' : ' to compile due to dependencies.')] : []),
  ];
}

function summary(code, id, evidence, failures, errors, timeout) {
  const label = ['PASS', 'FAIL', 'ERROR', 'STALE'][code];
  const { total, passed } = evidence.counts ?? {
    total: evidence.assertions.length, passed: evidence.assertions.length - failures.length,
  };
  const parts = [];
  if (failures.length) parts.push(passed === null
    ? failures.length + (failures.length === 1 ? ' failure group' : ' failure groups') + ' across ' + total + ' checks'
    : (total - passed) + ' failed, ' + passed + ' passed');
  else if (code === 0) parts.push(total + '/' + total + ' checks');
  if (errors.length) parts.push(errors.length + ' Godot error ' + (errors.length === 1 ? 'group' : 'groups'));
  if (!parts.length) parts.push(timeout ? 'timed out' : ['checks completed', 'runner failed', 'tool or setup error', 'evidence unavailable'][code]);
  return label + ' ' + id + ' | ' + parts.join(' | ');
}

async function run(root, settings, check) {
  const folder = join(root, '.gt', 'probe', check.id);
  const stampPath = join(folder, 'stamp.json');
  const logPath = join(folder, 'run.log');
  const runnerPath = join(folder, 'runner.log');
  const appdata = join(folder, 'userdata');
  const lock = join(root, '.gt', 'probe', 'running');
  mkdirSync(folder, { recursive: true });
  try {
    mkdirSync(lock);
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error(`Check is locked: ${lock}`);
    throw error;
  }
  try {
    rmSync(stampPath, { force: true });
    clear(root, appdata);
    mkdirSync(appdata, { recursive: true });
    const before = identity(root, settings, check);
    const prior = snapshot(root, check.results);
    const started = performance.now();
    const outcome = await execute(before.args, root, runnerPath, check.timeout_s, appdata);
    const wallTimeMs = Math.round(performance.now() - started);
    const files = [...snapshot(root, check.results)].filter(([path, meta]) => prior.get(path) !== meta)
      .map(([path]) => ({ path, text: read(join(root, path)) }));
    const saved = join(folder, 'results');
    clear(root, saved);
    for (const file of files) {
      const target = join(saved, file.path);
      mkdirSync(resolve(target, '..'), { recursive: true });
      writeFileSync(target, file.text);
    }
    const stdout = read(runnerPath);
    const engineLogs = files.filter((file) => file.path.endsWith('.log')).map((file) => file.text);
    writeFileSync(logPath, [stdout, ...engineLogs].filter(Boolean).join('\n'));
    const after = identity(root, settings, check);
    const changed = JSON.stringify(before) !== JSON.stringify(after);
    let evidence = { assertions: [], lines: [], hashes: [] };
    let parseError;
    try {
      evidence = parseResult(check.parser, stdout, files, { run: before.args, performance: check.performance === true });
    } catch (error) {
      parseError = error.message;
    }
    const errors = uniqueErrors([stdout, ...engineLogs].flatMap(parseErrors));
    const dependentErrors = errors.filter(({ detail }) => /^Compile Error: Failed to compile depend(?:ed|ent) scripts/i.test(detail));
    const rootErrors = errors.filter((error) => !dependentErrors.includes(error) &&
      (error.kind.toLowerCase() === 'parse error' || /^(?:Parse|Compile) Error\b/i.test(error.detail)));
    const otherErrors = errors.filter((error) => !rootErrors.includes(error) && !dependentErrors.includes(error));
    const loadFailed = otherErrors.some(({ detail }) => /^(?:(?:Failed|Unable) to|Cannot) load (?:script|scene|resource)\b/i.test(detail));
    const failures = evidence.assertions.filter((item) => !item.passed);
    const missing = check.results.some((path) => !path.endsWith('.log')) && !files.some((file) => !file.path.endsWith('.log'));
    const timeout = outcome.failure?.startsWith('Timed out ') || /exceeded the bounded timeout/i.test(stdout);
    let code = 0;
    if (changed) code = 3;
    else if (rootErrors.length || dependentErrors.length || loadFailed) code = 1;
    else if (outcome.failure || timeout) code = 2;
    else if (failures.length || errors.length) code = 1;
    else if (missing && !outcome.code) code = 3;
    else if (parseError) code = 2;
    else if (outcome.code) code = 1;
    else if (check.results.length && !files.length) code = 3;
    const headline = summary(code, check.id, evidence, failures, errors, timeout);
    const assertionLines = failures.slice(0, 3).map((item) => `FAIL ${shorten(item.id)} ${shorten(item.detail)}`.trimEnd());
    const details = [
      ...evidence.lines.slice(0, 3).map(shorten),
      ...evidence.hashes.slice(0, 2).map(shorten),
      ...[changed && 'Inputs changed during the run.', outcome.failure,
        timeout && !outcome.failure && 'Project runner exceeded its timeout.',
        outcome.code && !failures.length && !errors.length && `Runner exit ${outcome.code}`, code === 2 && parseError,
        check.results.length && !files.length && 'No newly written result files.']
        .filter(Boolean).slice(0, 2).map(shorten),
    ];
    const stampLine = `Stamp ${before.sourceSha256.slice(0, 12)} | Godot ${before.engine.version} | ${before.renderer ?? 'renderer default'}`;
    const digest = [headline, ...compileLines(rootErrors, dependentErrors),
      ...assertionLines, ...otherErrors.slice(0, 3).map(formatError), ...details].slice(0, 13);
    digest.push(stampLine);
    const report = { code, digest };
    const footer = `Log ${logPath}`;
    writeFileSync(join(folder, 'digest.json'), JSON.stringify(report, null, 2) + '\n');
    if (!changed && code < 2) {
      const stamp = { ...before, wallTimeMs, logSha256: sha(readFileSync(logPath)), digestSha256: sha(readFileSync(join(folder, 'digest.json'))) };
      writeFileSync(stampPath + '.tmp', JSON.stringify(stamp, null, 2) + '\n');
      renameSync(stampPath + '.tmp', stampPath);
    }
    return { code, digest, footer, headline, rootErrors, dependentErrors, otherErrors, assertionLines, details, stampLine };
  } finally {
    rmdirSync(lock);
  }
}

function load(root, settings, id) {
  const folder = join(root, '.gt', 'probe', id);
  const stampPath = join(folder, 'stamp.json');
  const log = join(folder, 'run.log');
  const digestPath = join(folder, 'digest.json');
  if (existsSync(join(root, '.gt', 'probe', 'running')) || ![stampPath, log, digestPath].every(existsSync)) return null;
  const check = settings.checks.find((entry) => entry.id === id);
  const stampText = read(stampPath);
  const { wallTimeMs, logSha256, digestSha256, ...saved } = JSON.parse(stampText);
  const current = identity(root, settings, check);
  const logBytes = readFileSync(log);
  const digestBytes = readFileSync(digestPath);
  if (JSON.stringify(saved) !== JSON.stringify(current) ||
      logSha256 !== sha(logBytes) || digestSha256 !== sha(digestBytes) || !existsSync(stampPath) ||
      stampText !== read(stampPath)) return null;
  return { ...JSON.parse(digestBytes), log, logText: logBytes.toString('utf8') };
}

function latest(root, checks) {
  return checks.map(({ id }) => {
    const file = join(root, '.gt', 'probe', id, 'digest.json');
    return { id, time: existsSync(file) ? statSync(file).mtimeMs : -1 };
  }).sort((a, b) => b.time - a.time || a.id.localeCompare(b.id)).find((entry) => entry.time >= 0)?.id;
}

export async function probe(args) {
  const [action, ...rest] = args;
  const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: {
    cwd: { type: 'string' }, all: { type: 'boolean' }, kind: { type: 'string' }, full: { type: 'boolean' },
    log: { type: 'boolean' }, grep: { type: 'string' },
  } });
  if (!['list', 'run', 'last', 'show'].includes(action)) throw new Error('Use run-receipt list, run, last or show.');
  const root = resolve(values.cwd ?? process.cwd());
  const settings = config(root);
  const footer = `Evidence ${join(root, '.gt', 'probe')}`;
  const lookup = (id) => {
    const check = settings.checks.find((entry) => entry.id === id);
    if (!check) throw new Error(`Unknown check: ${id}`);
    return check;
  };
  if (action === 'list') {
    if (positionals.length) throw new Error('Use run-receipt list.');
    print(settings.checks.map((check) => `${check.id} | ${check.kind} | ${check.timeout_s}s`), values.full, footer);
    return 0;
  }
  if (action === 'run') {
    if (Number(!!values.all) + Number(values.kind !== undefined) + Number(!!positionals.length) !== 1) {
      throw new Error('Choose check IDs, --all or --kind.');
    }
    const checks = values.all ? settings.checks : values.kind !== undefined
      ? settings.checks.filter((check) => check.kind === values.kind) : [...new Set(positionals)].map(lookup);
    if (!checks.length) throw new Error('No checks selected.');
    const reports = [];
    for (const check of checks) reports.push(await run(root, settings, check));
    const [first] = reports;
    const otherErrors = uniqueErrors(reports.flatMap((report) => report.otherErrors));
    const lines = reports.length === 1 ? first.digest : [
      ...compileLines(reports.flatMap((report) => report.rootErrors), reports.flatMap((report) => report.dependentErrors)),
      ...(values.full ? [...otherErrors.map(formatError),
        ...reports.flatMap((report) => [report.headline, ...report.assertionLines, ...report.details, report.stampLine])] :
        [...reports.map((report) => report.headline),
          ...otherErrors.slice(0, 3).map(formatError),
          ...reports.filter((report) => report.code).flatMap((report) => [...report.assertionLines, ...report.details].slice(0, 3))]),
    ];
    print(lines, values.full, reports.length === 1 ? first.footer : footer);
    return Math.max(...reports.map((report) => report.code));
  }
  if (positionals.length > 1 || (action === 'show' && !positionals.length)) throw new Error(`Use run-receipt ${action} <id>.`);
  const id = positionals[0] ?? latest(root, settings.checks);
  if (id) lookup(id);
  let report;
  try {
    report = id && load(root, settings, id);
  } catch (error) {
    if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
  }
  if (!report) {
    print([`STALE ${id ?? settings.name} | evidence missing, changed or unavailable`], false, footer);
    return 3;
  }
  const lines = action === 'show' && (values.log || values.grep !== undefined)
    ? report.logText.trimEnd().split(/\r?\n/).filter((line) => values.grep === undefined || line.includes(values.grep))
    : report.digest;
  print(lines.length ? lines : ['No matching log lines.'], values.full, `Log ${report.log}`);
  return report.code;
}
