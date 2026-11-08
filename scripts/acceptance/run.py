#!/usr/bin/env python3
"""C32 macOS acceptance. Real bundled CLI/launchd; isolated homes, ports and test jobs only."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import plistlib
import pwd
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(ROOT/'scripts'), str(ROOT/'modules')]
from owner_store import atomic_json, blank, save_owner
from service_runtime import Service, PREFIX
from public_runtime import node_executable

LABELS = [PREFIX+'test-a', PREFIX+'test-b']
REAL_HOME = Path(pwd.getpwuid(os.getuid()).pw_dir).resolve()


def require_scope(home, port):
    home = Path(home).resolve()
    if home == REAL_HOME or home == REAL_HOME/'.paseo' or REAL_HOME/'.paseo' in home.parents:
        raise RuntimeError('운영 홈은 수락 시험 대상으로 쓸 수 없습니다.')
    if port == 6767 or not 1024 <= port <= 65535:
        raise RuntimeError('시험 포트는 6767 이외의 비특권 포트여야 합니다.')
    return home


def clean_env(home, directory, port, bin_dir=None):
    require_scope(home, port)
    env = {k:v for k,v in os.environ.items() if not k.startswith(('PASEO_', 'CLAUDE_', 'CODEX_', 'ANTHROPIC_', 'OPENAI_'))}
    env.update(HOME=str(home), PASEO_HOME=str(directory), PASEO_LISTEN=f'127.0.0.1:{port}',
               PASEO_RELAY_ENABLED='false', PASEO_WEB_UI_ENABLED='false', PYTHONDONTWRITEBYTECODE='1',
               PASEO_PUBLIC_CONFIG=str(home/'legacy-absent.json'), XDG_CONFIG_HOME=str(home/'.config'),
               XDG_CACHE_HOME=str(home/'.cache'))
    if bin_dir: env['PATH'] = str(bin_dir)+os.pathsep+env.get('PATH','')
    return env


def snapshot():
    paths = [REAL_HOME/'.paseo/config.json', REAL_HOME/'Library/Application Support/Paseo/desktop-settings.json', REAL_HOME/'.paseo/paseo.pid', REAL_HOME/'Library/LaunchAgents']
    paths += sorted((REAL_HOME/'.paseo/owner').glob('*'))
    paths += sorted((REAL_HOME/'Library/LaunchAgents').glob('*'))
    result = {}
    for path in paths:
        if not path.exists(): result[str(path)] = {'missing':True}; continue
        stat = path.lstat()
        row = {'mtimeNs':stat.st_mtime_ns,'inode':stat.st_ino,'mode':stat.st_mode}
        if path.is_file(): row['sha256'] = hashlib.sha256(path.read_bytes()).hexdigest()
        # The live supervisor rewrites its PID heartbeat without changing its content.
        if path == REAL_HOME/'.paseo/paseo.pid': row.pop('mtimeNs')
        result[str(path)] = row
    # Only the PID values are retained; config/vault/policy secrets are never dumped.
    pid = REAL_HOME/'.paseo/paseo.pid'
    result['daemonPidValues'] = json.loads(pid.read_text()) if pid.exists() else None
    return result


class Acceptance:
    def __init__(self, output, app, port):
        self.out = output.resolve()
        for candidate in range(port,port+5): require_scope(self.out,candidate)
        protected = [REAL_HOME/'Library/LaunchAgents', REAL_HOME/'Library/Application Support/Paseo']
        if any(self.out == p or p in self.out.parents for p in protected): raise RuntimeError('운영 경로에 시험 출력을 쓰지 않습니다.')
        self.app = app.resolve(); self.cli = self.app/'Contents/Resources/bin/paseo'
        if not self.cli.is_file(): raise RuntimeError('앱 내장 CLI가 없습니다.')
        self.node = node_executable({})
        self.out.mkdir(parents=True, exist_ok=True)
        self.base = Path(tempfile.mkdtemp(prefix='paseo-acceptance-'))
        self.port = port
        self.jobs = []; self.contexts = []; self.commands = []; self.tests = []
        self.started = time.monotonic()

    def run(self, command, env=None, check=True, timeout=120):
        started = time.monotonic()
        process = subprocess.Popen(list(map(str,command)), env=env, cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, start_new_session=True)
        timed_out = False
        try:
            stdout, stderr = process.communicate(timeout=timeout)
        except subprocess.TimeoutExpired:
            timed_out = True
            os.killpg(process.pid, signal.SIGKILL)
            stdout, stderr = process.communicate()
        r = subprocess.CompletedProcess(command, 124 if timed_out else process.returncode, stdout, stderr)
        index = len(self.commands)
        (self.out/f'command-{index:03}.stdout').write_text(r.stdout)
        (self.out/f'command-{index:03}.stderr').write_text(r.stderr)
        self.commands.append({'command':list(map(str,command)), 'exitCode':r.returncode, 'seconds':time.monotonic()-started, 'stdout':f'command-{index:03}.stdout','stderr':f'command-{index:03}.stderr'})
        if timed_out: raise subprocess.TimeoutExpired(command,timeout,output=r.stdout,stderr=r.stderr)
        if check and r.returncode: raise RuntimeError(f'명령 실패({r.returncode}): command-{index:03}')
        return r

    def context(self, name, products=(), port=None):
        port = port or self.port
        require_scope(self.base/name, port)
        with socket.socket() as probe:
            probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            probe.bind(('127.0.0.1',port))
        home = self.base/name; home.mkdir(); directory = home/'.paseo'; directory.mkdir()
        env = clean_env(home, directory, port, home/'bin'); env['PASEO_PUBLIC_NODE'] = self.node
        providers = {}
        (home/'bin').mkdir()
        for product in ('claude','codex'):
            fake = home/'bin'/product
            fake.write_text('#!'+sys.executable+'\n'+(ROOT/'scripts/acceptance/fake-product.py').read_text()); fake.chmod(0o700)
            providers[product] = {'enabled':product in products, 'command':[str(fake)], 'env':{'CLAUDE_CONFIG_DIR':str(home/'claude-empty')} if product == 'claude' else {'CODEX_HOME':str(home/'codex-empty')}}
        atomic_json(directory/'config.json', {'version':1,'daemon':{'listen':f'127.0.0.1:{port}','relay':{'enabled':False}},'agents':{'providers':providers},'plugins':{}})
        vault = blank('vault'); vault['paths'] = {'app':str(self.app),'node':self.node,'python':sys.executable}
        save_owner(directory/'owner/vault.json','vault',vault,0)
        policy = blank('policy')
        policy['decisions']['core'] = {'date':'2026-01-01','value':{'daemon':{'relay':{'enabled':False}}}}
        policy['decisions']['modules'] = {file.parent.name:{'enabled':False,'date':'2026-01-01'} for file in (ROOT/'modules').glob('*/module.json')}
        save_owner(directory/'owner/policy.json','policy',policy,0)
        atomic_json(directory/'airport/install.json', {'dependenciesLock':hashlib.sha256((ROOT/'package-lock.json').read_bytes()).hexdigest()})
        ctx = {'home':home,'directory':directory,'env':env,'port':port,'pids':set()}
        self.contexts.append(ctx)
        return ctx

    def cli_run(self, ctx, *args, **kwargs):
        return self.run([self.cli,*args,'--home',ctx['directory']],env=ctx['env'],**kwargs)

    def status(self, ctx):
        result = self.cli_run(ctx,'daemon','status','--json',check=False,timeout=15)
        value = json.loads(result.stdout) if result.returncode == 0 else {}
        if value.get('connectedDaemon') != 'reachable' or value.get('listen') != f"127.0.0.1:{ctx['port']}": return {}
        if Path(value.get('home','/')).resolve() != ctx['directory'].resolve(): raise RuntimeError('잘못된 데몬 홈 응답')
        for key in ('pid','workerPid'):
            if value.get(key): ctx['pids'].add(value[key])
        return value

    def wait(self, predicate, timeout=45):
        deadline = time.monotonic()+timeout
        while time.monotonic() < deadline:
            value = predicate()
            if value: return value
            time.sleep(.25)
        raise RuntimeError('수락 조건 대기 시간 초과')

    def setup(self, ctx, *args):
        return self.run([sys.executable,'-B',ROOT/'scripts/setup.py',*args],env=ctx['env'])

    def lifecycle(self):
        rows = []
        for name, products in [('claude',['claude']),('codex',['codex']),('both',['claude','codex'])]:
            ctx = self.context(name,products)
            try:
                self.cli_run(ctx,'start','--timeout','30')
                self.wait(lambda:self.status(ctx))
                self.setup(ctx,'install','--profile','desktop')
                self.setup(ctx,'check','--json')
                self.setup(ctx,'refresh')
                catalog = json.loads(self.run([self.node,'--import','tsx',ROOT/'scripts/acceptance/catalog.mjs',f"127.0.0.1:{ctx['port']}",ctx['directory']],env=ctx['env'],timeout=40).stdout)
                if catalog['catalog'].get('error') or catalog['availability'] != {'available':True,'reason':None}: raise RuntimeError('C9 카탈로그가 제품 사용 가능을 확정하지 못함')
                available = {p['provider'] for p in catalog['catalog']['providers'] if p['available'] and p['provider'] in ('claude','codex')}
                if available != set(products): raise RuntimeError('제품 구성과 실제 카탈로그가 다름')
                zero = None
                if name == 'both':
                    account = json.loads((ctx['directory']/'config.json').read_text())
                    original = json.loads(json.dumps(account['agents']))
                    for provider in account['agents']['providers'].values(): provider['enabled'] = False
                    self.cli_run(ctx,'daemon','config','set','agents',json.dumps(account['agents']))
                    self.cli_run(ctx,'daemon','restart'); self.wait(lambda:self.status(ctx))
                    zero = json.loads(self.run([self.node,'--import','tsx',ROOT/'scripts/acceptance/catalog.mjs',f"127.0.0.1:{ctx['port']}",ctx['directory']],env=ctx['env'],timeout=40).stdout)
                    if zero['availability']['available'] or not zero['availability']['reason']: raise RuntimeError('C9 제품 0개 확정 거부 실패')
                    self.cli_run(ctx,'daemon','config','set','agents',json.dumps(original))
                    self.cli_run(ctx,'daemon','restart'); self.wait(lambda:self.status(ctx))
                self.setup(ctx,'enable','codex-accounts'); self.setup(ctx,'install','--profile','desktop')
                tool = ctx['directory']/'airport/modules/codex-accounts/codex-account.py'
                if not tool.exists(): raise RuntimeError('enable 미적용')
                self.setup(ctx,'disable','codex-accounts'); self.setup(ctx,'install','--profile','desktop')
                if tool.exists(): raise RuntimeError('disable 미적용')
                self.setup(ctx,'uninstall')
                config = json.loads((ctx['directory']/'config.json').read_text())
                if 'role-workflow' in config.get('plugins',{}): raise RuntimeError('uninstall 등록 잔재')
                rows.append({'products':products,'catalog':catalog,'zeroProducts':zero,'lifecycle':'passed'})
            finally: self.stop(ctx)
        return rows

    def service(self, ctx, label, trace):
        if label not in LABELS: raise RuntimeError('시험 외 launchd 라벨 거부')
        def runner(command, **kwargs):
            command = list(map(str,command))
            if command[0] == '/bin/launchctl':
                expected = f'gui/{os.getuid()}/{PREFIX}daemon-service'
                if command != ['/bin/launchctl','kickstart','-k',expected]: raise RuntimeError('예상하지 못한 설비 launchctl 명령')
                command[-1] = f'gui/{os.getuid()}/{label}'
            elif command[0] == '/usr/bin/osascript':
                # Observations stay in the evidence folder; no desktop notification during acceptance.
                trace.append({'notification':True}); return subprocess.CompletedProcess(command,0,stdout='',stderr='')
            elif Path(command[0]).resolve() != self.cli.resolve(): raise RuntimeError('예상하지 못한 설비 명령')
            trace.append(command)
            return self.run(command,env=ctx['env'],check=False)
        with _environment(ctx['env']): return Service(ctx['directory'],runner=runner)

    def bootstrap(self, ctx, variant):
        label = LABELS[0 if variant == 'A' else 1]
        existing = self.run(['/bin/launchctl','print',f'gui/{os.getuid()}/{label}'],check=False)
        if existing.returncode == 0: raise RuntimeError('동일 시험 라벨이 이미 있습니다. 자동으로 덮지 않습니다.')
        # Render the real module template, changing only the test label and sandbox paths.
        with _environment(ctx['env']):
            spec = importlib.util.spec_from_file_location('acceptance_setup',ROOT/'scripts/setup.py'); setup = importlib.util.module_from_spec(spec); spec.loader.exec_module(setup)
            rows = setup.module_files(['daemon-service'],ctx['home'],{'node':self.node,'python':sys.executable,'app':str(self.app),'moduleVariants':{'daemon-service':variant}})
        job = None
        for row in rows:
            if row['target'].suffix == '.plist': job = plistlib.loads(row['content']); continue
            row['target'].parent.mkdir(parents=True,exist_ok=True);row['target'].write_bytes(row['content']);row['target'].chmod(row['mode'])
        policy_file = ctx['directory']/'owner/policy.json';policy=json.loads(policy_file.read_text())
        policy['decisions']['modules']['daemon-service']={'enabled':True,'variant':variant,'date':'2026-01-01'}
        save_owner(policy_file,'policy',policy,policy['revision'])
        job['Label'] = label
        job['EnvironmentVariables'].update({k:v for k,v in ctx['env'].items() if k in ('PASEO_LISTEN','PASEO_RELAY_ENABLED','PASEO_WEB_UI_ENABLED','PYTHONDONTWRITEBYTECODE')})
        for key in ('StandardOutPath','StandardErrorPath'): Path(job[key]).parent.mkdir(parents=True,exist_ok=True)
        file = ctx['home']/(label+'.plist'); file.write_bytes(plistlib.dumps(job))
        self.jobs.append((label,file))
        self.run(['/bin/launchctl','bootstrap',f'gui/{os.getuid()}',file])
        status = self.wait(lambda:self.status(ctx))
        return label,status

    def ab(self):
        rows=[]
        for index,variant in enumerate(('A','B')):
            ctx=self.context('variant-'+variant,port=self.port+1+index)
            try:
                label,before=self.bootstrap(ctx,variant)
                pid=before['pid']
                command=self.run(['/bin/ps','-p',str(pid),'-o','command=']).stdout
                operating = snapshot()['daemonPidValues'] or {}
                pidfile = json.loads((ctx['directory']/'paseo.pid').read_text())
                parent = self.run(['/bin/ps','-p',str(before['workerPid']),'-o','ppid=']).stdout.strip()
                if (not command.strip().startswith('Paseo Supervisor') or pidfile.get('pid') != pid or
                    parent != str(pid) or pid in (os.getpid(),os.getppid(),operating.get('pid'))):
                    raise RuntimeError('시험 supervisor PID 소유 확인 실패')
                started=time.monotonic();os.kill(pid,signal.SIGKILL)
                trace=[]
                if variant=='A':
                    self.wait(lambda:not self.status(ctx),timeout=15)
                    self.service(ctx,label,trace).watchdog()
                after=self.wait(lambda:(value if (value:=self.status(ctx)) and value['pid'] != pid else None))
                rows.append({'variant':variant,'before':before['pid'],'after':after['pid'],'recoverySeconds':time.monotonic()-started,'watchdogCalls':1 if variant=='A' else 0,'trace':trace})
            finally:self.stop(ctx)
        return {'measurements':rows,'recommendation':'B','reason':'KeepAlive가 supervisor 종료를 자동 복구한다. A는 별도 watchdog 실행이 필요하다. 실제 측정값과 함께 검토한다.'}

    def update(self):
        ctx=self.context('update',port=self.port+3)
        try:
            label,before=self.bootstrap(ctx,'A')
            fake=ctx['home']/'Paseo.app';(fake/'Contents/Resources/bin').mkdir(parents=True)
            (fake/'Contents/Info.plist').write_bytes(plistlib.dumps({'CFBundleShortVersionString':'0.15.4'}))
            (fake/'Contents/Resources/bin/paseo').symlink_to(self.cli)
            vault_file=ctx['directory']/'owner/vault.json';vault=json.loads(vault_file.read_text());vault['paths']['app']=str(fake)
            save_owner(vault_file,'vault',vault,vault['revision'])
            trace=[];self.service(ctx,label,trace).update_watch()
            stop=next(i for i,c in enumerate(trace) if isinstance(c,list) and c[1:3]==['daemon','stop'])
            kick=next(i for i,c in enumerate(trace) if isinstance(c,list) and 'kickstart' in c)
            if stop>=kick:raise RuntimeError('stop → kickstart 순서 위반')
            after=self.wait(lambda:(value if (value:=self.status(ctx)) and value['pid'] != before['pid'] else None))
            return {'fakeAppVersion':'0.15.4','daemonVersion':after['daemonVersion'],'before':before['pid'],'after':after['pid'],'trace':trace}
        finally:self.stop(ctx)

    def claude(self):
        cli=shutil.which('claude')
        if not cli: raise RuntimeError('Claude CLI가 없습니다.')
        home=self.base/'claude-first-run';home.mkdir()
        env=clean_env(home,home/'.paseo',self.port+4)
        env.update(CLAUDE_CONFIG_DIR=str(home/'claude'),CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC='1',DISABLE_AUTOUPDATER='1',DISABLE_TELEMETRY='1',DISABLE_ERROR_REPORTING='1')
        # Enforce the no-keychain-read constraint even if the real CLI uses native Security APIs.
        profile='(version 1)(allow default)(deny mach-lookup (global-name-regex #"^com.apple.(security|Security|secd).*"))(deny file-read* (subpath "'+str(REAL_HOME/'Library/Keychains')+'"))'
        started=time.monotonic()
        try:
            result=self.run(['/usr/bin/sandbox-exec','-p',profile,cli,'-p','ok'],env=env,check=False,timeout=60)
            return {'exitCode':result.returncode,'seconds':time.monotonic()-started,'timeout':False,'classification':'명확한 인증 오류' if 'API key' in result.stdout+result.stderr or 'login' in (result.stdout+result.stderr).lower() else '로그 확인 필요','keychainDenied':True}
        except subprocess.TimeoutExpired:
            return {'exitCode':None,'seconds':time.monotonic()-started,'timeout':True,'classification':'60초 비대화 종료 안 됨','keychainDenied':True}

    def stop(self, ctx):
        for label,file in list(self.jobs):
            if file.parent == ctx['home']:
                self.run(['/bin/launchctl','bootout',f'gui/{os.getuid()}/{label}'],check=False)
                file.unlink(missing_ok=True);self.jobs.remove((label,file))
        self.cli_run(ctx,'daemon','stop',check=False,timeout=30)
        # Check both the port and every observed process. Never kill an unverified PID.
        self.wait(lambda:not self.port_open(ctx['port']),timeout=20)

    @staticmethod
    def port_open(port):
        with socket.socket() as s:
            s.settimeout(.3);return s.connect_ex(('127.0.0.1',port))==0

    def cleanup(self):
        errors=[]
        for ctx in self.contexts:
            try:self.stop(ctx)
            except Exception as error:errors.append(str(error))
        for label in LABELS:
            if self.run(['/bin/launchctl','print',f'gui/{os.getuid()}/{label}'],check=False).returncode == 0:errors.append('시험 라벨 잔재: '+label)
        for ctx in self.contexts:
            for pid in ctx['pids']:
                result=self.run(['/bin/ps','-p',str(pid),'-o','command='],check=False)
                if result.returncode==0:errors.append('관측한 시험 PID 잔재: '+str(pid))
        if not errors:shutil.rmtree(self.base)
        return {'errors':errors,'temporaryRoot':str(self.base),'temporaryRootRemoved':not self.base.exists(),'portsClosed':all(not self.port_open(ctx['port']) for ctx in self.contexts)}


class _environment:
    def __init__(self,env):self.env=env
    def __enter__(self):self.old=dict(os.environ);os.environ.clear();os.environ.update(self.env)
    def __exit__(self,*args):os.environ.clear();os.environ.update(self.old)


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output',type=Path,default=ROOT/'test-results/phase3/acceptance')
    parser.add_argument('--app',type=Path,default=Path('/Applications/Paseo.app'))
    parser.add_argument('--port',type=int,default=6799)
    parser.add_argument('--only',choices=['lifecycle','ab','update','claude'])
    args=parser.parse_args()
    if sys.platform!='darwin':parser.error('macOS 실기 수락 스크립트입니다.')
    require_scope(Path(tempfile.gettempdir()),args.port)
    a=Acceptance(args.output,args.app,args.port)
    before=snapshot();atomic_json(a.out/'operating-before.json',before)
    try:
        for name in ([args.only] if args.only else ['lifecycle','ab','update','claude']):
            result=getattr(a,name)();a.tests.append({'name':name,'result':result,'passed':True})
            atomic_json(a.out/'results.json',a.tests)
    except Exception as error:
        a.tests.append({'passed':False,'error':str(error)})
    finally:
        cleanup=a.cleanup();after=snapshot();atomic_json(a.out/'operating-after.json',after)
        result={'tests':a.tests,'cleanup':cleanup,'operatingUnchanged':before==after,'commands':a.commands}
        atomic_json(a.out/'verification.json',result)
        print(json.dumps({'tests':a.tests,'cleanup':cleanup,'operatingUnchanged':before==after},ensure_ascii=False))
    return 0 if all(t['passed'] for t in a.tests) and before==after and not cleanup['errors'] else 1


if __name__=='__main__':sys.exit(main())
