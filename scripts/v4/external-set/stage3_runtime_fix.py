"""Normalize image startup using Dockerfile config; freshly audit the resulting image."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import uuid

SUITE=Path('.devflow/external-set-suite')
def read(p):return json.loads(p.read_text(encoding='utf-8'))
def command(args,timeout=120):
    p=subprocess.run(args,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,timeout=timeout)
    if p.returncode:raise RuntimeError(p.stdout.decode('utf-8','replace')[-1800:])
    return p.stdout
def main():
    p=argparse.ArgumentParser();p.add_argument('--case',required=True);a=p.parse_args();directory=SUITE/'private/bridge'/a.case
    image=read(directory/'image.json');before=json.loads(command(['docker','image','inspect',image['imageId']]))[0]
    if before['Config'].get('Entrypoint') in [None,[]]:return
    context=directory/'runtime-context';context.mkdir(exist_ok=True)
    (context/'Dockerfile').write_text('FROM '+image['tag']+'\nENTRYPOINT []\nCMD ["sleep", "infinity"]\nLABEL devflow.suite="external-set" devflow.role="solver-bridge"\n',encoding='utf-8')
    tag='devflow-external-set/bridge-'+a.case.lower()+':runtime-ready'
    log=command(['docker','build','--pull=false','--network','none','--tag',tag,str(context.resolve())],300)
    (directory/'runtime-build.log').write_bytes(log)
    after=json.loads(command(['docker','image','inspect',tag]))[0]
    if after['Config'].get('Entrypoint') not in [None,[]] or after['RootFS']['Layers']!=before['RootFS']['Layers']:raise RuntimeError('Runtime normalization changed filesystem or failed to clear entrypoint')
    # Verify the actual invocation SandboxManager uses, not just a metadata flag.
    command(['docker','run','--rm','--network','none','--label','devflow.suite=external-set','--label','devflow.role=runtime-contract-probe',after['Id'],'sleep','0.1'],15)
    cid=command(['docker','create','--network','none','--label','devflow.suite=external-set','--label','devflow.role=trusted-runtime-export','--entrypoint','/bin/bash',after['Id'],'-c','sleep infinity']).decode().strip()
    try:
        export=directory/'rootfs.tar'
        if export.exists():
            with export.open('rb') as h:existing_sha=hashlib.file_digest(h,'sha256').hexdigest()
            if existing_sha!=image['rootfsSha256']:raise RuntimeError('Existing export differs from immutable filesystem identity')
        else:command(['docker','export','--output',str(export.resolve()),cid],600)
        with export.open('rb') as h:sha=hashlib.file_digest(h,'sha256').hexdigest()
        (directory/'image-before-runtime-v3.json').write_text(json.dumps(image,indent=2),encoding='utf-8')
        image.update(imageId=after['Id'],tag=tag,rootfsSha256=sha,rootfsBytes=export.stat().st_size,runtimeContractVersion=3,
                     runtimePreparation={'previousImageId':before['Id'],'sameFilesystemLayers':True,'layers':after['RootFS']['Layers'],'entrypoint':after['Config'].get('Entrypoint'),'probeExitCode':0})
        (directory/'image.json').write_text(json.dumps(image,indent=2),encoding='utf-8')
        public=SUITE/'public'/a.case/'fixture.json'
        if public.exists():
            fixture=read(public);fixture['imageId']=image['imageId'];fixture['publicChecks']={'status':'NOT_CONFIGURED','checks':[]}
            public.write_text(json.dumps(fixture,ensure_ascii=False,indent=2),encoding='utf-8')
        print(json.dumps({'caseId':a.case,'runtimeContract':'PASS','imageId':after['Id']}),flush=True)
    finally:
        labels=json.loads(command(['docker','inspect',cid]))[0]['Config']['Labels']
        if labels.get('devflow.suite')!='external-set':raise RuntimeError('Ownership mismatch')
        command(['docker','rm','-f',cid])

if __name__=='__main__':main()
