import copy
import json
from pathlib import Path
import unittest
from airport_schema import validate_owner, validate_schema, SCHEMAS

ROOT = Path(__file__).resolve().parents[1]
PRESETS = SCHEMAS.parent


class OwnerSchemaTests(unittest.TestCase):
    def test_examples_follow_shared_schemas(self):
        for kind in ('vault', 'policy'):
            validate_owner(kind, json.loads((PRESETS / 'examples' / f'{kind}.example.json').read_text()))

    def test_version_revision_unknown_keys_and_real_dates_are_checked(self):
        policy = json.loads((PRESETS / 'examples/policy.example.json').read_text())
        for field, invalid in [('version', 2), ('version', True), ('revision', -1), ('revision', False), ('extra', 'secret')]:
            value = copy.deepcopy(policy); value[field] = invalid
            with self.assertRaises(ValueError):
                validate_owner('policy', value)
        for invalid in [None, '2026-02-30', '20260101', 'secret']:
            value = copy.deepcopy(policy)
            decision = value['decisions']['operatingProfile']
            if invalid is None:
                del decision['date']
            else:
                decision['date'] = invalid
            with self.assertRaisesRegex(ValueError, '필수|날짜') as error:
                validate_owner('policy', value)
            self.assertNotIn('secret', str(error.exception))
        value = copy.deepcopy(policy); del value['revision']
        with self.assertRaisesRegex(ValueError, '필수'):
            validate_owner('policy', value)

    def test_vault_and_policy_do_not_accept_each_others_fields(self):
        with self.assertRaises(ValueError):
            validate_owner('vault', {'version': 1, 'revision': 0, 'decisions': {}})
        with self.assertRaises(ValueError):
            validate_owner('policy', {'version': 1, 'revision': 0, 'keychain': {}})

    def test_schema_dialect_does_not_silently_ignore_constraints(self):
        with self.assertRaisesRegex(ValueError, '지원하지 않는'):
            validate_schema('x', {'unsupported': True})

    def test_modules_have_valid_manifests_and_real_template_sources(self):
        schema = json.loads((SCHEMAS / 'module.schema.json').read_text())
        manifests = sorted((ROOT / 'modules').glob('*/module.json'))
        self.assertEqual(len(manifests), 3)
        for file in manifests:
            value = json.loads(file.read_text()); validate_schema(value, schema)
            self.assertEqual(value['id'], file.parent.name)
            for item in value['installs']:
                self.assertTrue((ROOT / item['source']).is_file())
            for key in schema['required']:
                broken = dict(value); del broken[key]
                with self.assertRaises(ValueError):
                    validate_schema(broken, schema)

    def test_ownership_table_covers_all_slots_and_inventory_baseline(self):
        ownership = json.loads((PRESETS / 'ownership.json').read_text())
        slots = {x['id'] for x in ownership['slots']}
        self.assertEqual(len(slots), 20)
        for section in ['paseoHome','config','publicConfig','desktopSettings']:
            for item in ownership[section].values():
                self.assertIn(item['slot'], slots)
                for slot in item.get('children', {}).values():
                    self.assertIn(slot, slots)
        baseline = '''agent-requests agents analysis backups ck-captures claude-provider.sh cli-client-id
codex-accounts codex-home config.json creations daemon-keypair.json daemon.log desktop-attachments
local-credential logs paseo.pid pipeline plugin-mirror projects push-tokens.json role-workflow
role-workflow-backups runtime schedules server-id task-artifacts task-logs terminal-worker
terminal-worker.log uploads verification worktree-archives'''.split()
        self.assertFalse(set(baseline) - ownership['paseoHome'].keys())
        self.assertIn('daemon.agentProfiles', ownership['config'])
        self.assertIn('settings.daemon.keepRunningAfterQuit', ownership['desktopSettings'])
