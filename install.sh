#!/bin/sh
set -eu
PUBLIC_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
PUBLIC_PYTHON=${PASEO_PUBLIC_PYTHON:-$(command -v python3 || true)}
# sudo may select the older system Python. Prefer a supported stable Homebrew path.
if [ -z "${PASEO_PUBLIC_PYTHON:-}" ] && { [ -z "$PUBLIC_PYTHON" ] || ! "$PUBLIC_PYTHON" -c 'import sys; sys.exit(sys.version_info < (3, 12))'; }; then
  for PUBLIC_CANDIDATE in /opt/homebrew/bin/python3 /usr/local/bin/python3; do
    if [ -x "$PUBLIC_CANDIDATE" ] && "$PUBLIC_CANDIDATE" -c 'import sys; sys.exit(sys.version_info < (3, 12))'; then
      PUBLIC_PYTHON=$PUBLIC_CANDIDATE
      break
    fi
  done
fi
if [ -z "$PUBLIC_PYTHON" ]; then
  echo 'Python 3.12 이상을 설치하세요.' >&2
  exit 1
fi
PASEO_PUBLIC_PYTHON="$PUBLIC_PYTHON" PYTHONDONTWRITEBYTECODE=1 exec "$PUBLIC_PYTHON" "$PUBLIC_ROOT/scripts/setup.py" install "$@"
