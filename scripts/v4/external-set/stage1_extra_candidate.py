"""Register a same-dataset replacement before any model evaluation."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import sys

SUITE=Path('.devflow/external-set-suite')
sys.path.insert(0,str((SUITE/'private/tool-packages').resolve()))
import pyarrow.parquet as pq

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--instance',required=True)
    parser.add_argument('--alias',required=True)
    parser.add_argument('--reason',required=True)
    args=parser.parse_args()
    if not re.fullmatch(r'[A-Z][A-Z0-9]{2,10}',args.alias):raise ValueError('Invalid alias')
    boot=SUITE/'private/bootstrap'
    records=pq.read_table(boot/'SWE-bench_Multilingual.parquet').to_pylist()
    record=next(r for r in records if r['instance_id']==args.instance)
    if record['log_parser'] not in ['parse_log_maven','parse_log_ant','parse_log_gradle_custom'] or not record['FAIL_TO_PASS'] or not record['PASS_TO_PASS']:
        raise ValueError('Replacement must have a Java parser and nonempty F2P/P2P')
    private=SUITE/'private'/args.instance;private.mkdir(exist_ok=True)
    (private/'record.json').write_text(json.dumps(record,ensure_ascii=False,indent=2),encoding='utf-8',newline='\n')
    for field,name in [('patch','gold.patch'),('test_patch','test.patch'),('eval_script','eval.sh')]:
        (private/name).write_text(record[field],encoding='utf-8',newline='\n')
    catalog=json.loads((SUITE/'stage1-candidates.json').read_text(encoding='utf-8'))
    if any(c['caseId']==args.alias or c['instanceId']==args.instance for c in catalog['candidates']):
        raise ValueError('Replacement alias or instance already registered')
    catalog['candidates'].append({'caseId':args.alias,'instanceId':args.instance,'dataset':'SWE-bench/SWE-bench_Multilingual',
        'datasetRevision':json.loads((boot/'SWE-bench_Multilingual.metadata.json').read_text(encoding='utf-8'))['sha'],
        'repo':record['repo'],'baseCommit':record['base_commit'],'image':record['image'],'language':'Java',
        'difficulty':'INFERRED_PENDING','failToPassCount':len(record['FAIL_TO_PASS']),'passToPassCount':len(record['PASS_TO_PASS']),
        'recordSha256':hashlib.sha256((private/'record.json').read_bytes()).hexdigest(),'status':'REPLACEMENT_CANDIDATE',
        'replacementReason':args.reason})
    (SUITE/'stage1-candidates.json').write_text(json.dumps(catalog,indent=2),encoding='utf-8')
    print(json.dumps({'alias':args.alias,'instance':args.instance,'reason':args.reason}))

if __name__=='__main__':main()
