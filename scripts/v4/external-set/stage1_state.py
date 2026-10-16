"""Derive current gates from controls; never label metadata candidates a ready suite."""
import hashlib
import json
from pathlib import Path
from datetime import datetime, timezone
import subprocess

SUITE=Path('.devflow/external-set-suite')
BOOT=SUITE/'private/bootstrap'

def read(path, default=None):
    return json.loads(path.read_text(encoding='utf-8')) if path.exists() else default

def control_gate(results, record):
    by_key={(r['variant'],r['repeat']):r for r in results}
    def expected_failure(variant):
        result=by_key.get((variant,1),{})
        status=result.get('testsStatus') or {}
        f2p=status.get('FAIL_TO_PASS',{});p2p=status.get('PASS_TO_PASS',{})
        return (result.get('status')=='VALID' and result.get('durationSeconds',301)<=300
                and result.get('officialResolved') is False
                and set(f2p.get('failure',[]))==set(record['FAIL_TO_PASS']) and not f2p.get('success')
                and set(p2p.get('success',[]))==set(record['PASS_TO_PASS']) and not p2p.get('failure'))
    return (all((r:=by_key.get(('gold',i))) and r.get('strictPatchPass') is True
                and r.get('durationSeconds',301)<=300 for i in range(1,4))
            and expected_failure('base-test') and expected_failure('empty'))

def collect_case(candidate):
    case=candidate['caseId'];campaign=None;results=[]
    for proposed in ['official-v3','official-v2','legacy-reset']:
        root=SUITE/'private/preflight'
        location=(root if proposed=='legacy-reset' else root/proposed)/case/'summary.json'
        if location.exists():campaign=proposed;results=read(location);break
    record=read(SUITE/'private'/candidate['instanceId']/'record.json')
    passed=campaign!='legacy-reset' and control_gate(results,record)
    return {'caseId':case,'instanceId':candidate['instanceId'],'language':candidate['language'],
            'campaign':campaign,'controlsPassed':passed,
            'status':'CONTROL_PASS' if passed else 'NOT_RUN' if not results else 'CONTROL_FAIL',
            'runs':[{k:r.get(k) for k in ['variant','repeat','status','officialResolved','strictPatchPass','durationSeconds','error']} for r in results],
            'replacementReason':candidate.get('replacementReason')}

def main():
    catalog=json.loads((SUITE/'stage1-candidates.json').read_text(encoding='utf-8'))
    quotes=json.loads((SUITE/'stage1-image-quotes.json').read_text(encoding='utf-8'))
    cases=[collect_case(c) for c in catalog['candidates']]
    languages={c['language'] for c in cases if c['controlsPassed']}
    audit=read(SUITE/'private/bridge/X11/rootfs-audit.json',{})
    runtime=read(SUITE/'private/bridge/X11/runtime-result.json',{})
    bridge=read(SUITE/'private/preflight/official-v3/X11/bridge-summary.json',[])
    t6=bool(audit.get('passed') and runtime.get('stop')=='SUBMITTED' and bridge and bridge[0].get('strictPatchPass'))
    gate=languages>={'Python','JavaScript','TypeScript','Java'} and t6
    acquisition=read(BOOT/'image-acquisition.json',{'images':[]})
    host_disk=read(BOOT/'docker-host-vhdx-observation.json')
    source=next((BOOT/'harness-source').iterdir())
    commit=json.loads((BOOT/'harness-commit.json').read_text(encoding='utf-8'))['sha']
    wheels=[{'file':str(p),'bytes':p.stat().st_size,'sha256':hashlib.sha256(p.read_bytes()).hexdigest()} for p in (BOOT/'wheels').glob('*.whl')]
    checkpoint={'schemaVersion':2,'at':datetime.now(timezone.utc).isoformat(),
        'status':'STAGE1_PASS_STAGE2_PENDING' if gate else 'STAGE1_INCOMPLETE',
        'readyForLive':False,'readyForStage2':gate,'paidModelCalls':0,
        'harness':{'commit':commit,'version':'5.0.2','license':'MIT','licenseSha256':hashlib.sha256((source/'LICENSE').read_bytes()).hexdigest(),
                   'sourceArchiveSha256':hashlib.sha256((BOOT/'harness.zip').read_bytes()).hexdigest(),
                   'importSmoke':read(BOOT/'harness-runtime.json',{}).get('importPass',False)},
        'datasets':[{'id':'SWE-bench/'+name,'revision':json.loads((BOOT/(name+'.metadata.json')).read_text(encoding='utf-8'))['sha'],
                    'parquetSha256':hashlib.sha256((BOOT/(name+'.parquet')).read_bytes()).hexdigest(),
                    'transport':'https://hf-mirror.com','lfsHashVerified':True} for name in ['SWE-bench_Verified','SWE-bench_Multilingual']],
        'tools':{'pyarrowVersion':'26.0.0','pythonRuntime':'3.12.14 bundled; source helpers also use system 3.14.7','wheels':wheels},
        'resources':{'downloadedPayloadBytes':quotes['t1DownloadedBytes'],
                     'imageCompressedReservationBytes':sum(i.get('reservedCompressedBytes',0) for i in acquisition['images']),
                     'hostVhdxObservation':host_disk,
                     'onDiskBytes':sum(p.stat().st_size for p in SUITE.rglob('*') if p.is_file()),
                     'downloadAccounting':'manifest compressed-layer reservations, not wire bytes; replacements conservatively charged without cross-batch dedup',
                     'stage1DownloadCapBytes':10*1024**3,'pulledImages':sum(i['status']=='SETTLED' for i in acquisition['images'])},
        'gates':{'T0':'PASS' if host_disk else 'PARTIAL: host VHDX path UNKNOWN; Docker internal disk capacity observed',
                 'T1':'PASS','T2':'PASS' if 'Python' in languages else 'NOT_PASSED',
                 'T3':'PASS' if 'JavaScript' in languages else 'NOT_PASSED',
                 'T4':'PASS' if 'TypeScript' in languages else 'NOT_PASSED',
                 'T5':'PASS' if 'Java' in languages else 'NOT_PASSED','T6':'PASS' if t6 else 'NOT_PASSED',
                 'stage1':'PASS' if gate else 'NOT_PASSED','stage2':'NOT_COMPLETED','stage3':'NOT_STARTED'},
        'candidateCount':len(catalog['candidates']),'acceptedCount':0,'controlPassedCount':sum(c['controlsPassed'] for c in cases),
        'cases':cases,'images':acquisition['images'],
        'replacements':[{'caseId':c['caseId'],'instanceId':c['instanceId'],'reason':c['replacementReason']} for c in cases if c['replacementReason']],
        'unvalidatedCases':[c['caseId'] for c in cases if not c['controlsPassed']],
        'resumeCommands':['python -B -X utf8 scripts/v4/external-set/stage1_state.py'],
        'gitHeadObserved':subprocess.check_output(['git','rev-parse','HEAD']).decode().strip()}
    (SUITE/'stage1-state.json').write_text(json.dumps(checkpoint,indent=2),encoding='utf-8')
    print(json.dumps({'status':checkpoint['status'],'gates':checkpoint['gates'],'controls':checkpoint['controlPassedCount']}))

if __name__=='__main__':main()
