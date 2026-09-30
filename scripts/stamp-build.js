#!/usr/bin/env node
/**
 * The change trail (design §9.4, Phase 10): stamp the build's git SHA into `dist/build-info.json`, which
 * `/health` reports. Runs at BUILD time (`npm run build`); the running service never calls git.
 *
 * `BUILD_GIT_SHA` (CI) wins; otherwise `git rev-parse HEAD`. A dirty tree is refused for a production build
 * (`BUILD_REQUIRE_CLEAN_TREE=true`): an uncommitted change is not traceable to a commit. Without a SHA the file is
 * not written — production then refuses to boot, development reports `unknown`.
 */
const { execFileSync } = require('node:child_process');
const { mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

let gitSha = process.env.BUILD_GIT_SHA;
if (!gitSha) {
  try {
    gitSha = git('rev-parse', 'HEAD');
    if (process.env.BUILD_REQUIRE_CLEAN_TREE === 'true' && git('status', '--porcelain') !== '') {
      process.stderr.write('stamp-build: the working tree has uncommitted changes; refusing to stamp a production build\n');
      process.exit(1);
    }
  } catch {
    gitSha = undefined;
  }
}
if (!gitSha || !/^[0-9a-f]{7,40}$/.test(gitSha)) {
  process.stderr.write('stamp-build: no git SHA (set BUILD_GIT_SHA); dist/build-info.json not written\n');
  process.exit(0);
}
const outDir = join(__dirname, '..', 'dist');
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'build-info.json'), `${JSON.stringify({ gitSha, builtAt: new Date().toISOString() })}\n`);
process.stdout.write(`stamp-build: ${gitSha}\n`);
