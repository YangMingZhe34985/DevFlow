"""Harness preparation must survive preflight; these tests never invoke Docker."""
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

SOURCE=Path(__file__).resolve().parents[2]/'scripts/v4/external-set/stage1_preflight.py'
SPEC=importlib.util.spec_from_file_location('external_preflight',SOURCE)
MODULE=importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class OfficialEnvironmentTests(unittest.TestCase):
    def evaluate(self, image_tree):
        calls=[]
        def command(args, **kwargs):
            calls.append(args)
            if args[1]=='create':return b'owned-container'
            if args[1]=='inspect':return json.dumps([{'Config':{'Labels':{'devflow.suite':'external-set'}}}]).encode()
            if args[-1]=='HEAD':return b'harness-empty-commit'
            if args[-1]=='base^{tree}':return b'base-tree'
            if args[-1]=='HEAD^{tree}':return image_tree.encode()
            if args[-1]=='--porcelain':return b' M buildScripts/tests.ant.xml\n'
            return b''
        temp_root=SOURCE.parents[3]/'.devflow/external-set-suite/private/bootstrap/unit-temp'
        temp_root.mkdir(parents=True,exist_ok=True)
        with tempfile.TemporaryDirectory(dir=temp_root) as temporary:
            suite=Path(temporary)
            private=suite/'private/example';private.mkdir(parents=True)
            (private/'record.json').write_text(json.dumps({'instance_id':'example','base_commit':'base','patch':'candidate','note':'中文路径读写'},ensure_ascii=False),encoding='utf-8')
            spec=lambda _:SimpleNamespace(eval_script='official-script\n')
            grade=lambda **_: {'example':{'resolved':True,'tests_status':{'FAIL_TO_PASS':{'success':['t'],'failure':[]}}}}
            completed=subprocess.CompletedProcess([],0,b'official-output')
            with patch.object(MODULE,'SUITE',suite),patch.object(MODULE,'command',side_effect=command),patch.object(MODULE.subprocess,'run',return_value=completed):
                result=MODULE.evaluate({'caseId':'X00','instanceId':'example'},'digest','gold',1,spec,grade)
        return result,calls

    def test_harness_commit_and_worktree_instrumentation_are_preserved(self):
        result,calls=self.evaluate('base-tree')
        self.assertTrue(result['strictPatchPass'])
        self.assertIn('tests.ant.xml',result['initialWorktreeStatus'])
        self.assertEqual(result['sourceIdentity']['imageHead'],'harness-empty-commit')
        self.assertFalse(any('reset' in args for args in calls))
        self.assertTrue(any(args[1]=='rm' for args in calls))

    def test_different_committed_tree_is_rejected_and_cleaned(self):
        result,calls=self.evaluate('future-tree')
        self.assertEqual(result['status'],'ERROR')
        self.assertFalse(result['strictPatchPass'])
        self.assertFalse(any('/eval.sh' in args and 'timeout' in args for args in calls))
        self.assertTrue(any(args[1]=='rm' for args in calls))


if __name__=='__main__':unittest.main()
