"""Reconfirm frozen profiles under the exact solver RAM/swap/CPU/PID limits."""
import argparse
from concurrent.futures import ThreadPoolExecutor
import importlib.util
import json
from pathlib import Path

SUITE=Path('.devflow/external-set-suite')
def read(p):return json.loads(p.read_text(encoding='utf-8'))
def main():
    parser=argparse.ArgumentParser();parser.add_argument('--cases');args=parser.parse_args()
    spec=importlib.util.spec_from_file_location('profiles',Path(__file__).with_name('profile_validate.py'));module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    selected=args.cases.split(',') if args.cases else [c['caseId'] for c in read(SUITE/'manifest.json')['cases']]
    def validate(case):
        fixture=read(SUITE/'public'/case/'fixture.json');profile={**fixture['publicChecks'],'status':'PROPOSED'}
        generation='stage3-resources-v1';refs=[]
        for variant,repeats in [('base',3),('gold',1)]:
            for repeat in range(1,repeats+1):
                result=module.run(case,profile,fixture['imageId'],variant,repeat,generation)
                if not result['passed'] or 'resources' not in result:raise RuntimeError('Resource-matched profile failed: '+case)
                refs.append(f'private/r2/profiles/{generation}/{case}/{variant}-{repeat}/result.json')
        directory=SUITE/'private/stage3'/case;directory.mkdir(parents=True,exist_ok=True)
        (directory/'resource-profile-receipts.json').write_text(json.dumps(refs,indent=2),encoding='utf-8')
        print(json.dumps({'caseId':case,'resourceMatchedBase3AndGold':'PASS'}),flush=True)
    with ThreadPoolExecutor(max_workers=2) as pool:list(pool.map(validate,selected))

if __name__=='__main__':main()
