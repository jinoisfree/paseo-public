import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { userInfo } from 'node:os';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
test('test entry point redirects actual owner HOME before a product import can write', () => {
 const actual = userInfo().homedir;
 const marker = resolve(actual, '.paseo/owner/test-entry-must-never-write');
 const out = execFileSync(process.execPath, ['--import', './tests/test-home.mjs', '--input-type=module', '-e', `
 import { mkdirSync, writeFileSync } from 'node:fs';
 mkdirSync(process.env.PASEO_HOME+'/owner', {recursive:true});
 writeFileSync(process.env.PASEO_HOME+'/owner/test-entry-must-never-write','fixture');
 console.log(JSON.stringify([process.env.HOME,process.env.PASEO_HOME,process.env.PASEO_PUBLIC_CONFIG]));
 `], { cwd: resolve(import.meta.dirname, '..'), env: {...process.env, PASEO_TEST_HOME:'', HOME:actual, PASEO_HOME:actual+'/.paseo', PASEO_PUBLIC_CONFIG:actual+'/.config/paseo-public/config.json'}, encoding:'utf8'});
 for(const p of JSON.parse(out)) assert.ok(!p.startsWith(actual+'/'));
 assert.equal(existsSync(marker),false);
});
