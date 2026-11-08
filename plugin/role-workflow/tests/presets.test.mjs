import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { settingsSchema } from '../shared/contracts.ts';
import { recommendedSchema, recommendedSettings } from '../shared/recommended.ts';
import { executorDefaults } from '../shared/assignment.ts';

const json = async name => JSON.parse(await readFile(new URL(`../shared/presets/${name}`, import.meta.url), 'utf8'));

test('U2 public recommendations supply missing settings and null assignment from one validated source', () => {
  const settings = settingsSchema.parse({});
  assert.equal(settings.archiveAfterDays, 2);
  assert.equal(settings.threshold, 0.7);
  assert.deepEqual(settings.claudeCompression, { threshold: 0.55, oneMillionTokenLimit: 500000 });
  assert.equal(settings.codexCompression, 'native');
  assert.equal(settings.maxCycles, 20);
  assert.equal(settings.maxTurns, 50);
  assert.equal(settings.executorMode, 'full-access');
  assert.equal(settings.claudeExecutorMode, 'bypassPermissions');
  assert.deepEqual(settings, recommendedSettings);
  for (const provider of ['claude', 'codex']) {
    assert.deepEqual(executorDefaults(null, provider), executorDefaults(settings, provider));
  }
  assert.deepEqual(executorDefaults(null, 'claude'), {model:'claude', thinking:'', mode:'bypassPermissions'});
  assert.deepEqual(executorDefaults(null, 'codex'), {model:'codex', thinking:'', mode:'full-access'});
});

test('explicit saved settings survive the recommendation change', () => {
  const settings = settingsSchema.parse({archiveAfterDays:3, threshold:0.8, claudeCompression:null,
    codexCompression:'threshold', maxCycles:5, maxTurns:30, executorMode:'auto', claudeExecutorMode:'acceptEdits'});
  assert.equal(settings.archiveAfterDays,3);assert.equal(settings.threshold,0.8);
  assert.equal(settings.claudeCompression,null);assert.equal(settings.codexCompression,'threshold');
  assert.equal(settings.maxCycles,5);assert.equal(settings.maxTurns,30);
  assert.equal(settings.executorMode,'auto');assert.equal(settings.claudeExecutorMode,'acceptEdits');
});

test('invalid recommended JSON fails schema validation and operating profiles preserve owner choices', async () => {
  const raw = await json('recommended.json');
  assert.equal(recommendedSchema.safeParse(raw).success,true);
  const missingRoots=structuredClone(raw);delete missingRoots.roleWorkflow.folderRoots;
  assert.equal(recommendedSchema.safeParse(missingRoots).success,false);
  for(const key of ['archiveAfterDays','threshold','maxCycles','executorMode']) {
    const bad=structuredClone(raw);bad.roleWorkflow[key]=null;
    assert.equal(recommendedSchema.safeParse(bad).success,false);
  }
  assert.equal(raw.profiles.server.desktopSettings.daemon.manageBuiltInDaemon,false);
  assert.equal(raw.profiles.desktop.desktopSettings.daemon.manageBuiltInDaemon,true);
  assert.equal('keepRunningAfterQuit' in raw.profiles.desktop.desktopSettings.daemon,false);
  assert.equal('listen' in (raw.core.daemon ?? {}),false);
  assert.equal(raw.core.daemon.browserTools.enabled,true);
  assert.deepEqual(raw.core.agents.skills.selection,{mode:'all'});
  assert.equal(raw.core.features.webUi.enabled,false);
  assert.deepEqual(raw.core.log.file.rotate,{maxSize:'10m',maxFiles:3});
});

test('recommended role templates require explicit account and model selection', async () => {
  for (const role of ['planner','executor']) {
    const template=await json(`roles/${role}.json`);
    assert.equal(template.version,1);assert.equal(template.role,role);assert.equal(template.autoSelect,false);
    assert.deepEqual(template.profiles.map(p=>p.provider),['claude','codex']);
    for(const profile of template.profiles) {
      assert.equal(typeof profile.model,'string');assert.ok(profile.model.length);
    }
  }
});
