"""One candidate's staged offline gates. Each receipt is immutable and resumable."""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import time
import re

SUITE=Path('.devflow/external-set-suite')
def read(p):return json.loads(p.read_text(encoding='utf-8'))
def load(name):
    spec=importlib.util.spec_from_file_location(name,Path(__file__).with_name(name+'.py'));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m
def run(name,*args):
    start=time.monotonic();print(json.dumps({'operation':name,'status':'STARTED','arguments':args}),flush=True)
    subprocess.run([sys.executable,'-B','-X','utf8',str(Path(__file__).with_name(name+'.py')),*args],check=True)
    print(json.dumps({'operation':name,'status':'COMPLETED','seconds':round(time.monotonic()-start,3)}),flush=True)
def main():
    parser=argparse.ArgumentParser();parser.add_argument('--case',required=True);parser.add_argument('--batch',choices=list('ABCD'),required=True);args=parser.parse_args()
    case=args.case
    if not re.fullmatch(r'X[A-Z0-9]+',case):raise ValueError('Invalid case identity')
    private=SUITE/'private/bridge'/case;receipts=SUITE/'private/stage3'/case;receipts.mkdir(parents=True,exist_ok=True)
    if (receipts/'accepted.json').exists() and not (private/'rootfs.tar').exists():print(json.dumps({'caseId':case,'status':'ALREADY_ACCEPTED'}));return
    campaign='stage3-'+args.batch+'-official'
    previous=SUITE/'private/preflight'/campaign/case/'summary.json'
    needs_normalization=previous.exists() and any('Official committed image tree differs' in (r.get('error') or '') for r in read(previous))
    if needs_normalization:campaign+='-normalized-reportall-v2'
    run('stage1_preflight','--cases',case,'--campaign',campaign,*(['--materialize-base','--pytest-report-all'] if needs_normalization else []))
    controls=read(SUITE/'private/preflight'/campaign/case/'summary.json')
    if not needs_normalization and any('Official committed image tree differs' in (r.get('error') or '') for r in controls):
        campaign+='-normalized-reportall-v2';run('stage1_preflight','--cases',case,'--campaign',campaign,'--materialize-base','--pytest-report-all')
        controls=read(SUITE/'private/preflight'/campaign/case/'summary.json')
    if len(controls)!=5 or any(r['status']!='VALID' or r['network']!='none' or r['durationSeconds']>300 or r['officialResolved']!=(r['variant']=='gold') for r in controls):
        (receipts/'blocked.json').write_text(json.dumps({'reason':'OFFICIAL_CONTROL_FAILED','controlsRef':'private/preflight/'+campaign+'/'+case+'/summary.json'},indent=2),encoding='utf-8');return
    run('stage1_bridge_image','--case',case)
    run('stage3_build_metadata','--case',case)
    run('stage3_runtime_fix','--case',case)
    if not (SUITE/'public'/case/'fixture.json').exists():run('stage3_snapshot','--case',case)
    image=read(private/'image.json');runtime_v2=image.get('buildMetadata',{}).get('runtimeContractVersion')==2
    runtime_v3=image.get('runtimeContractVersion')==3
    prefix='stage3-runtime-v3' if runtime_v3 else 'stage3-buildmeta-entrypoint' if runtime_v2 else 'stage3-buildmeta' if image.get('buildMetadata') else 'stage3-public'
    if not (private/'public-gate.json').exists():run('stage3_profiles','--cases',case,'--generation-prefix',prefix)
    if not (private/'public-gate.json').exists():
        (receipts/'blocked.json').write_text(json.dumps({'reason':'PUBLIC_BASE_PROFILE_NOT_PASSED'}),encoding='utf-8');return
    fixture=read(SUITE/'public'/case/'fixture.json');gate=read(private/'public-gate.json')
    profile=read(SUITE/'public'/case/f'proposed-profile-{gate["generation"]}.json')
    validation=load('profile_validate').run(case,profile,fixture['imageId'],'gold',1,gate['generation'])
    if not validation['passed']:
        (receipts/'blocked.json').write_text(json.dumps({'reason':'PRIVATE_GOLD_PROFILE_NOT_PASSED','privateEvidence':'private/r2/profiles/'+gate['generation']+'/'+case+'/gold-1/result.json'}),encoding='utf-8');return
    audit_generation='stage3-runtime-v3' if runtime_v3 else 'stage3-entrypoint' if runtime_v2 else 'stage3'
    auditfile=SUITE/'private/r2/audits'/audit_generation/case/'strong-audit.json'
    if fixture['source']['repo']=='vuejs/core' and not (SUITE/'private/r2/release-provenance'/f'{case}.json').exists():
        run('strong_audit','--cases',case,'--generation','stage3-provenance')
        run('release_provenance','--case',case,'--audit',f'private/r2/audits/stage3-provenance/{case}/strong-audit.json')
    if not auditfile.exists():run('strong_audit','--cases',case,'--generation',audit_generation)
    audit=read(auditfile)
    if not audit['passed']:
        (receipts/'blocked.json').write_text(json.dumps({'reason':'STRONG_AUDIT_NOT_PASSED','evidence':auditfile.relative_to(SUITE).as_posix()}),encoding='utf-8');return
    compatible={'passed':True,'strongAuditPassed':True,'imageId':fixture['imageId'],'gitRoots':audit['dependencies']['gitRoots'],
                'findings':[],'strongAuditRef':auditfile.relative_to(SUITE).as_posix(),'rootfsSha256':audit['rootfsSha256']}
    (private/'rootfs-audit.json').write_text(json.dumps(compatible,indent=2),encoding='utf-8')
    record_directory=SUITE/'private'/fixture['source']['instanceId']
    preparation={'caseId':case,'source':fixture['source'],'imageId':fixture['imageId'],'snapshotSha256':fixture['snapshotSha256'],
                 'publicProfileSha256':hashlib.sha256((SUITE/'public'/case/'public-profile.json').read_bytes()).hexdigest(),
                 'materializeBase':any(r.get('materializeBasePolicy') for r in controls),
                 'pytestReportAll':any(r.get('pytestReportAllPolicy') for r in controls),
                 'privateHashes':{n:hashlib.sha256((record_directory/n).read_bytes()).hexdigest() for n in ['record.json','gold.patch','test.patch','eval.sh']}}
    (record_directory/'preparation.json').write_text(json.dumps(preparation,indent=2),encoding='utf-8')
    accepted={'caseId':case,'batch':args.batch,'at':time.time(),'imageId':fixture['imageId'],'snapshotSha256':fixture['snapshotSha256'],
              'officialControls':('private/preflight/'+campaign+'/'+case+'/summary.json'),
              'profileGeneration':gate['generation'],'strongAuditRef':compatible['strongAuditRef'],'paidModelCalls':0}
    export=private/'rootfs.tar'
    if export.exists():
        with export.open('rb') as handle:digest=hashlib.file_digest(handle,'sha256').hexdigest()
        if digest!=audit['rootfsSha256']:raise RuntimeError('Cleanup SHA differs from audit')
        cleanup={'path':export.relative_to(SUITE).as_posix(),'bytes':export.stat().st_size,'sha256':digest,'audit':compatible['strongAuditRef'],'status':'VERIFIED_NOT_DELETED'}
        (receipts/'cleanup.json').write_text(json.dumps(cleanup,indent=2),encoding='utf-8')
        export.unlink();cleanup['status']='DELETED';(receipts/'cleanup.json').write_text(json.dumps(cleanup,indent=2),encoding='utf-8')
    (receipts/'accepted.json').write_text(json.dumps(accepted,indent=2),encoding='utf-8')
    print(json.dumps({'caseId':case,'status':'ACCEPTED'}),flush=True)

if __name__=='__main__':main()
