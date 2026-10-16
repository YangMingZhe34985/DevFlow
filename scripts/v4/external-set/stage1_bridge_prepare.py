"""Audit the flat rootfs and create a host-only scripted T6 input."""
import argparse
import base64
import hashlib
import json
from pathlib import Path
import subprocess
import tarfile
import time
import uuid

SUITE=Path('.devflow/external-set-suite')

def command(args):
    p=subprocess.run(args,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=60)
    if p.returncode:raise RuntimeError(p.stderr.decode('utf-8','replace')[-1000:])
    return p.stdout

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--case',default='X11')
    args=parser.parse_args()
    DIRECTORY=SUITE/'private/bridge'/args.case
    image=json.loads((DIRECTORY/'image.json').read_text(encoding='utf-8'))
    catalog=json.loads((SUITE/'stage1-candidates.json').read_text(encoding='utf-8'))['candidates']
    candidate=next(c for c in catalog if c['caseId']==args.case)
    private=SUITE/'private'/candidate['instanceId']
    record=json.loads((private/'record.json').read_text(encoding='utf-8'))
    patterns=[record[k].encode() for k in ['patch','test_patch','eval_script']]
    hashes={hashlib.sha256(p).hexdigest() for p in patterns}
    leaks=[]; files_scanned=0; bytes_scanned=0; git_roots=set(); root_start=time.monotonic()
    with tarfile.open(DIRECTORY/'rootfs.tar',mode='r|') as root:
        for member in root:
            name=member.name.removeprefix('./')
            if '.git' in name.split('/'):
                git_roots.add(name.split('/.git')[0])
            if name in ['eval.sh','candidate.patch','patch.diff']:
                leaks.append({'path':name,'reason':'PRIVATE_ENTRYPOINT'})
            if not member.isfile():continue
            files_scanned+=1
            h=hashlib.sha256();overlap=b''
            with root.extractfile(member) as content:
                while chunk:=content.read(1024*1024):
                    bytes_scanned+=len(chunk);h.update(chunk)
                    combined=overlap+chunk
                    if any(p in combined for p in patterns if len(p)>80):
                        leaks.append({'path':name,'reason':'PRIVATE_MATERIAL_CONTENT'})
                    overlap=combined[-max(map(len,patterns)):]
            if h.hexdigest() in hashes:
                leaks.append({'path':name,'reason':'PRIVATE_MATERIAL_HASH'})
    if git_roots!={'workspace'}:
        leaks.append({'path':sorted(git_roots),'reason':'UNEXPECTED_GIT_HISTORY'})
    audit={'passed':not leaks,'scope':'entire exported flat rootfs regular files; full X11 gold/test/eval byte patterns and hashes; Git roots',
           'filesScanned':files_scanned,'bytesScanned':bytes_scanned,'durationSeconds':round(time.monotonic()-root_start,3),
           'gitRoots':sorted(git_roots),'findings':leaks,'imageId':image['imageId'],'caseId':args.case}
    (DIRECTORY/'rootfs-audit.json').write_text(json.dumps(audit,indent=2),encoding='utf-8')
    if leaks:raise RuntimeError('Bridge rootfs leaked private material or history')
    files=[]
    with tarfile.open(DIRECTORY/'base.tar') as base:
        for entry in base:
            if entry.isdir():continue
            if entry.isreg():
                content=base.extractfile(entry).read()
                files.append({'kind':'FILE','path':entry.name,'mode':0o755 if entry.mode&0o111 else 0o644,
                              'sizeBytes':len(content),'sha256':hashlib.sha256(content).hexdigest(),'contentBase64':base64.b64encode(content).decode()})
            elif entry.issym():
                content=entry.linkname.encode()
                files.append({'kind':'SYMLINK','path':entry.name,'mode':0o777,'sizeBytes':len(content),
                              'sha256':hashlib.sha256(content).hexdigest(),'target':entry.linkname})
            else:raise RuntimeError('Unsupported snapshot entry')
    total=sum(f['sizeBytes'] for f in files)
    if len(files)>20000 or total>50*1024**2 or any(f['sizeBytes']>10*1024**2 for f in files):
        raise RuntimeError('T6 source exceeds unmodified snapshot limits')
    name='devflow-external-gold-export-'+uuid.uuid4().hex[:10]
    cid=command(['docker','create','--network','none','--name',name,'--label','devflow.suite=external-set',
                 '--label','devflow.role=trusted-golden-export','--entrypoint','/bin/bash',image['upstream'],'-c','sleep infinity']).decode().strip()
    edits=[]
    try:
        command(['docker','start',cid])
        command(['docker','cp',str((private/'gold.patch').resolve()),cid+':/gold.patch'])
        command(['docker','exec','-w','/testbed',cid,'git','reset','--hard',record['base_commit']])
        command(['docker','exec','-w','/testbed',cid,'git','apply','/gold.patch'])
        modified=command(['docker','exec','-w','/testbed',cid,'git','diff','--name-only','-z']).decode().split('\0')
        for filename in filter(None,modified):
            old=next(f for f in files if f['path']==filename)
            new=command(['docker','exec',cid,'cat','/testbed/'+filename])
            edits.append({'path':filename,'old_text':base64.b64decode(old['contentBase64']).decode(),'new_text':new.decode()})
    finally:
        labels=json.loads(command(['docker','inspect',cid]))[0]['Config']['Labels']
        if labels.get('devflow.suite')!='external-set':raise RuntimeError('Ownership mismatch')
        command(['docker','rm','-f',cid])
    payload={'caseId':args.case,'repo':record['repo'],'imageId':image['imageId'],'task':{'title':record['instance_id'],'description':record['problem_statement']},
             'snapshot':{'version':1,'sourceHead':record['base_commit'],'totalBytes':total,'files':files},'edits':edits,'rootfsAudit':audit}
    (DIRECTORY/'scripted-input.json').write_text(json.dumps(payload),encoding='utf-8')
    print(json.dumps({'auditPassed':True,'snapshotFiles':len(files),'snapshotBytes':total,'scriptedEdits':len(edits)}))

if __name__=='__main__':main()
