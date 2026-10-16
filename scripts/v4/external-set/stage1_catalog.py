"""Freeze the proposed candidates, keeping official scoring material private."""
import hashlib
import json
from pathlib import Path
import sys

SUITE = Path('.devflow/external-set-suite')
BOOT = SUITE/'private/bootstrap'
sys.path.insert(0, str(SUITE/'private/tool-packages'))
import pyarrow.parquet as pq

IDS = ['pytest-dev__pytest-6202','pytest-dev__pytest-6197','pytest-dev__pytest-7324',
       'pytest-dev__pytest-7490','pytest-dev__pytest-10356','sphinx-doc__sphinx-7462',
       'sphinx-doc__sphinx-7757','sphinx-doc__sphinx-8120','sphinx-doc__sphinx-9229',
       'sphinx-doc__sphinx-11510','pylint-dev__pylint-4970','pylint-dev__pylint-4661',
       'pylint-dev__pylint-6528','pylint-dev__pylint-4551','sympy__sympy-14711',
       'sympy__sympy-19495','sympy__sympy-21379','sympy__sympy-22456',
       'immutable-js__immutable-js-2005','immutable-js__immutable-js-2006',
       'vuejs__core-11589','vuejs__core-11870','google__gson-2061','google__gson-2479']

def main():
    catalog = []
    for name in ['SWE-bench_Verified','SWE-bench_Multilingual']:
        meta = json.loads((BOOT/(name+'.metadata.json')).read_text(encoding='utf-8'))
        records = pq.read_table(BOOT/(name+'.parquet')).to_pylist()
        for record in records:
            if record['instance_id'] not in IDS:
                continue
            index = IDS.index(record['instance_id'])+1
            alias = f'X{index:02}'
            private = SUITE/'private'/record['instance_id']
            private.mkdir(exist_ok=True)
            (private/'record.json').write_text(json.dumps(record, ensure_ascii=False, indent=2), encoding='utf-8', newline='\n')
            for field, filename in [('patch','gold.patch'),('test_patch','test.patch'),('eval_script','eval.sh')]:
                (private/filename).write_text(record[field], encoding='utf-8', newline='\n')
            catalog.append({'caseId':alias,'instanceId':record['instance_id'],'dataset':f'SWE-bench/{name}',
                'datasetRevision':meta['sha'],'repo':record['repo'],'baseCommit':record['base_commit'],
                'image':record['image'],'language':'Python' if index<=18 else 'JavaScript' if index<=20 else 'TypeScript' if index<=22 else 'Java',
                'difficulty':record.get('difficulty','INFERRED_PENDING'),
                'failToPassCount':len(record['FAIL_TO_PASS']),'passToPassCount':len(record['PASS_TO_PASS']),
                'recordSha256':hashlib.sha256((private/'record.json').read_bytes()).hexdigest(),
                'status':'CANDIDATE_NOT_VALIDATED'})
    catalog.sort(key=lambda r:r['caseId'])
    missing = set(IDS)-{r['instanceId'] for r in catalog}
    (SUITE/'stage1-candidates.json').write_text(json.dumps({'candidates':catalog,'missing':sorted(missing)},indent=2),encoding='utf-8')
    print(json.dumps({'candidateCount':len(catalog),'missing':sorted(missing),'preflight':[r for r in catalog if r['caseId'] in ['X11','X19','X21','X24']]}))

if __name__=='__main__':main()
