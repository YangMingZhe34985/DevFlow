import base64
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[2]
SPEC=importlib.util.spec_from_file_location('strong_audit',ROOT/'scripts/v4/external-set/strong_audit.py')
AUDIT=importlib.util.module_from_spec(SPEC);SPEC.loader.exec_module(AUDIT)

class StrongAuditTests(unittest.TestCase):
    def test_link_audit_uses_one_batched_operation_not_one_container_per_link(self):
        for links in [[],[{'path':f'workspace/node_modules/p{i}','expectedDirectory':f'/workspace/p{i}'} for i in range(100)]]:
            with patch.object(AUDIT,'command',return_value=b'[]') as command:
                self.assertEqual(AUDIT.resolve_workspace_links('sha256:example',links),[])
                command.assert_called_once()
                self.assertEqual(json.loads(command.call_args.kwargs['input']),links)
    def snapshot(self):
        data=json.dumps({'name':'sample','version':'1.0.0'}).encode('utf-8')
        return {'files':[{'path':'package.json','kind':'FILE','sha256':hashlib.sha256(data).hexdigest(),
                          'contentBase64':base64.b64encode(data).decode('ascii')}]}
    def scan(self,files,hardlinks=None,repo='org/sample'):
        root=ROOT/'.devflow/external-set-suite/private/bootstrap/unit-temp';root.mkdir(parents=True,exist_ok=True)
        with tempfile.TemporaryDirectory(dir=root) as temporary:
            path=Path(temporary)/'rootfs.tar'
            with tarfile.open(path,'w') as archive:
                for name,data in files.items():
                    info=tarfile.TarInfo(name);info.size=len(data);archive.addfile(info,io.BytesIO(data))
                for name,target in (hardlinks or {}).items():
                    info=tarfile.TarInfo(name);info.type=tarfile.LNKTYPE;info.linkname=target;archive.addfile(info)
            return AUDIT.scan_rootfs(path,repo,self.snapshot(),[b'private test marker that must not exist'])
    def test_published_own_project_copy_is_rejected(self):
        data=json.dumps({'name':'sample','version':'9.0.0'}).encode('utf-8')
        result=self.scan({'workspace/node_modules/sample/package.json':data})
        self.assertIn('OWN_PROJECT_PUBLISHED_NODE_COPY',[x['reason'] for x in result['dependencyFindings']])
    def test_hardlink_metadata_cannot_hide_own_project_copy(self):
        data=json.dumps({'name':'sample','version':'9.0.0'}).encode('utf-8')
        result=self.scan({'workspace/node_modules/a/package.json':data},
                         {'workspace/node_modules/b/package.json':'workspace/node_modules/a/package.json'})
        self.assertIn('OWN_PROJECT_HARDLINK_COPY',[x['reason'] for x in result['dependencyFindings']])
    def test_editable_install_must_target_workspace(self):
        bad=self.scan({'opt/env/site-packages/sample.egg-link':b'/outside\n'})
        self.assertTrue(bad['dependencyFindings'])
        good=self.scan({'opt/env/site-packages/sample.egg-link':b'/testbed\n'})
        self.assertFalse(good['dependencyFindings'])
    def test_pep660_and_pth_must_target_current_workspace(self):
        outside=json.dumps({'url':'file:///outside','dir_info':{'editable':True}}).encode('utf-8')
        result=self.scan({'opt/env/site-packages/sample-1.0.dist-info/direct_url.json':outside,
                          'opt/env/site-packages/__editable__.sample.pth':b'/outside\n'})
        reasons={x['reason'] for x in result['dependencyFindings']}
        self.assertIn('DIRECT_URL_NOT_WORKSPACE_EDITABLE',reasons)
        self.assertIn('PTH_NOT_WORKSPACE',reasons)
    def test_pytest_private_module_copy_is_not_missed(self):
        bad=self.scan({'opt/env/site-packages/_pytest/main.py':b'code'},repo='pytest-dev/pytest')
        self.assertTrue(bad['dependencyFindings'])
        third_party=self.scan({'opt/env/site-packages/py.py':b'independent dependency'},repo='pytest-dev/pytest')
        self.assertFalse(third_party['dependencyFindings'])
    def test_cache_and_evaluation_entrypoints_block_freeze(self):
        result=self.scan({'root/.npm/_cacache/blob':b'opaque','eval.sh':b'command'})
        reasons={x['reason'] for x in result['residueFindings']}
        self.assertIn('OPAQUE_PACKAGE_CACHE_NOT_CLEARED',reasons)
        self.assertIn('PRIVATE_ENTRYPOINT_OR_HISTORY',reasons)
    def test_added_file_requires_absence_and_existing_file_has_full_sha(self):
        result=AUDIT.workspace_expectations(self.snapshot(),['package.json','added.ts'])
        self.assertEqual(result[0]['sha256'],self.snapshot()['files'][0]['sha256'])
        self.assertEqual(result[1],{'path':'added.ts','kind':'ABSENT'})
    def test_approval_bit_does_not_override_future_or_unknown_release_date(self):
        proof={'approved':True,'publication':'2024-01-01T00:00:00Z','baseDate':'2023-01-01T00:00:00+00:00'}
        self.assertFalse(AUDIT.valid_release_proof(proof))
        proof['publication']='2022-01-01T00:00:00Z';self.assertTrue(AUDIT.valid_release_proof(proof))
        del proof['publication'];self.assertFalse(AUDIT.valid_release_proof(proof))

if __name__=='__main__':unittest.main()
