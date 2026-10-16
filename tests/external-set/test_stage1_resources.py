import importlib.util
from pathlib import Path
import unittest

module_path=Path(__file__).resolve().parents[2]/'scripts/v4/external-set/stage1_resources.py'
spec=importlib.util.spec_from_file_location('resources',module_path)
resources=importlib.util.module_from_spec(spec)
spec.loader.exec_module(resources)

class ResourceTests(unittest.TestCase):
    def manifest(self):
        return {'config':{'digest':'sha256:'+'a'*64,'size':10},'layers':[{'digest':'sha256:'+'b'*64,'size':90}]}
    def test_exact_budget_boundary(self):
        q=resources.admit(resources.estimate_manifest(self.manifest()),{},100,100)
        self.assertTrue(q['admitted'])
    def test_per_image_limit_even_with_cached_layers(self):
        q=resources.admit(resources.estimate_manifest(self.manifest()),{'sha256:'+'b'*64:90},99,100)
        self.assertFalse(q['admitted'])
        self.assertEqual(q['reason'],'PER_IMAGE_CAP')
    def test_incremental_dedup(self):
        q=resources.admit(resources.estimate_manifest(self.manifest()),{'sha256:'+'b'*64:90},100,10)
        self.assertEqual(q['incrementalBytes'],10)
        self.assertTrue(q['admitted'])
    def test_batch_limit(self):
        self.assertFalse(resources.admit(resources.estimate_manifest(self.manifest()),{},100,99)['admitted'])
    def test_missing_manifest_fails_closed(self):
        with self.assertRaises(ValueError):resources.estimate_manifest({})
    def test_index_requires_platform_selection(self):
        with self.assertRaises(ValueError):resources.estimate_manifest({'manifests':[]})
    def test_invalid_size(self):
        m=self.manifest();m['layers'][0]['size']=-1
        with self.assertRaises(ValueError):resources.estimate_manifest(m)
    def test_boolean_size_rejected(self):
        m=self.manifest();m['layers'][0]['size']=True
        with self.assertRaises(ValueError):resources.estimate_manifest(m)
    def test_conflicting_identity(self):
        m=self.manifest();m['layers'].append({'digest':'sha256:'+'b'*64,'size':91})
        with self.assertRaises(ValueError):resources.estimate_manifest(m)

if __name__=='__main__':unittest.main()
