#!/bin/sh
set -eu
PUBLIC_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
PUBLIC_PYTHON=${PASEO_PUBLIC_PYTHON:-$(command -v python3 || true)}
if [ -z "$PUBLIC_PYTHON" ]; then
  echo 'Python 3.12 이상을 설치하세요.' >&2
  exit 1
fi
PASEO_PUBLIC_PYTHON="$PUBLIC_PYTHON" PYTHONDONTWRITEBYTECODE=1 exec "$PUBLIC_PYTHON" "$PUBLIC_ROOT/scripts/setup.py" install "$@"
