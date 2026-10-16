import importlib.util
from pathlib import Path
import unittest
from copy import deepcopy

SOURCE=Path(__file__).resolve().parents[2]/'scripts/v4/external-set/stage1_state.py'
SPEC=importlib.util.spec_from_file_location('external_state',SOURCE)
MODULE=importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)

class ControlGateTests(unittest.TestCase):
    def setUp(self):
        self.record={'FAIL_TO_PASS':['new'],'PASS_TO_PASS':['old']}
        self.results=[{'variant':v,'repeat':1,'status':'VALID','officialResolved':False,'durationSeconds':10,
                       'testsStatus':{'FAIL_TO_PASS':{'success':[],'failure':['new']},'PASS_TO_PASS':{'success':['old'],'failure':[]}}}
                      for v in ['base-test','empty']]
        self.results += [{'variant':'gold','repeat':n,'strictPatchPass':True,'durationSeconds':10} for n in range(1,4)]

    def test_complete_controls_pass(self):
        self.assertTrue(MODULE.control_gate(self.results,self.record))

    def test_missing_baseline_observations_are_not_expected_failures(self):
        changed=deepcopy(self.results)
        changed[0]['testsStatus']['PASS_TO_PASS']={'success':[],'failure':['old']}
        self.assertFalse(MODULE.control_gate(changed,self.record))

    def test_missing_gold_repeat_is_not_stable(self):
        self.assertFalse(MODULE.control_gate(self.results[:-1],self.record))

    def test_over_deadline_gold_is_not_accepted(self):
        self.results[-1]['durationSeconds']=300.001
        self.assertFalse(MODULE.control_gate(self.results,self.record))

if __name__=='__main__':unittest.main()
