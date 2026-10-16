"""Receipt-derived R2 checkpoint. Never substitutes four controls for a final set."""
from datetime import datetime,timezone
import hashlib
import json
from pathlib import Path
import shutil

SUITE=Path('.devflow/external-set-suite')
def read(path,default=None):return json.loads(path.read_text(encoding='utf-8')) if path.exists() else default
def write(path,value):path.write_text(json.dumps(value,ensure_ascii=False,indent=2),encoding='utf-8')
def main():
    active=read(SUITE/'private/r2/active-bridges.json',{})
    cases=[]
    for case in ['X11','X19','X21','XRJ2']:
        directory=SUITE/active[case];image=read(directory/'image.json');audit=read(directory/'rootfs-audit.json')
        fixture=read(SUITE/'public'/case/'fixture.json');profile=fixture['publicChecks']
        receipts=[read(SUITE/ref,{}) for ref in audit['privateProfileReceipts']]
        runs=[]
        for control in ['golden','empty','wrong']:
            output=SUITE/'private/stage2-runs/stage2-r2'/case/control
            result=read(output/'result.json',{});runtime=read(output/'runtime-result.json',{})
            boundary=read(output/'runtime-audit.json',{})
            expected=control=='golden'
            okay=bool(result and result.get('strictPatchPass')==expected and result.get('officialResolved')==expected
                and runtime.get('paid') is False and runtime.get('usage',{}).get('costMicros')==0
                and boundary.get('imageId')==image['imageId'] and boundary.get('network')=='none' and boundary.get('user')=='10001'
                and (control=='wrong' or runtime.get('publicValidation')=='PASS'))
            runs.append({'control':control,'passed':okay,'officialResolved':result.get('officialResolved'),
                         'strictPatchPass':result.get('strictPatchPass'),'publicValidation':runtime.get('publicValidation'),
                         'durationSeconds':result.get('durationSeconds'),'evidence':output.relative_to(SUITE).as_posix()})
        cases.append({'caseId':case,'source':fixture['source'],'imageId':image['imageId'],
                      'snapshotSha256':fixture['snapshotSha256'],'publicProfileSha256':hashlib.sha256((SUITE/'public'/case/'public-profile.json').read_bytes()).hexdigest(),
                      'publicBase3Passed':len(receipts)==4 and all(r.get('passed') for r in receipts[:3]),
                      'privateGoldProfilePassed':len(receipts)==4 and receipts[3].get('passed') is True,
                      'strongAuditPassed':audit.get('strongAuditPassed') is True,'audit':audit['strongAuditRef'],
                      'publicSources':profile['sources'],'excludedBaseTests':profile.get('excludedBaseTests',[]),
                      'publicBaseSeconds':[r.get('checkSeconds') for r in receipts[:3]],'runs':runs,
                      'controlsPassed':all(r['passed'] for r in runs)})
    complete=all(c['controlsPassed'] and c['strongAuditPassed'] and c['publicBase3Passed'] and c['privateGoldProfilePassed'] for c in cases)
    old=SUITE/'stage2-state.json';saved=SUITE/'private/r2/stage2-state-r1-preserved.json'
    if old.exists() and not saved.exists():shutil.copyfile(old,saved)
    state={'version':2,'at':datetime.now(timezone.utc).isoformat(),'freeControlGate':'PASS' if complete else 'NOT_PASSED',
           'readyForStage3':complete,'readyForLive':False,'paidModelCalls':0,'finalFrozenCount':0,'stage2QualifiedCount':sum(c['controlsPassed'] for c in cases),
           'cases':cases,'stage3':'RESOURCE_QUOTED_ONLY' if (SUITE/'private/r2/stage3-resource-plan.json').exists() else 'NOT_COMPLETED',
           'liveImplementation':'Implemented and Fake-tested; no paid requests; final manifest remains closed'}
    write(old,state)
    # An explicit incomplete delivery, not a false final freeze of four cases.
    write(SUITE/'inputs.json',{'status':'INCOMPLETE','readyForLive':False,'cases':[],'stage2PublicFixtures':[f'public/{c["caseId"]}/fixture.json' for c in cases]})
    write(SUITE/'images.json',{'status':'INCOMPLETE','readyForLive':False,'stage2Images':[{k:c[k] for k in ['caseId','imageId','snapshotSha256','audit']} for c in cases]})
    write(SUITE/'manifest.json',{'version':2,'status':'INCOMPLETE_20_TO_24_REQUIRED','readyForLive':False,'cases':[],
          'stage2QualifiedCases':[{k:c[k] for k in ['caseId','source','imageId','snapshotSha256','publicProfileSha256','publicSources','excludedBaseTests','strongAuditPassed','audit']} for c in cases],
          'finalFrozenCount':0,'remaining':'Stage3 acceptance is not completed; private grading observations are not public model inputs'})
    print(json.dumps({'readyForStage3':complete,'controlsPassed':sum(c['controlsPassed'] for c in cases),'readyForLive':False}))

if __name__=='__main__':main()
