import importlib.util
from pathlib import Path
import os
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('launcher_runtime', ROOT / 'modules/launcher_runtime.py')
runtime = importlib.util.module_from_spec(spec); spec.loader.exec_module(runtime)


class LauncherTests(unittest.TestCase):
    def executable(self, path):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text('#!/bin/sh\nexit 0\n'); path.chmod(0o700)
        return str(path)

    def test_product_brew_path_order_and_missing_cli(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            bundled = self.executable(root / 'app/codex')
            brew = self.executable(root / 'brew/bin/codex')
            other = self.executable(root / 'path/codex')
            args = dict(bundled=[bundled], brew_roots=[root / 'brew'], path=str(root / 'path'))
            self.assertEqual(runtime.find_cli('codex', **args), bundled)
            Path(bundled).unlink()
            self.assertEqual(runtime.find_cli('codex', **args), brew)
            Path(brew).unlink()
            self.assertEqual(runtime.find_cli('codex', **args), other)
            Path(other).unlink()
            with self.assertRaisesRegex(ValueError, '실행 파일이 없습니다'):
                runtime.find_cli('codex', **args)

    def test_paseo_uses_only_absolute_app_cli(self):
        with tempfile.TemporaryDirectory() as temp:
            app = Path(temp) / 'Paseo.app'
            with self.assertRaisesRegex(ValueError, '앱 내장 CLI'):
                runtime.paseo_cli(app)
            cli = self.executable(app / 'Contents/Resources/bin/paseo')
            self.assertEqual(runtime.paseo_cli(app), cli)
            with self.assertRaises(ValueError):
                runtime.paseo_cli('relative.app')

    def test_claude_passes_token_only_in_env_and_preserves_args_and_home(self):
        import subprocess
        env = {'PASEO_CLAUDE_KEYCHAIN_SERVICE': 'fixture-service',
               'PASEO_CLAUDE_KEYCHAIN_ACCOUNT': 'fixture-account',
               'CLAUDE_CONFIG_DIR': '/fixture/claude-home', 'ANTHROPIC_API_KEY': 'do-not-use'}
        with patch.dict(os.environ, env, clear=True), patch.object(runtime, 'find_cli', return_value='/fixture/claude'), \
             patch.object(runtime.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, 'fixture-token\n')) as keychain, \
             patch.object(runtime.os, 'execve') as execute:
            runtime.launch('claude', ['--version', 'argument with spaces'])
            keychain.assert_called_once()
            cli, args, sent = execute.call_args.args
            self.assertEqual(cli, '/fixture/claude')
            self.assertEqual(args, [cli, '--version', 'argument with spaces'])
            self.assertEqual(sent['CLAUDE_CODE_OAUTH_TOKEN'], 'fixture-token')
            self.assertEqual(sent['CLAUDE_CONFIG_DIR'], '/fixture/claude-home')
            self.assertNotIn('ANTHROPIC_API_KEY', sent)
        with patch.dict(os.environ, {}, clear=True), patch.object(runtime, 'find_cli', return_value='/fixture/claude'):
            with self.assertRaisesRegex(ValueError, '금고'):
                runtime.launch('claude', [])

    def test_codex_does_not_select_account_or_modify_home(self):
        with patch.dict(os.environ, {'CODEX_HOME': '/fixture/codex-home', 'OPENAI_API_KEY': 'unused'}, clear=True), \
             patch.object(runtime, 'find_cli', return_value='/fixture/codex'), patch.object(runtime.os, 'execve') as execute:
            runtime.launch('codex', ['--version'])
            self.assertEqual(execute.call_args.args[2], {'CODEX_HOME': '/fixture/codex-home'})

    def test_account_reload_calls_app_cli_absolute_path_with_explicit_home(self):
        import sys
        import subprocess
        # Template import and subprocess doubles never change real accounts or conversations.
        sys.modules['launcher_runtime'] = runtime
        spec = importlib.util.spec_from_file_location('codex_accounts_template', ROOT / 'modules/codex-accounts/codex-account.py')
        accounts = importlib.util.module_from_spec(spec); spec.loader.exec_module(accounts)
        with patch.object(accounts, 'paseo_cli', return_value='/fixture/Paseo.app/Contents/Resources/bin/paseo'), \
             patch.object(accounts.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, '[]')) as run:
            accounts.reload_codex_agents()
            command = run.call_args.args[0]
            self.assertEqual(command[0], '/fixture/Paseo.app/Contents/Resources/bin/paseo')
            self.assertEqual(command[1:3], ['--home', str(accounts.PASEO_HOME)])
            self.assertEqual(command[3:], ['ls', '--json'])
