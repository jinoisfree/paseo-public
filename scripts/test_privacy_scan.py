import importlib.util
from pathlib import Path
import unittest

spec=importlib.util.spec_from_file_location('privacy',Path(__file__).with_name('privacy_scan.py'))
privacy=importlib.util.module_from_spec(spec);spec.loader.exec_module(privacy)


class PrivacyTests(unittest.TestCase):
    def test_reserved_examples_are_listed_and_other_emails_are_blocked(self):
        issues,allowed=privacy.scan('fixture@example.invalid')
        self.assertEqual(issues,[]);self.assertEqual(allowed[0]['kind'],'reserved-example-email')
        issues,_=privacy.scan('person@'+'service.'+'test')
        self.assertEqual(issues[0]['kind'],'email')

    def test_private_paths_network_and_key_shapes_are_blocked(self):
        values=[('/'+'Users'+'/fixture','personal-path'),('100.'+'70.1.2','ip-address'),
                ('192.'+'168.1.2','ip-address'),('sk-'+'a'*32,'credential-pattern'),
                ('xoxc-'+'a'*20,'credential-pattern'),('Expo'+'PushToken['+'fixture-value'+']','credential-pattern')]
        for value,kind in values:
            issues,_=privacy.scan(value)
            self.assertTrue(any(issue['kind']==kind for issue in issues))

    def test_loopback_is_allowed_but_hostnames_and_local_deny_values_are_blocked(self):
        issues,allowed=privacy.scan('127.0.0.1')
        self.assertEqual(issues,[]);self.assertEqual(allowed[0]['kind'],'loopback-or-bind-address')
        issues,_=privacy.scan('fixture'+'.local')
        self.assertEqual(issues[0]['kind'],'local-hostname')
        issues,_=privacy.scan('sample-private-identifier',['sample-private-identifier'])
        self.assertEqual(issues[0]['kind'],'private-deny-list')


if __name__=='__main__':unittest.main()
