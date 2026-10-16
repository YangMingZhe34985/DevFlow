"""Zero-model, offline reference checks using frozen official scripts and grading.

These are trusted grading containers, never solver/reviewer containers. Private
materials are copied individually and the container is destroyed on every exit.
"""
import argparse
import hashlib
import json
import re
from pathlib import Path
import subprocess
import sys
import time
import uuid

SUITE=Path('.devflow/external-set-suite')
BOOT=SUITE/'private/bootstrap'

def official_modules():
    # Unit tests can import the module from a fresh/Unicode working directory;
    # only an actual grading invocation requires the downloaded harness.
    sys.path.insert(0,str((SUITE/'private/tool-packages').resolve()))
    sys.path.insert(0,str(next((BOOT/'harness-source').iterdir()).resolve()))
    from swebench.harness.utils import make_test_spec
    from swebench.harness.grading import get_eval_report
    return make_test_spec,get_eval_report

def command(args,**kwargs):
    result=subprocess.run(args,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,timeout=45,**kwargs)
    if result.returncode:raise RuntimeError(result.stdout.decode('utf-8','replace')[-1200:])
    return result.stdout

def ensure_base_source(cid,base,head,base_tree,image_tree,materialize=False):
    identity={'baseCommit':base,'imageHead':head,'committedTree':base_tree,'materializedBase':False}
    if base_tree==image_tree:return identity
    if not materialize:raise RuntimeError('Official committed image tree differs from frozen base tree')
    tracked=command(['docker','exec',cid,'git','-C','/testbed','status','--porcelain','--untracked-files=no']).decode().strip()
    if tracked:raise RuntimeError('Cannot materialize base over unverified official tracked instrumentation')
    changed=command(['docker','exec',cid,'git','-C','/testbed','diff','--name-only',base,'HEAD']).decode().splitlines()
    reporting_only=bool(changed)
    for path in changed:
        if path not in ['tox.ini','pytest.ini','setup.cfg','pyproject.toml']:reporting_only=False;break
        original=command(['docker','exec',cid,'git','-C','/testbed','show',base+':'+path]).decode('utf-8')
        prepared=command(['docker','exec',cid,'git','-C','/testbed','show',head+':'+path]).decode('utf-8')
        if re.sub(r'\bpytest\s+-rA(?=\s|$)','pytest',prepared)!=original:reporting_only=False;break
    if reporting_only:
        identity.update(reportingInstrumentationPreserved=True,reportingFiles=changed,gradingCommittedTree=image_tree,
                        policy='Only exact pytest -rA insertion; no test selection, assertions or implementation changes')
        return identity
    command(['docker','exec',cid,'git','-C','/testbed','reset','--hard',base])
    actual=command(['docker','exec',cid,'git','-C','/testbed','rev-parse','HEAD^{tree}']).decode().strip()
    if actual!=base_tree:raise RuntimeError('Materialized source does not match immutable base tree')
    identity.update(materializedBase=True,originalCommittedTree=image_tree,originalChangedPaths=changed,normalizedTree=actual)
    return identity

def evaluate(candidate,image,variant,repeat,make_spec,grade,supplied_patch=None,campaign='official-v3',materialize_base=False,pytest_report_all=False):
    record=json.loads((SUITE/'private'/candidate['instanceId']/'record.json').read_text(encoding='utf-8'))
    directory=SUITE/'private/preflight'/campaign/candidate['caseId']/f'{variant}-{repeat}'
    directory.mkdir(parents=True,exist_ok=True)
    result_file=directory/'result.json'
    patch=supplied_patch if supplied_patch is not None else record['patch'] if variant=='gold' else ''
    if result_file.exists():
        cached=json.loads(result_file.read_text(encoding='utf-8'))
        if cached.get('image')!=image or cached.get('patchSha256')!=hashlib.sha256(patch.encode()).hexdigest():
            raise RuntimeError('Saved score identity differs; use a new evaluation directory')
        if cached.get('materializeBasePolicy',False)!=materialize_base:raise RuntimeError('Saved source preparation policy differs')
        if cached.get('pytestReportAllPolicy',False)!=pytest_report_all:raise RuntimeError('Saved test reporting policy differs')
        if (directory/'eval.sh').read_text(encoding='utf-8')!=make_spec(record).eval_script:
            raise RuntimeError('Saved official evaluation script identity differs')
        return cached
    started=time.monotonic()
    name='devflow-external-'+candidate['caseId'].lower()+'-'+uuid.uuid4().hex[:10]
    cid=None
    result={'caseId':candidate['caseId'],'variant':variant,'repeat':repeat,'status':'ERROR',
            'image':image,'network':'none','officialResolved':False,'strictPatchPass':False,'container':name,'materializeBasePolicy':materialize_base,'pytestReportAllPolicy':pytest_report_all}
    try:
        spec=make_spec(record)
        script=directory/'eval.sh'
        script.write_text(spec.eval_script,encoding='utf-8',newline='\n')
        patch_file=directory/'candidate.patch'
        patch_file.write_text(patch,encoding='utf-8',newline='\n')
        result['patchSha256']=hashlib.sha256(patch.encode()).hexdigest()
        cid=command(['docker','create','--name',name,*(['-e','PYTEST_ADDOPTS=-rA'] if pytest_report_all else []),'--label','devflow.suite=external-set',
                     '--label','devflow.role=trusted-preflight','--label','devflow.case='+candidate['caseId'],
                     '--network','none','--cpus','2','--memory','4g','--pids-limit','512',
                     '--entrypoint','/bin/bash',image,'-c','sleep infinity']).decode().strip()
        (directory/'container.json').write_text(json.dumps({'id':cid,'name':name}),encoding='utf-8')
        command(['docker','start',cid])
        head=command(['docker','exec',cid,'git','-C','/testbed','rev-parse','HEAD']).decode().strip()
        base_tree=command(['docker','exec',cid,'git','-C','/testbed','rev-parse',record['base_commit']+'^{tree}']).decode().strip()
        image_tree=command(['docker','exec',cid,'git','-C','/testbed','rev-parse','HEAD^{tree}']).decode().strip()
        result['sourceIdentity']=ensure_base_source(cid,record['base_commit'],head,base_tree,image_tree,materialize_base)
        # Official images can carry harness instrumentation as tracked working-tree
        # changes (e.g. Lombok test.instance). run_evaluation preserves these;
        # resetting here would destroy the official offline environment.
        result['initialWorktreeStatus']=command(['docker','exec',cid,'git','-C','/testbed','status','--porcelain']).decode()
        command(['docker','cp',str(script.resolve()),cid+':/eval.sh'])
        if patch:
            command(['docker','cp',str(patch_file.resolve()),cid+':/candidate.patch'])
            command(['docker','exec','-w','/testbed',cid,'git','apply','--check','/candidate.patch'])
            command(['docker','exec','-w','/testbed',cid,'git','apply','/candidate.patch'])
        remaining=max(1,int(295-(time.monotonic()-started)))
        test_start=time.monotonic()
        completed=subprocess.run(['docker','exec',cid,'timeout','--signal=TERM','--kill-after=3',str(remaining),'/bin/bash','/eval.sh'],
                                 stdout=subprocess.PIPE,stderr=subprocess.STDOUT,timeout=remaining+10)
        result['testSeconds']=round(time.monotonic()-test_start,3)
        result['exitCode']=completed.returncode
        log=directory/'test_output.txt'
        log.write_bytes(completed.stdout)
        if completed.returncode in [124,137]:
            result['status']='TIMEOUT'
        else:
            report=grade(test_spec=spec,prediction={'instance_id':record['instance_id'],
                'model_name_or_path':'external-preflight-'+variant,'model_patch':patch},
                test_log_path=str(log),include_tests_status=True)
            (directory/'official-report.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
            observed=report[record['instance_id']]
            result['officialResolved']=observed['resolved']
            result['testsStatus']=observed.get('tests_status')
            valid=bool(result['testsStatus']) and not observed.get('infra_failure')
            result['status']='VALID' if valid else 'INVALID_EVALUATION'
            result['strictPatchPass']=bool(valid and observed['resolved'])
    except (RuntimeError,subprocess.TimeoutExpired,ValueError,KeyError) as error:
        result['error']=str(error)
    finally:
        if cid:
            inspection=json.loads(command(['docker','inspect',cid]))[0]
            if inspection['Config']['Labels'].get('devflow.suite')!='external-set':
                raise RuntimeError('Cleanup ownership mismatch')
            command(['docker','rm','-f',cid])
            result['cleanup']='PASS'
        result['durationSeconds']=round(time.monotonic()-started,3)
        if result['durationSeconds']>300:
            result['strictPatchPass']=False
            result['status']='TIMEOUT'
        result_file.write_text(json.dumps(result,indent=2),encoding='utf-8')
    return result

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--cases',default='X11,X19,X21,X24')
    parser.add_argument('--patch-file')
    parser.add_argument('--campaign',default='official-v3')
    parser.add_argument('--materialize-base',action='store_true')
    parser.add_argument('--pytest-report-all',action='store_true')
    args=parser.parse_args()
    if not args.campaign.replace('-','').replace('_','').isalnum():
        raise ValueError('Unsafe campaign identity')
    make_spec,grade=official_modules()
    candidates=json.loads((SUITE/'stage1-candidates.json').read_text(encoding='utf-8'))['candidates']
    images=json.loads((BOOT/'image-acquisition.json').read_text(encoding='utf-8'))['images']
    for c in candidates:
        if c['caseId'] not in args.cases.split(','):continue
        image=next((i for i in images if i['caseId']==c['caseId'] and i['status']=='SETTLED'),None)
        if not image:continue
        results=[]
        supplied=Path(args.patch_file).read_text(encoding='utf-8') if args.patch_file else None
        for variant,repeats in ([('bridge',1)] if supplied is not None else [('base-test',1),('gold',3),('empty',1)]):
            for repeat in range(1,repeats+1):
                r=evaluate(c,image['pinnedReference'],variant,repeat,make_spec,grade,supplied,args.campaign,args.materialize_base,args.pytest_report_all)
                results.append(r)
                print(json.dumps({k:r.get(k) for k in ['caseId','variant','repeat','status','officialResolved','strictPatchPass','durationSeconds','error']}),flush=True)
                if r['status']!='VALID':break
            if results[-1]['status']!='VALID':break
        (SUITE/'private/preflight'/args.campaign/c['caseId']/('bridge-summary.json' if supplied is not None else 'summary.json')).write_text(json.dumps(results,indent=2),encoding='utf-8')

if __name__=='__main__':main()
