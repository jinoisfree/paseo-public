#!/usr/bin/env python3
"""설치 전 틀. 설정·홈 조립 없이 토큰과 CLI만 선택한다."""
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from launcher_runtime import main

if __name__ == '__main__':
    sys.exit(main("codex"))
