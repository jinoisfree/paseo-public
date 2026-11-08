// Preloaded in the test runner and each worker, before product modules are imported.
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
const inherited = process.env.PASEO_TEST_HOME;
const safe = inherited && resolve(inherited) !== resolve(userInfo().homedir) && resolve(inherited).startsWith(resolve(tmpdir()) + '/');
const root = safe ? inherited : mkdtempSync(join(tmpdir(), 'paseo-test-home-'));
process.env.PLAYWRIGHT_BROWSERS_PATH ??= join(userInfo().homedir, process.platform === 'darwin' ? 'Library/Caches/ms-playwright' : '.cache/ms-playwright');
process.env.PASEO_TEST_HOME = root;
process.env.HOME = join(root, 'account');
process.env.PASEO_HOME = join(root, 'paseo');
process.env.PASEO_PUBLIC_CONFIG = join(root, 'public.json');
mkdirSync(process.env.HOME, { recursive: true });
for (const key of ['PASEO_HOST', 'PASEO_ROLE_WORKFLOW_STATE_DIR']) delete process.env[key];
if (!safe) process.on('exit', () => rmSync(root, { recursive: true, force: true }));
