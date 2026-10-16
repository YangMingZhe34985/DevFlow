import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT=Path(__file__).resolve().parents[2]

class UnicodeImportTests(unittest.TestCase):
    def test_import_without_artifacts_from_unicode_cwd_and_non_utf8_stdio(self):
        temporary_root=ROOT/'.devflow/external-set-suite/private/bootstrap/unit-temp'
        temporary_root.mkdir(parents=True,exist_ok=True)
        with tempfile.TemporaryDirectory(dir=temporary_root,prefix='中文-') as directory:
            source=ROOT/'scripts/v4/external-set/stage1_preflight.py'
            driver=("import importlib.util,json;from pathlib import Path;"
                    f"s=importlib.util.spec_from_file_location('preflight',{ascii(str(source))});"
                    "m=importlib.util.module_from_spec(s);s.loader.exec_module(m);"
                    "p=Path('\\u8bf4\\u660e.json');p.write_text(json.dumps({'text':'\\u4e2d\\u6587'},ensure_ascii=False),encoding='utf-8');"
                    "assert json.loads(p.read_text(encoding='utf-8'))['text']=='\\u4e2d\\u6587';print('PASS')")
            environment={**os.environ,'PYTHONUTF8':'0','PYTHONIOENCODING':'cp936','PYTHONDONTWRITEBYTECODE':'1'}
            result=subprocess.run([sys.executable,'-B','-c',driver],cwd=directory,env=environment,
                                  stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=20)
            self.assertEqual(result.returncode,0,result.stderr.decode('utf-8','replace'))
            self.assertEqual(result.stdout.strip(),b'PASS')

if __name__=='__main__':unittest.main()
