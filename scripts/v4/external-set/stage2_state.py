"""Summarize only completed free controls; no automatic live enablement."""
import json
from datetime import datetime, timezone
from pathlib import Path

SUITE=Path('.devflow/external-set-suite')

def read(path,default=None):
    return json.loads(path.read_text(encoding='utf-8')) if path.exists() else default

def main():
    cases=[]
    for case in ['X11','X19','X21','XRJ2']:
        runs=[]
        for control in ['golden','empty','wrong']:
            directory=SUITE/'private/stage2-runs/stage2-v1'/case/control
            score=read(directory/'score.json')
            audit=read(directory/'runtime-audit.json')
            runtime=read(directory/'runtime-result.json')
            raw=read(SUITE/f'private/preflight/stage2-v1-{control}'/case/'bridge-1/result.json',{})
            expected=control=='golden'
            passed=bool(score and score['strictPatchPass']==expected and score['officialResolved']==expected
                        and audit and audit['network']=='none' and audit['user']=='10001'
                        and audit['distinctTrees']==1 and audit['privateMatches']==0
                        and runtime and runtime['usage']['modelCalls']>0
                        and runtime['usage']['costMicros']==0)
            runs.append({'control':control,'expectedStrict':expected,'passed':passed,'score':score,
                         'durationSeconds':raw.get('durationSeconds'),
                         'modelCalls':runtime['usage']['modelCalls'] if runtime else None})
        image=read(SUITE/'private/bridge'/case/'image.json',{})
        audit=read(SUITE/'private/bridge'/case/'rootfs-audit.json',{})
        snapshot=read(SUITE/'public'/case/'snapshot.json',{})
        cases.append({'caseId':case,'controlsPassed':all(r['passed'] for r in runs),'runs':runs,
                      'imageId':image.get('imageId'),'snapshotFiles':len(snapshot.get('files',[])),
                      'snapshotBytes':snapshot.get('totalBytes'),'rootfsAuditPassed':audit.get('passed'),
                      'auditedBytes':audit.get('bytesScanned')})
    summary={'version':1,'at':datetime.now(timezone.utc).isoformat(),
             'freeControlGate':'PASS' if all(c['controlsPassed'] for c in cases) else 'NOT_PASSED',
             'cases':cases,'readyForLive':False,'paidModelCalls':0,
             'publicProfileProbes':{case:read(SUITE/'private/bootstrap'/f'public-profile-{case}.json')
                                    for case in ['X11','X19','X21','XRJ2']},
             'pythonCorrectInterpreter':read(SUITE/'private/bootstrap/public-profile-X11-correct-interpreter.json'),
             'pythonUpstreamComparison':read(SUITE/'private/bootstrap/public-profile-X11-upstream-comparison.json'),
             'limitations':['Live flag is recognized but deliberately disabled; spending authorization and final manifest not implemented',
                            'Public project checks remain NOT_CONFIGURED; independent official checks are not fed to the solver',
                            'Full 20–24-case preparation and acceptance not performed']}
    (SUITE/'stage2-state.json').write_text(json.dumps(summary,indent=2),encoding='utf-8')
    print(json.dumps({'freeControlGate':summary['freeControlGate'],'casesPassed':sum(c['controlsPassed'] for c in cases),'readyForLive':False}))

if __name__=='__main__':main()
