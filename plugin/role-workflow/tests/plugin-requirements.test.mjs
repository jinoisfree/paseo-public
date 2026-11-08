import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { assertPluginCompatibility } from '@getpaseo/protocol/plugin-requirements';

test('C30: both plugins survive an app update beyond the tested minor version', async () => {
  for (const plugin of ['role-workflow', 'codex-usage']) {
    const manifest = JSON.parse(await readFile(new URL(`../../${plugin}/paseo-plugin.json`, import.meta.url), 'utf8'));
    // C30 removes the unverified upper gate; 0.15 remains the minimum for addHook APIs.
    for (const runtime of ['daemon', 'desktop']) {
      for (const version of ['0.15.3', '0.16.0', '1.0.0']) {
        assert.doesNotThrow(() => assertPluginCompatibility({ ...manifest, runtime, version }));
      }
      assert.throws(() => assertPluginCompatibility({ ...manifest, runtime, version: '0.14.0' }), /requires Paseo/);
    }
  }
});
