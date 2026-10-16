"""Admitted phase-three pulls; failed/unknown pulls remain charged, never retried."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import time

SUITE=Path('.devflow/external-set-suite')
def read(p):return json.loads(p.read_text(encoding='utf-8'))
def write(p,v):
    temporary=p.with_suffix('.next');temporary.write_text(json.dumps(v,indent=2),encoding='utf-8')
    for retry in range(20):
        try:temporary.replace(p);return
        except PermissionError:
            if retry==19:raise
            time.sleep(0.1)
def batch(case):
    n=int(case[1:]) if case[1:].isdigit() else 24
    return 'B' if 1<=n<=5 or n==19 else 'C' if 6<=n<=10 or n==20 else 'D' if 15<=n<=18 or n in [21,22] else 'A'
def main():
    parser=argparse.ArgumentParser();parser.add_argument('--batch',choices=list('ABCD'),required=True);args=parser.parse_args()
    if (SUITE/'private/stage3'/('hold-'+args.batch+'.json')).exists():raise RuntimeError('Batch explicitly held pending previous-batch verification; no acquisition dispatched')
    if not read(SUITE/'stage2-state.json').get('readyForStage3'):raise RuntimeError('Stage2 gate required')
    plan=read(SUITE/'private/r2/stage3-resource-plan.json')
    expected_caps={'A':12*1024**3,'B':int(9.5*1024**3),'C':int(9.5*1024**3),'D':10*1024**3}
    if plan['batchCaps']!=expected_caps or plan['grandCapBytes']!=41*1024**3:raise RuntimeError('Frozen plan hard caps changed')
    ledger=SUITE/'private/bootstrap/image-acquisition.json';state=read(ledger)
    boot=SUITE/'private/bootstrap'
    tools=sum(e['bytes'] for e in read(boot/'downloads.json'))+sum(p.stat().st_size for p in (boot/'wheels').glob('*.whl'))
    for quote in plan['images']:
        if quote['batch']!=args.batch:continue
        old=next((x for x in state['images'] if x['caseId']==quote['caseId']),None)
        if old:
            if old['status']!='SETTLED':raise RuntimeError('Prior unknown pull must be reconciled, not retried')
            continue
        if not quote.get('resourceAdmitted') or quote['status']!='MANIFEST_VERIFIED':raise RuntimeError('Missing admission')
        raw=(boot/(quote['caseId']+'.manifest.json')).read_bytes()
        if hashlib.sha256(raw).hexdigest()!=quote['manifestFileSha256']:raise RuntimeError('Manifest quote changed')
        reserved=quote['compressedBytes']
        totals={b:sum(x['reservedCompressedBytes'] for x in state['images'] if batch(x['caseId'])==b) for b in 'ABCD'}
        if totals[args.batch]+reserved>plan['batchCaps'][args.batch] or sum(totals.values())+tools+reserved>plan['grandCapBytes']:raise RuntimeError('Phase3 budget insufficient')
        entry={'caseId':quote['caseId'],'pinnedReference':quote['pinnedReference'],'reservedCompressedBytes':reserved,
               'phase':3,'batch':args.batch,'status':'DISPATCHED','startedAt':time.time()}
        state['images'].append(entry);write(ledger,state)
        with (boot/('stage3-pull-'+quote['caseId']+'.log')).open('wb') as log:
            try:p=subprocess.run(['docker','pull','--platform','linux/amd64',quote['pinnedReference']],stdout=log,stderr=subprocess.STDOUT,timeout=1800)
            except subprocess.TimeoutExpired:entry['status']='FAILED_UNKNOWN_CONSUMPTION';write(ledger,state);raise
        if p.returncode:entry['status']='FAILED_UNKNOWN_CONSUMPTION';write(ledger,state);raise RuntimeError('Pull failed; reservation retained')
        image=json.loads(subprocess.check_output(['docker','image','inspect',quote['pinnedReference']]))[0]
        if image['Architecture']!='amd64' or image['Os']!='linux':raise RuntimeError('Wrong platform')
        tag=f'devflow-external-set/upstream-{quote["caseId"].lower()}:frozen'
        subprocess.run(['docker','tag',quote['pinnedReference'],tag],check=True)
        entry.update(status='SETTLED',imageId=image['Id'],repoDigests=image['RepoDigests'],uncompressedBytes=image['Size'],localTag=tag,finishedAt=time.time())
        write(ledger,state);print(json.dumps({'caseId':entry['caseId'],'status':'SETTLED','bytes':reserved}),flush=True)

if __name__=='__main__':main()
