/**
 * @file Regression coverage for the EALLOWSCRIPTS fix (#343): the shared
 * sanitizer must drop only `npm_config_allow_scripts*` (any casing) from a
 * nested install's environment while preserving every other `npm_config_*`
 * value and forwarding argv verbatim, and the lifecycle install paths
 * (`setup`, `mcp:install`) plus the root `postinstall` must all route through
 * that single sanitized implementation. Pure Node — no bash or real network —
 * so it runs identically on Windows, macOS, and Linux CI.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..", "..");
const RUN_NPM = path.join(ROOT, "scripts", "run-npm.js");
const { sanitizeNpmEnv } = require(RUN_NPM);

describe("sanitizeNpmEnv", () => {
  it("drops only npm_config_allow_scripts* keys, any casing, preserving the rest", () => {
    const env = {
      npm_config_allow_scripts: "a,b",
      npm_config_allow_scripts_pending: "c",
      NPM_CONFIG_ALLOW_SCRIPTS: "d",
      npm_config_registry: "https://example.invalid",
      npm_config_userconfig: "/tmp/.npmrc",
      PATH: "/bin",
      HOME: "/home/u",
    };
    const out = sanitizeNpmEnv(env);
    for (const [k, v] of Object.entries(env)) {
      if (k.toLowerCase().startsWith("npm_config_allow_scripts")) {
        assert.ok(!(k in out), `expected ${k} to be stripped`);
      } else {
        assert.equal(out[k], v, `expected ${k} to be preserved unchanged`);
      }
    }
  });
});

describe("run-npm.js CLI wrapper", () => {
  // A JavaScript npm stub writes exactly what it saw (argv + the two
  // npm_config_* sentinels) to a JSON file. Pointing npm_execpath at it mirrors
  // npm's lifecycle contract and works identically on every platform.
  function runStubNpm(args = ["--prefix", "stubdir", "ci"]) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ccam-run-npm-"));
    const out = path.join(tmp, "npm-seen.txt");
    const stub = path.join(tmp, "npm-stub.js");
    fs.writeFileSync(
      stub,
      'require("node:fs").writeFileSync(process.env.TEST_OUTPUT_FILE, JSON.stringify({ args: process.argv.slice(2), allow: process.env.npm_config_allow_scripts, registry: process.env.npm_config_registry }));\n'
    );
    const result = spawnSync(process.execPath, [RUN_NPM, ...args], {
      env: {
        ...process.env,
        npm_execpath: stub,
        npm_config_allow_scripts: "sentinel-must-not-leak",
        npm_config_registry: "sentinel-registry",
        TEST_OUTPUT_FILE: out,
      },
    });
    assert.equal(result.status, 0, `wrapper exited ${result.status}: ${result.stderr}`);
    return JSON.parse(fs.readFileSync(out, "utf8"));
  }

  it("does not leak npm_config_allow_scripts to the spawned npm", () => {
    const seen = runStubNpm();
    assert.equal(seen.allow, undefined);
  });

  it("preserves other npm_config_* values and forwards argv verbatim", () => {
    const expectedArgs = ["--prefix", "directory with spaces", "ci"];
    const seen = runStubNpm(expectedArgs);
    assert.equal(seen.registry, "sentinel-registry");
    assert.deepEqual(seen.args, expectedArgs);
  });
});

describe("package.json install paths", () => {
  const scripts = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).scripts;
  // A bare `npm ci`/`npm install` (optionally with --prefix) at the start of a
  // &&-chain is unsanitized and reintroduces the EALLOWSCRIPTS failure mode.
  const BARE_INSTALL = /(?:^|&&\s*)npm\s+(?:--prefix\s+\S+\s+)?(?:ci|install)\b/;

  it("setup routes every nested install through run-npm.js", () => {
    assert.ok(!BARE_INSTALL.test(scripts.setup), `unsanitized install in setup: ${scripts.setup}`);
    assert.match(scripts.setup, /node scripts\/run-npm\.js ci/);
    assert.match(scripts.setup, /node scripts\/run-npm\.js --prefix client ci/);
    assert.match(scripts.setup, /node scripts\/run-npm\.js --prefix vscode-extension ci/);
  });

  it("mcp:install routes through run-npm.js", () => {
    assert.ok(!BARE_INSTALL.test(scripts["mcp:install"]), "unsanitized install in mcp:install");
    assert.match(scripts["mcp:install"], /node scripts\/run-npm\.js --prefix mcp ci/);
  });

  it("postinstall uses the shared sanitizer instead of a duplicate", () => {
    const src = fs.readFileSync(path.join(ROOT, "scripts", "postinstall.js"), "utf8");
    assert.match(src, /require\("\.\/run-npm\.js"\)/);
    assert.match(src, /runNpm\(\["install"\], process\.env/);
  });
});

describe("Docker server dependency stage", () => {
  it("copies the postinstall npm helper before npm ci runs", () => {
    const dockerfile = fs.readFileSync(path.join(ROOT, "Dockerfile"), "utf8");
    const dependencyStage = dockerfile.slice(0, dockerfile.indexOf("# ── Stage 2"));

    assert.match(
      dependencyStage,
      /COPY scripts\/postinstall\.js scripts\/run-npm\.js \.\/scripts\//
    );
  });

  it("copies the postinstall npm helper into both MCP install stages", () => {
    const dockerfile = fs.readFileSync(path.join(ROOT, "mcp", "Dockerfile"), "utf8");
    const lifecycleCopies = dockerfile.match(
      /COPY scripts\/postinstall\.js scripts\/run-npm\.js \.\/scripts\//g
    );

    assert.equal(lifecycleCopies?.length, 2);
  });
});
