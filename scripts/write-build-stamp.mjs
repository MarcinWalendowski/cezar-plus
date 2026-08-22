import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const root = process.cwd();
const out = join(root, 'packages/cezar/dist/.build-stamp.json');
const git = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const stamp = {
  stampVersion: 1,
  sha: git(['rev-parse', 'HEAD']),
  builtAt: new Date().toISOString(),
  dirty: git(['status', '--porcelain']).length > 0,
  version: JSON.parse(readFileSync(join(root, 'packages/cezar/package.json'), 'utf8')).version,
};
mkdirSync(dirname(out), { recursive: true });
const tmp = `${out}.${process.pid}.tmp`;
writeFileSync(tmp, `${JSON.stringify(stamp)}\n`, 'utf8');
renameSync(tmp, out);
