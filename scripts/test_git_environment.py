"""Language adapter; fixture Git isolation policy lives in the shared Node helper."""
import json
from pathlib import Path
import subprocess


def git_test_environment():
    helper = Path(__file__).resolve().parents[1] / 'plugin/role-workflow/tests/git-test-environment.mjs'
    return json.loads(subprocess.check_output(['node', str(helper)], text=True))
