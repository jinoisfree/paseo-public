"""공항의 공용 JSON Schema를 읽는 읽기 전용 검증 함수 (외부 의존성 없음).

이 저장소 스키마가 사용하는 키워드만 구현한다. 지원하지 않는 키워드는 실패한다.
오류에 값·비밀을 포함하지 않는다. 플러그인 연결·설치·이관은 별도 단계다.
"""
from datetime import date
import json
from pathlib import Path
import re

SCHEMAS = Path(__file__).resolve().parents[1] / 'plugin/role-workflow/shared/presets/schemas'
KEYWORDS = {'$schema', 'title', 'description', 'type', 'properties', 'required',
            'additionalProperties', 'items', 'uniqueItems', 'enum', 'const',
            'minimum', 'maximum', 'minLength', 'pattern', 'format'}


def validate_schema(value, schema, path='$'):
    """Schema의 제한된 어휘를 적용하고 한국어 ValueError를 낸다."""
    unknown = schema.keys() - KEYWORDS
    if unknown:
        raise ValueError(f'{path}: 지원하지 않는 스키마 키워드: {", ".join(sorted(unknown))}')
    def fail(message):
        raise ValueError(f'{path}: {message}')
    kind = schema.get('type')
    types = {'object': lambda x: isinstance(x, dict), 'array': lambda x: isinstance(x, list),
             'string': lambda x: isinstance(x, str), 'integer': lambda x: type(x) is int,
             'boolean': lambda x: type(x) is bool}
    if kind and (kind not in types or not types[kind](value)):
        fail(f'{kind} 형식이어야 합니다')
    if 'const' in schema and (type(value) is not type(schema['const']) or value != schema['const']):
        fail('지원하지 않는 고정값입니다')
    if 'enum' in schema and value not in schema['enum']:
        fail('허용 목록에 없는 값입니다')
    if kind == 'object':
        if any(k not in value for k in schema.get('required', [])):
            fail('필수 항목이 누락되었습니다')
        props = schema.get('properties', {})
        extra = schema.get('additionalProperties', True)
        for key, item in value.items():
            if key in props:
                validate_schema(item, props[key], f'{path}.{key}')
            elif extra is False:
                fail('알 수 없는 항목이 있습니다')
            elif isinstance(extra, dict):
                validate_schema(item, extra, f'{path}.*')
    if kind == 'array':
        if schema.get('uniqueItems') and len({json.dumps(x, sort_keys=True) for x in value}) != len(value):
            fail('중복 항목이 있습니다')
        for i, item in enumerate(value):
            validate_schema(item, schema.get('items', {}), f'{path}[{i}]')
    if kind == 'integer':
        if 'minimum' in schema and value < schema['minimum']:
            fail('최솟값보다 작습니다')
        if 'maximum' in schema and value > schema['maximum']:
            fail('최댓값보다 큽니다')
    if kind == 'string':
        if len(value) < schema.get('minLength', 0):
            fail('문자열이 너무 짧습니다')
        if 'pattern' in schema and not re.search(schema['pattern'], value):
            fail('문자열 형식이 올바르지 않습니다')
        if schema.get('format') == 'date':
            try:
                if not re.fullmatch(r'\d{4}-\d{2}-\d{2}', value):
                    raise ValueError()
                date.fromisoformat(value)
            except ValueError:
                fail('날짜는 유효한 YYYY-MM-DD여야 합니다')
        elif 'format' in schema:
            fail('지원하지 않는 형식입니다')
    return value


def validate_owner(kind, value):
    if kind not in ('vault', 'policy'):
        raise ValueError('금고(vault) 또는 지시서(policy)를 지정하세요')
    schema = json.loads((SCHEMAS / f'{kind}.schema.json').read_text())
    return validate_schema(value, schema)
