import base64
import copy
import hashlib
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[2]
def module(name):
    spec=importlib.util.spec_from_file_location(name,ROOT/'scripts/v4/external-set'/f'{name}.py')
    m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m
FREEZE=module('stage3_freeze');PROFILES=module('stage3_profiles');ACQUIRE=module('stage3_acquire')
METADATA=module('stage3_build_metadata')
PREFLIGHT=module('stage1_preflight')

class StageThreeTests(unittest.TestCase):
    def test_base_materialization_preserves_instrumentation_and_checks_tree(self):
        with patch.object(PREFLIGHT,'command') as command:
            result=PREFLIGHT.ensure_base_source('cid','base','head','tree','tree',True)
            self.assertFalse(result['materializedBase']);command.assert_not_called()
        with patch.object(PREFLIGHT,'command',return_value=b' M build.xml\n') as command:
            with self.assertRaises(RuntimeError):PREFLIGHT.ensure_base_source('cid','base','head','tree','other',True)
            command.assert_called_once()
        with patch.object(PREFLIGHT,'command',side_effect=[b'',b'public/file.py\n',b'reset',b'tree\n']) as command:
            result=PREFLIGHT.ensure_base_source('cid','base','head','tree','other',True)
            self.assertTrue(result['materializedBase']);self.assertEqual(result['normalizedTree'],'tree')
        with patch.object(PREFLIGHT,'command',side_effect=[b'',b'tox.ini\n',b'pytest --durations 25\n',b'pytest -rA --durations 25\n']) as command:
            result=PREFLIGHT.ensure_base_source('cid','base','head','tree','other',True)
            self.assertTrue(result['reportingInstrumentationPreserved'])
            self.assertFalse(result['materializedBase'])
        with patch.object(PREFLIGHT,'command') as command:
            with self.assertRaises(RuntimeError):PREFLIGHT.ensure_base_source('cid','base','head','tree','other',False)
            command.assert_not_called()
    def test_generated_metadata_must_be_literal_and_base_bound(self):
        text="version = __version__ = '5.2.5.dev1+gaaaaaaaa'\nversion_tuple = (5,2,5,'dev1','gaaaaaaaa')\n"
        value=METADATA.extract_constants(text,'a'*40,'5.2.4-1-gaaaaaaaa')
        self.assertEqual(value['version'],'5.2.5.dev1+gaaaaaaaa')
        for bad in [text+"import os\n",text+"run_fix()\n",text.replace('gaaaaaaaa','gbbbbbbbb'),text.replace('dev1','dev12')]:
            with self.assertRaises(ValueError):METADATA.extract_constants(bad,'a'*40,'5.2.4-1-gaaaaaaaa')
    def controls(self):
        return [{'variant':v,'repeat':n,'status':'VALID','network':'none','image':'immutable',
                 'durationSeconds':10,'officialResolved':v=='gold','strictPatchPass':v=='gold'}
                for v,n in [('base-test',1),('gold',1),('gold',2),('gold',3),('empty',1)]]
    def test_all_five_distinct_controls_required(self):
        rows=self.controls();self.assertTrue(FREEZE.official_gate(rows,'immutable'))
        for mutated in [rows[:-1],rows+[rows[-1]],rows[:-1]+[rows[1]]]:self.assertFalse(FREEZE.official_gate(mutated,'immutable'))
    def test_bad_identity_network_timeout_and_verdict_reject(self):
        for key,value in [('image','different'),('network','bridge'),('durationSeconds',301),('status','ERROR'),('strictPatchPass',False)]:
            rows=self.controls();rows[1][key]=value;self.assertFalse(FREEZE.official_gate(rows,'immutable'))
    def test_public_module_selection_needs_no_private_record(self):
        files=[]
        for path,text in [('.github/workflows/test.yml','run: python -m pytest testing/\n'),('testing/test_collection.py','def test_example(): pass\n'),('testing/test_mark.py','def test_other(): pass\n')]:
            data=text.encode('utf-8');files.append({'kind':'FILE','path':path,'contentBase64':base64.b64encode(data).decode('ascii'),'sha256':hashlib.sha256(data).hexdigest()})
        fixture={'caseId':'RENAMED','source':{'repo':'pytest-dev/pytest','baseCommit':'a'*40},'task':{'description':'Collection imports wrong modules'}}
        profile=PROFILES.proposal(fixture,{'files':files})
        self.assertIn('testing/test_collection.py',profile['checks'][0]['command']['args'])
        self.assertNotIn('testing/test_mark.py',profile['checks'][0]['command']['args'])
        self.assertEqual(profile['excludedBaseTests'],[])
    def test_command_provenance_cannot_be_an_unrelated_main_function(self):
        files=[]
        for path,text in [('.ci/parse_durations_log.py','def main(): pass\n'),('README.md','Run tests with `bin/test`.\n'),('sympy/core/tests/test_subs.py','def test_example(): pass\n')]:
            data=text.encode('utf-8');files.append({'kind':'FILE','path':path,'contentBase64':base64.b64encode(data).decode('ascii'),'sha256':hashlib.sha256(data).hexdigest()})
        fixture={'caseId':'RENAMED','source':{'repo':'sympy/sympy','baseCommit':'a'*40},'task':{'description':'Substitution error'}}
        profile=PROFILES.proposal(fixture,{'files':files})
        self.assertEqual(profile['sources'][0]['path'],'README.md')
        self.assertIn('bin/test',profile['sources'][0]['quote'])
    def test_batch_boundaries_and_java_replacement_remain_charged_to_A(self):
        for case,expected in [('X11','A'),('XRJ2','A'),('X01','B'),('X19','B'),('X06','C'),('X20','C'),('X15','D'),('X22','D')]:
            self.assertEqual(ACQUIRE.batch(case),expected)

if __name__=='__main__':unittest.main()
