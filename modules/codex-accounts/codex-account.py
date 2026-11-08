#!/usr/bin/env python3
"""Paseo Codex 계정 전환.

Paseo의 Codex 제공자는 분리된 CODEX_HOME을 쓴다. 대화 기록과
설정은 그대로 두고 그 안의 auth.json 심볼릭 링크만 계정별 파일로 바꾼다.

  codex-account.py status            현재 계정과 등록된 계정 목록
  codex-account.py use <이름>        해당 계정으로 전환
  codex-account.py login <이름>      브라우저 로그인으로 계정 등록(또는 재로그인)
  codex-account.py link <이름> <경로>  기존 auth.json을 공유하는 계정 등록

토큰 값은 출력하지 않는다.
"""
import base64
import json
import os
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from launcher_runtime import find_cli, paseo_cli, owner_vault

HOME = Path.home()
PASEO_HOME = Path(os.environ.get("PASEO_HOME", HOME / ".paseo"))
ACTIVE = Path(os.environ.get("CODEX_HOME", PASEO_HOME / "codex-home")) / "auth.json"
ACCOUNTS = PASEO_HOME / "codex-accounts"


def describe(path):
    """auth.json의 이메일·요금제·갱신 시각. 읽을 수 없으면 None."""
    try:
        data = json.loads(Path(path).read_text())
        payload = data["tokens"]["id_token"].split(".")[1]
        claims = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
    except (OSError, ValueError, KeyError, IndexError, TypeError):
        return None
    return {
        "email": claims.get("email", "?"),
        "plan": claims.get("https://api.openai.com/auth", {}).get("chatgpt_plan_type", "?"),
        "last_refresh": data.get("last_refresh") or "",
    }


def profile(name):
    return ACCOUNTS / name / "auth.json"


def names():
    return sorted(name for name in owner_vault().get('codexAccounts', []) if isinstance(name, str) and name and '/' not in name and not name.startswith('.'))


def active_name():
    """활성 링크가 가리키는 등록 계정 이름. 링크가 아니거나 등록 밖이면 None."""
    if not ACTIVE.is_symlink():
        return None
    target = Path(os.readlink(ACTIVE))
    if target.name == "auth.json" and target.parent.parent == ACCOUNTS:
        return target.parent.name
    return None


def require_name(name):
    if not name or "/" in name or name.startswith("."):
        sys.exit(f"계정 이름이 올바르지 않습니다: {name!r}")
    if name not in names():
        sys.exit('금고 codexAccounts에 등록한 계정 이름을 먼저 명시하세요.')
    return name


def absorb_replaced_active():
    """Codex가 토큰 갱신 중 링크를 일반 파일로 바꿔 놓았으면 그 토큰을 원래 계정에 되돌린다."""
    if ACTIVE.is_symlink() or not ACTIVE.exists():
        return
    current = describe(ACTIVE)
    if current is None:
        sys.exit(f"{ACTIVE} 가 링크가 아닌데 내용을 읽을 수 없습니다. 직접 확인하세요.")
    for name in names():
        saved = describe(profile(name))
        if saved and saved["email"] == current["email"]:
            if current["last_refresh"] > saved["last_refresh"]:
                # 계정 파일이 다른 곳을 가리키는 링크일 수 있으므로 내용만 덮어쓴다.
                profile(name).resolve().write_bytes(ACTIVE.read_bytes())
                print(f"갱신된 토큰을 '{name}' 계정에 반영했습니다.")
            return
    sys.exit(
        f"{ACTIVE} 에 등록되지 않은 계정({current['email']})의 토큰이 있습니다.\n"
        f"먼저 보관하세요: mkdir -p {ACCOUNTS}/<이름> && mv {ACTIVE} {ACCOUNTS}/<이름>/auth.json"
    )


def cmd_status():
    current = describe(ACTIVE)
    active = active_name()
    if current:
        label = f"'{active}'" if active else "등록 밖"
        print(f"현재: {current['email']} ({current['plan']}) - {label}")
    else:
        print("현재: 로그인 정보 없음")
    if not ACTIVE.is_symlink() and ACTIVE.exists():
        print("주의: auth.json이 링크가 아닌 일반 파일입니다. 다음 use 때 정리됩니다.")
    for name in names():
        info = describe(profile(name))
        mark = "*" if name == active else " "
        detail = f"{info['email']} ({info['plan']})" if info else "로그인 필요"
        shared = f" -> {profile(name).resolve()}" if profile(name).is_symlink() else ""
        print(f" {mark} {name}: {detail}{shared}")


def cmd_use(name):
    paseo_cli()
    require_name(name)
    if name not in names():
        sys.exit(f"등록되지 않은 계정: {name} (등록: {', '.join(names()) or '없음'})")
    info = describe(profile(name))
    if info is None:
        sys.exit(f"'{name}' 계정의 로그인 정보가 없습니다. 먼저: codex-account.py login {name}")
    absorb_replaced_active()
    ACTIVE.parent.mkdir(parents=True, exist_ok=True)
    tmp = ACTIVE.with_name("auth.json.switching")
    if os.path.lexists(tmp):
        tmp.unlink()
    tmp.symlink_to(profile(name))
    os.replace(tmp, ACTIVE)
    print(f"전환 완료: {info['email']} ({info['plan']})")
    reload_codex_agents()


def reload_codex_agents():
    """Codex 프로세스는 시작할 때 읽은 로그인을 계속 쓰므로, 쉬고 있는 Codex 대화를 다시 띄운다."""
    paseo = [paseo_cli(), "--home", str(PASEO_HOME)]
    env = dict(os.environ)
    env.pop('PASEO_HOST', None)
    try:
        listed = subprocess.run(
            [*paseo, "ls", "--json"], capture_output=True, text=True, check=True, timeout=30, env=env
        )
        agents = [a for a in json.loads(listed.stdout) if str(a.get("provider", "")).startswith("codex/")]
    except (OSError, ValueError, subprocess.SubprocessError):
        print("Paseo 대화 목록을 읽지 못했습니다. 기존 Codex 대화는 직접 다시 불러와야 새 계정을 씁니다.")
        return
    reloaded, failed = 0, []
    busy = [a for a in agents if a.get("status") == "running"]
    for agent in agents:
        if agent.get("status") not in ("idle", "error"):
            continue
        try:
            subprocess.run([*paseo, "agent", "reload", agent["id"]], capture_output=True, check=True, timeout=90, env=env)
            reloaded += 1
        except (OSError, subprocess.SubprocessError):
            failed.append(agent)
    print(f"기존 Codex 대화 {reloaded}개를 새 계정으로 다시 불러왔습니다.")
    for agent in failed:
        print(f"  다시 불러오기 실패: {agent.get('shortId')} {agent.get('name')}")
    for agent in busy:
        print(f"  응답 중이라 건너뜀(기존 계정 유지): {agent.get('shortId')} {agent.get('name')}")
    if busy:
        print("  응답이 끝난 뒤 같은 use 명령을 다시 실행하면 반영됩니다.")


def cmd_login(name):
    require_name(name)
    home = ACCOUNTS / name
    if profile(name).is_symlink():
        sys.exit(f"'{name}' 은 {profile(name).resolve()} 를 공유합니다. 그 파일의 주인 앱에서 로그인하세요.")
    home.mkdir(parents=True, exist_ok=True)
    os.chmod(ACCOUNTS, 0o700)
    os.chmod(home, 0o700)
    codex = find_cli("codex")
    env = {k: v for k, v in os.environ.items() if k not in ("OPENAI_API_KEY", "CODEX_API_KEY")}
    env["CODEX_HOME"] = str(home)
    args = [codex, "-c", 'cli_auth_credentials_store="file"', "login"]
    if os.environ.get("SSH_CONNECTION"):
        # SSH로 접속한 경우 이 Mac의 브라우저를 쓸 수 없으므로 코드 입력 방식으로 로그인한다.
        args.append("--device-auth")
    subprocess.run(args, env=env, check=True)
    info = describe(profile(name))
    if info is None:
        sys.exit("로그인 후에도 auth.json을 읽을 수 없습니다.")
    print(f"'{name}' 등록: {info['email']} ({info['plan']})")


def cmd_link(name, target):
    require_name(name)
    target = Path(target).expanduser().resolve()
    if describe(target) is None:
        sys.exit(f"auth.json으로 읽을 수 없습니다: {target}")
    if os.path.lexists(profile(name)):
        sys.exit(f"'{name}' 은 이미 등록되어 있습니다.")
    (ACCOUNTS / name).mkdir(parents=True, exist_ok=True)
    os.chmod(ACCOUNTS, 0o700)
    os.chmod(ACCOUNTS / name, 0o700)
    profile(name).symlink_to(target)
    print(f"'{name}' 등록: {describe(target)['email']} -> {target}")


def main(argv):
    commands = {"status": (cmd_status, 0), "use": (cmd_use, 1), "login": (cmd_login, 1), "link": (cmd_link, 2)}
    cmd = argv[0] if argv else "status"
    if cmd not in commands or len(argv) - 1 != commands[cmd][1]:
        sys.exit(__doc__)
    commands[cmd][0](*argv[1:])


if __name__ == "__main__":
    try:
        main(sys.argv[1:])
    except ValueError as error:
        sys.exit(str(error))
