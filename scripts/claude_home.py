"""선택한 매뉴얼과 본체 스킬만 Claude 분리 홈에 조립한다."""
import json
from pathlib import Path


def desired(root, home, paseo_home, policy):
    directory = root/'plugin/role-workflow/shared/presets/claude-home'
    settings = json.loads((directory/'settings.json').read_text())
    decision = policy['decisions'].get('claudeHome', {})
    def merge(base, extra):
        result = dict(base)
        for key,value in extra.items():
            result[key] = merge(result.get(key, {}) if isinstance(result.get(key),dict) else {},value) if isinstance(value,dict) else value
        return result
    settings = merge(settings, decision.get('settings', {}))
    core = json.loads((directory/'skills.json').read_text())
    links = {name: home/'.claude/skills'/name for name in core if (home/'.claude/skills'/name).exists()}
    for name,source in decision.get('manuals', {}).items():
        if not name or '/' in name or name.startswith('.') or name in core:
            raise ValueError('사장 매뉴얼 이름이 올바르지 않거나 본체 스킬과 겹칩니다.')
        links[name] = Path(source).expanduser().absolute()
    return settings, links
