"""Build a flattened, labelled X11 bridge from base bytes only (Stage-1 T6).

No task record, test patch, gold patch or evaluation script is copied into this
image. Private rootfs intermediates are retained for build reproducibility.
"""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import time
import uuid

SUITE=Path('.devflow/external-set-suite')

def command(args,timeout=120):
    p=subprocess.run(args,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,timeout=timeout)
    if p.returncode:raise RuntimeError(p.stdout.decode('utf-8','replace')[-2000:])
    return p.stdout

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--case',default='X11')
    args=parser.parse_args()
    candidates=json.loads((SUITE/'stage1-candidates.json').read_text(encoding='utf-8'))['candidates']
    c=next(c for c in candidates if c['caseId']==args.case)
    acquisition=json.loads((SUITE/'private/bootstrap/image-acquisition.json').read_text(encoding='utf-8'))
    upstream=next(i for i in acquisition['images'] if i['caseId']==args.case and i['status']=='SETTLED')
    directory=SUITE/'private/bridge'/args.case
    directory.mkdir(parents=True,exist_ok=True)
    result_path=directory/'image.json'
    if result_path.exists():
        print(result_path.read_text(encoding='utf-8'));return
    name='devflow-external-bridge-'+uuid.uuid4().hex[:10]
    cid=command(['docker','create','--name',name,'--network','none','--label','devflow.suite=external-set',
                 '--cpus','2','--memory','4g','--pids-limit','512',
                 '--label','devflow.role=bridge-builder','--entrypoint','/bin/bash',upstream['pinnedReference'],'-c','sleep infinity']).decode().strip()
    try:
        command(['docker','start',cid])
        node=SUITE/'private/bootstrap/node-seed/node'
        node_identity=json.loads((node.parent/'identity.json').read_text(encoding='utf-8'))
        if hashlib.sha256(node.read_bytes()).hexdigest()!=node_identity['binarySha256']:
            raise RuntimeError('Frozen Node binary changed')
        command(['docker','cp',str(node.resolve()),cid+':/usr/local/bin/node'])
        script=r'''set -euo pipefail
test "$1" != ""
test "$(readlink -f /testbed)" = /testbed
test ! -e /workspace
mkdir /workspace
git -C /testbed archive "$1" | tar -x -C /workspace
# Preserve installed third-party dependencies, not the old repository or build
# output. They remain inside the flat rootfs and are covered by the audit.
while IFS= read -r -d '' dependency; do
  relative="${dependency#/testbed/}"
  test ! -e "/workspace/$relative"
  mkdir -p "$(dirname "/workspace/$relative")"
  mv -- "$dependency" "/workspace/$relative"
done < <(find /testbed -type d -name node_modules -prune -print0)
if test -d /testbed/lib; then
  mkdir -p /workspace/lib
  cp -a -n /testbed/lib/. /workspace/lib/
fi
find /workspace -type f -print0 | sort -z | xargs -0 sha256sum
rm -rf -- /testbed
ln -s /workspace /testbed
find / -xdev -type d -name .git -prune -exec rm -rf -- {} + 2>/dev/null
rm -rf -- /root/.cache /root/.npm /root/.local/share/pnpm/store /root/.pnpm-store /root/.yarn /tmp/*
rm -f -- /root/.bash_history /root/.zsh_history /root/.python_history
for home in /home/*; do
  test -d "$home" || continue
  rm -rf -- "$home/.cache" "$home/.npm" "$home/.local/share/pnpm/store" "$home/.pnpm-store" "$home/.yarn"
  rm -f -- "$home/.bash_history" "$home/.zsh_history" "$home/.python_history"
done
rm -f -- /eval.sh /patch.diff /candidate.patch /root/setup_repo.sh /root/setup_env.sh
chmod 755 /usr/local/bin/node
if ! getent group 10001 >/dev/null; then groupadd -g 10001 devflow; fi
if ! getent passwd 10001 >/dev/null; then useradd -m -u 10001 -g 10001 devflow; fi
git -C /workspace init -q
git -C /workspace -c user.name=DevFlow -c user.email=devflow@localhost add -A
GIT_AUTHOR_DATE=2000-01-01T00:00:00Z GIT_COMMITTER_DATE=2000-01-01T00:00:00Z git -C /workspace -c user.name=DevFlow -c user.email=devflow@localhost commit -qm 'Frozen public base'
chown -R 10001:10001 /workspace /home/devflow
/usr/local/bin/node --version
'''
        output=command(['docker','exec',cid,'/bin/bash','-c',script,'bridge',c['baseCommit']],timeout=300)
        (directory/'sanitize-output.txt').write_bytes(output)
        snapshot=command(['docker','exec','--user','10001:10001',cid,'bash','-c','git -C /workspace archive HEAD'],timeout=120)
        (directory/'base.tar').write_bytes(snapshot)
        rootfs=directory/'rootfs.tar'
        command(['docker','export','--output',str(rootfs.resolve()),cid],timeout=600)
        tag='devflow-external-set/bridge-'+args.case.lower()+':stage2'
        image_id=command(['docker','import','--change','LABEL devflow.suite=external-set',
                          '--change','LABEL devflow.role=solver-bridge',
                          '--change','USER 10001:10001','--change','WORKDIR /workspace',
                          '--change','ENV HOME=/home/devflow',
                          '--change','ENV PATH=/opt/miniconda3/envs/testbed/bin:/opt/miniconda3/bin:/usr/local/bin:/usr/bin:/bin',
                          str(rootfs.resolve()),tag],timeout=900).decode().strip()
        result={'caseId':args.case,'imageId':image_id,'tag':tag,'upstream':upstream['pinnedReference'],
                'sourceBaseCommit':c['baseCommit'],'baseSnapshotSha256':hashlib.sha256(snapshot).hexdigest(),
                'flattened':True,'rootfsBytes':rootfs.stat().st_size,'privateMaterialCopied':False,'createdAt':time.time()}
        with rootfs.open('rb') as handle:result['rootfsSha256']=hashlib.file_digest(handle,'sha256').hexdigest()
        result_path.write_text(json.dumps(result,indent=2),encoding='utf-8')
        print(json.dumps(result))
    finally:
        info=json.loads(command(['docker','inspect',cid]))[0]
        if info['Config']['Labels'].get('devflow.suite')!='external-set':raise RuntimeError('Ownership lost')
        command(['docker','rm','-f',cid])

if __name__=='__main__':main()
