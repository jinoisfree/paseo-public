"""C33/D9: one manifest default; explicit choices win; B never races stop with KeepAlive."""
import json
import plistlib
import unittest
from unittest import mock
import test_equipment as fixtures
from test_equipment import setup, service_runtime
from test_acceptance import acceptance


class Phase3bTests(unittest.TestCase):
    setUp=fixtures.EquipmentTests.setUp
    load_config=fixtures.EquipmentTests.load_config
    execute=fixtures.EquipmentTests.execute
    calls=fixtures.EquipmentTests.calls
    snapshot=fixtures.EquipmentTests.snapshot
    service=fixtures.EquipmentTests.service

    def test_default_B_is_consistent_in_plan_templates_and_runtime_and_A_wins(self):
        self.execute('enable','daemon-service')
        for explicit,expected in [(None,'B'),('A','A'),('B','B')]:
            if explicit:self.execute('enable','daemon-service','--variant',explicit)
            plan=self.execute('install','--profile','server','--dry-run')[1]
            self.assertEqual(next(m['variant'] for m in plan['equipment'] if m['id']=='daemon-service'),expected)
            rows=setup.module_files(['daemon-service'],self.home,setup.Airport().module_config())
            job=next(plistlib.loads(r['content']) for r in rows if r['target'].suffix=='.plist')
            self.assertEqual(job['KeepAlive'],expected=='B')
            service,_=self.service()
            with mock.patch.object(service_runtime.os,'execve') as execute:service.daemon_service()
            args=execute.call_args.args[1]
            self.assertEqual(args[1:-2],['start'] if expected=='A' else ['daemon','run'])
        # A default change is read from the installed manifest, not a second literal in runtime.
        manifest=json.loads((self.root/'modules/daemon-service/module.json').read_text())
        self.assertEqual(manifest['defaultVariant'],'B')
        self.assertTrue(any(r['target']==(self.paseo_home/'airport/modules/daemon-service/module.json').resolve() for r in rows))

    def test_update_watch_B_only_kickstarts_once_and_A_stops_first(self):
        for explicit in (None,'A','B'):
            service,commands=self.service()
            if explicit:service.owner['decisions'].setdefault('modules', {})['daemon-service']={'variant':explicit}
            service.update_watch()
            stops=[i for i,c in enumerate(commands) if c[1:3]==['daemon','stop']]
            kicks=[i for i,c in enumerate(commands) if 'kickstart' in c]
            self.assertEqual(len(kicks),1)
            if explicit=='A':self.assertEqual(len(stops),1);self.assertLess(stops[0],kicks[0])
            else:self.assertEqual(stops,[])

    def test_shared_manifest_default_is_used_by_planner_and_runtime(self):
        manifest=self.root/'modules/daemon-service/module.json';v=json.loads(manifest.read_text());v['defaultVariant']='A';manifest.write_text(json.dumps(v))
        # Simulate another valid manifest value to expose any duplicated B literal.
        self.execute('enable','daemon-service')
        self.assertEqual(next(m['variant'] for m in setup.Airport().module_plan() if m['id']=='daemon-service'),'A')
        with mock.patch.object(service_runtime,'__file__',str(self.root/'modules/service_runtime.py')):
            service,_=self.service();self.assertEqual(service.daemon_variant(),'A')

    def test_refresh_places_default_manifest_before_bootstrapping_job(self):
        self.execute('enable','daemon-service');self.execute('install')
        manifest=self.paseo_home/'airport/modules/daemon-service/module.json'
        manifest.unlink()
        (self.home/'Library/LaunchAgents'/(setup.PREFIX+'daemon-service.plist')).unlink()
        install_agent=setup.install_agent
        def verify(label,content,home):
            self.assertEqual(json.loads(manifest.read_text())['defaultVariant'],'B')
            return install_agent(label,content,home)
        with mock.patch.object(setup,'install_agent',side_effect=verify) as installed:
            self.execute('refresh')
        self.assertTrue(installed.called)


class RestartObservationTests(unittest.TestCase):
    def samples(self,pids,jobs=None):
        return [{'at':i*.02,'pid':pid,'jobPid':(jobs or pids)[i]} for i,pid in enumerate(pids)]

    def test_exactly_one_change_ignores_receipt_gap_and_duplicate_samples(self):
        for variant in ('A','B'):
            result=acceptance.restart_observation(self.samples([10,10,None,20,20]),10,20,variant)
            self.assertEqual(result['pidChanges'],1);self.assertEqual(result['pidSequence'],[10,20])

    def test_launchd_parent_and_supervisor_child_have_separate_pid_identities(self):
        result=acceptance.restart_observation(self.samples([10,None,20],[1,None,2]),10,20,'B')
        self.assertEqual(result['pidSequence'],[10,20]);self.assertEqual(result['jobPidSequence'],[1,2])

    def test_intermediate_pid_or_launchd_only_restart_is_rejected(self):
        for values in ([10,11,20],[10,20,10,20],[10,10],[20,20]):
            with self.assertRaisesRegex(RuntimeError,'정확히 1회'):acceptance.restart_observation(self.samples(values),10,20,'A')
        with self.assertRaisesRegex(RuntimeError,'정확히 1회'):
            acceptance.restart_observation(self.samples([10,None,20],[10,15,20]),10,20,'B')

    def test_slow_sampling_cannot_claim_exactly_one_restart(self):
        samples=self.samples([10,20]);samples[-1]['at']=.5
        with self.assertRaisesRegex(RuntimeError,'250ms'):acceptance.restart_observation(samples,10,20,'B')
