# RunReceipt

Wrap your existing Godot checks and save a compact receipt tied to the source it tested. RunReceipt records the runner log, results, and evidence stamp. If the source or configuration changes, `last` and `show` flag the old result as stale.

## Install

Install Node.js 22.14 or later and Godot 4. The fixture and integration tests were verified with Godot 4.7.2. Make the Godot executable available as `godot` or `godot4` on your PATH, or set `GODOT_BIN` to the full executable path. With Godot on PATH:

```sh
git clone https://github.com/thebeefasaurusrex/run-receipt.git
cd run-receipt
npm ci
node bin/run-receipt.mjs --help
```

Windows standalone Godot downloads often have versioned names. Set the path to the actual executable. In PowerShell, for example:

```powershell
$env:GODOT_BIN = 'C:/tools/Godot/godot.exe'
```

On macOS or Linux, set `GODOT_BIN` with `export GODOT_BIN=/path/to/godot`. An explicit `engine` path in `gt.json` takes precedence over the environment variable. Run `npm install --global .` from the checkout if you want the `run-receipt` command on PATH.

## Try it

```sh
node bin/run-receipt.mjs list --cwd fixtures/probe
node bin/run-receipt.mjs run pass --cwd fixtures/probe
node bin/run-receipt.mjs last pass --cwd fixtures/probe
node bin/run-receipt.mjs run broken --cwd fixtures/probe
node bin/run-receipt.mjs show broken --grep "SCRIPT ERROR" --cwd fixtures/probe
npm test
```

The `broken` fixture deliberately exits 1. Add a comment to the fixture's `check.gd` and rerun `last pass` to see the stale result. The tests cover real Godot runs, failure and stale detection, timeouts, and the supported report parsers.

## Configure your project

Start from [the sample gt.json](fixtures/probe/gt.json). Set the project-relative `sources` globs to include everything your checks read. Each check has an ID, a kind, an argument array `run`, a timeout in seconds, result globs, and a parser. `{engine}` expands to the Godot executable and `{root}` to the project root. Exclude generated outputs from the source globs.

- `assertions-json` reads freshly written JSON with an `assertions` array containing `id`, `passed`, and an optional `detail` for each assertion.
- `gut` reads a GUT JUnit report if present and otherwise parses a completed GUT text summary. Install GUT separately in your project if you use this parser.

`run` accepts explicit IDs, `--all`, or `--kind`. `show <id> --log --full` reads the recorded log after checking freshness. Exit codes are 0 for pass, 1 for a failed check, 2 for a setup or runner error, and 3 for stale or missing evidence.

A trusted `gt.json` runs the commands it names. Review a configuration before using it. RunReceipt writes evidence beneath `.gt/probe/`, including local paths, command arguments, and logs. Ignore `.gt/` in Git and review any evidence before sharing it.

## License

Original project code is licensed under [Apache 2.0](LICENSE). See [NOTICE](NOTICE) for attribution.
