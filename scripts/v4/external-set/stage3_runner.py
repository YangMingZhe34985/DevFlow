"""Serial A-D batches, two bounded independent case workers, checkpoint per batch."""
import argparse
from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import subprocess
import sys

SUITE=Path('.devflow/external-set-suite')
def command(name,*args,stdout=None):
    return subprocess.run([sys.executable,'-B','-X','utf8',str(Path(__file__).with_name(name+'.py')),*args],stdout=stdout,stderr=subprocess.STDOUT).returncode
def main():
    parser=argparse.ArgumentParser();parser.add_argument('--batches',default='ABCD');args=parser.parse_args()
    if args.batches not in ['ABCD','BCD','CD','D']:raise ValueError('Batches must follow A-D order')
    plan=json.loads((SUITE/'private/r2/stage3-resource-plan.json').read_text(encoding='utf-8'))
    done=set(json.loads((SUITE/'private/r2/active-bridges.json').read_text(encoding='utf-8')))
    for batch in args.batches:
        print(json.dumps({'batch':batch,'status':'ACQUIRING'}),flush=True)
        if command('stage3_acquire','--batch',batch):raise RuntimeError('Acquisition stopped; do not advance')
        selected=[q['caseId'] for q in plan['images'] if q['batch']==batch and q['caseId'] not in done]
        def execute(case):
            with (SUITE/'private/bootstrap'/('stage3-case-'+case+'.log')).open('ab') as output:
                code=command('stage3_case','--case',case,'--batch',batch,stdout=output)
            return case,code
        with ThreadPoolExecutor(max_workers=2) as pool:results=list(pool.map(execute,selected))
        if command('stage3_freeze','--batch',batch):raise RuntimeError('Checkpoint failed')
        print(json.dumps({'batch':batch,'results':results}),flush=True)
        if any(code for _,code in results):raise RuntimeError('Builder error; fix before advancing next batch')
    if command('stage3_freeze','--batch','D','--final'):raise RuntimeError('Final freeze check failed')

if __name__=='__main__':main()
