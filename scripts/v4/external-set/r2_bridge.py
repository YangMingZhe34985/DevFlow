"""Create a new flattened generation; never overwrite the R1 bridge identity."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import time
import uuid

SUITE=Path('.devflow/external-set-suite')

def command(args,timeout=120):
    p=subprocess.run(args,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=timeout)
    if p.returncode:raise RuntimeError(p.stderr.decode('utf-8','replace')[-1500:])
    return p.stdout

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--cases',default='X19,X21,XRJ2');args=parser.parse_args()
    for case in args.cases.split(','):
        parent=SUITE/'private/bridge'/case
        source=json.loads((parent/'image.json').read_text(encoding='utf-8'))
        directory=SUITE/'private/r2/bridges'/case;directory.mkdir(parents=True,exist_ok=True)
        if (directory/'image.json').exists():
            print(json.dumps({'caseId':case,'status':'ALREADY_BUILT'}),flush=True);continue
        cid=command(['docker','create','--name','devflow-external-r2-'+uuid.uuid4().hex[:10],
            '--label','devflow.suite=external-set','--label','devflow.role=bridge-builder-r2',
            '--network','none','--user','0:0','--entrypoint','/bin/bash',source['imageId'],'-c','sleep infinity']).decode('utf-8').strip()
        try:
            command(['docker','start',cid])
            # Remove stores/logs, not installed dependencies. Export/import below
            # removes their bytes from the final image's underlying layer too.
            script=r'''set -euo pipefail
test "$(readlink -f /testbed)" = /workspace
rm -rf -- /root/.npm /root/.cache /root/.local/share/pnpm/store /root/.pnpm-store /root/.yarn
for directory in /home/*; do
  test -d "$directory" || continue
  rm -rf -- "$directory/.npm" "$directory/.cache" "$directory/.local/share/pnpm/store" "$directory/.pnpm-store" "$directory/.yarn"
  rm -f -- "$directory/.bash_history" "$directory/.zsh_history" "$directory/.python_history"
done
rm -rf -- /tmp/*
rm -f -- /root/.bash_history /root/.zsh_history /root/.python_history /eval.sh /candidate.patch /gold.patch /patch.diff
git -C /workspace -c safe.directory=/workspace status --porcelain
'''
            (directory/'sanitize.log').write_bytes(command(['docker','exec',cid,'bash','-c',script]))
            if case=='XRJ2':
                manifest=json.loads((SUITE/'private/r2/java/cache-manifest.json').read_text(encoding='utf-8'))
                if len(manifest['allowedBootstraps'])!=1 or not manifest['artifacts']:raise RuntimeError('Java cache audit missing')
                command(['docker','cp',str((SUITE/'private/r2/java/ivyCache').resolve()),cid+':/workspace/ivyCache'])
                command(['docker','exec',cid,'chown','-R','10001:10001','/workspace/ivyCache'])
            rootfs=directory/'rootfs.tar'
            command(['docker','export','--output',str(rootfs.resolve()),cid],timeout=300)
            tag='devflow-external-set/bridge-'+case.lower()+':r2'
            image=command(['docker','import','--change','LABEL devflow.suite=external-set',
                '--change','LABEL devflow.role=solver-bridge','--change','LABEL devflow.generation=r2',
                '--change','USER 10001:10001','--change','WORKDIR /workspace','--change','ENV HOME=/home/devflow',
                '--change','ENV PATH=/usr/local/bin:/opt/miniconda3/envs/testbed/bin:/opt/miniconda3/bin:/usr/bin:/bin',
                str(rootfs.resolve()),tag],timeout=300).decode('utf-8').strip()
            with rootfs.open('rb') as handle:rootfs_sha=hashlib.file_digest(handle,'sha256').hexdigest()
            result={**source,'caseId':case,'imageId':image,'tag':tag,'parentBridge':source['imageId'],
                    'generation':'r2','rootfsBytes':rootfs.stat().st_size,'rootfsSha256':rootfs_sha,
                    'createdAt':time.time(),'cachePolicy':'Opaque package manager stores and histories removed; Java cache separately audited'}
            (directory/'image.json').write_text(json.dumps(result,indent=2),encoding='utf-8')
            for name in ['base.tar','scripted-input.json']:
                if name=='base.tar':(directory/name).write_bytes((parent/name).read_bytes())
                else:
                    payload=json.loads((parent/name).read_text(encoding='utf-8'));payload['imageId']=image
                    payload['rootfsAudit']={'passed':False,'reason':'R2 strong audit pending'}
                    (directory/name).write_text(json.dumps(payload),encoding='utf-8')
            print(json.dumps({'caseId':case,'imageId':image,'parent':source['imageId'],'rootfsBytes':rootfs.stat().st_size}),flush=True)
        finally:
            labels=json.loads(command(['docker','inspect',cid]))[0]['Config']['Labels']
            if labels.get('devflow.suite')!='external-set':raise RuntimeError('Ownership mismatch')
            command(['docker','rm','-f',cid])

if __name__=='__main__':main()
