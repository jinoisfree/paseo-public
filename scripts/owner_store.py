"""사장 칸: 공용 스키마, 같은 디렉터리 임시 파일·fsync·rename, revision CAS."""
import copy
import datetime
import json
import os
from pathlib import Path
import tempfile
from airport_schema import validate_owner


def today():
    return datetime.date.today().isoformat()


def blank(kind):
    value = {'version': 1, 'revision': 0}
    if kind == 'policy':
        value.update(roleWorkflow={}, notifications={}, decisions={
            'roleWorkflow': {'date': today()}, 'notifications': {'date': today()}})
    return value


def read_owner(file, kind):
    try:
        value = json.loads(Path(file).read_text())
        return validate_owner(kind, value)
    except FileNotFoundError:
        return blank(kind)
    except (ValueError, OSError) as error:
        raise RuntimeError(f'사장 칸 오류: {file}. 형식을 복구한 뒤 다시 실행하세요.') from error


def atomic_bytes(file, content, mode=0o600):
    file = Path(file)
    file.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, temporary = tempfile.mkstemp(prefix='.'+file.name+'-', dir=file.parent)
    try:
        with os.fdopen(fd, 'wb') as out:
            os.fchmod(out.fileno(), mode)
            out.write(content)
            out.flush()
            os.fsync(out.fileno())
        os.replace(temporary, file)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def atomic_json(file, value):
    atomic_bytes(file, (json.dumps(value, ensure_ascii=False, indent=2)+'\n').encode())


def save_owner(file, kind, value, expected_revision):
    # Re-read immediately before writing, including writes after external CLI operations.
    current = read_owner(file, kind)
    if current['revision'] != expected_revision:
        raise RuntimeError(f'사장 칸 revision 충돌: {file}. 다시 읽고 실행하세요.')
    proposed = copy.deepcopy(value)
    proposed['revision'] = expected_revision
    validate_owner(kind, proposed)
    if proposed == current and Path(file).exists():
        return current
    proposed['revision'] += 1
    validate_owner(kind, proposed)
    atomic_json(file, proposed)
    return proposed
