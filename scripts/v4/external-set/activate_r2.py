"""Activate only image/profile pairs with complete R2 receipts; never a live gate."""
import hashlib
import json
from pathlib import Path
import shutil

SUITE=Path('.devflow/external-set-suite')
def read(path):return json.loads(path.read_text(encoding='utf-8'))
def write(path,value):path.write_text(json.dumps(value,ensure_ascii=False,indent=2),encoding='utf-8')

def main():
    active={}
    for case in ['X11','X19','X21','XRJ2']:
        parent=SUITE/'private/bridge'/case
        directory=SUITE/'private/r2/bridges'/case
        if case=='X11':
            directory.mkdir(parents=True,exist_ok=True)
            for name in ['image.json','base.tar','scripted-input.json']:
                target=directory/name
                if target.exists() and target.read_bytes()!=(parent/name).read_bytes():raise RuntimeError('Existing X11 pointer differs')
                if not target.exists():shutil.copyfile(parent/name,target)
        image=read(directory/'image.json')
        generation='r2-final' if case=='X11' else 'r2-final-v2'
        reference=Path('private/r2/audits')/generation/case/'strong-audit.json'
        audit=read(SUITE/reference)
        if not audit['passed'] or audit['imageId']!=image['imageId']:raise RuntimeError('Strong audit mismatch '+case)
        profile_generation='r2-jdk' if case=='XRJ2' else 'r2-verified'
        proposed=read(SUITE/'public'/case/f'proposed-profile-{profile_generation}.json')
        profile=read(SUITE/'public'/case/'public-profile.json')
        if profile!={**proposed,'status':'CONFIGURED'}:raise RuntimeError('Profile differs from frozen proposal '+case)
        profile_sha=hashlib.sha256(json.dumps(proposed,sort_keys=True).encode('utf-8')).hexdigest()
        receipts=[]
        for label in ['base-1','base-2','base-3','gold-1']:
            receipt=read(SUITE/'private/r2/profiles'/profile_generation/case/label/'result.json')
            if not receipt['passed'] or receipt['imageId']!=image['imageId'] or receipt['profileSha256']!=profile_sha:
                raise RuntimeError('Profile receipt mismatch '+case+' '+label)
            receipts.append(str(Path('private/r2/profiles')/profile_generation/case/label/'result.json'))
        compatible={'passed':True,'strongAuditPassed':True,'imageId':image['imageId'],
                    'gitRoots':audit['dependencies']['gitRoots'],'findings':[],
                    'strongAuditRef':reference.as_posix(),'rootfsSha256':audit['rootfsSha256'],
                    'privateProfileReceipts':receipts}
        write(directory/'rootfs-audit.json',compatible)
        scripted=read(directory/'scripted-input.json');scripted['rootfsAudit']=compatible
        write(directory/'scripted-input.json',scripted)
        active[case]=directory.relative_to(SUITE).as_posix()
    target=SUITE/'private/r2/active-bridges.json'
    temporary=target.with_suffix('.next');write(temporary,active);temporary.replace(target)
    print(json.dumps({'active':list(active),'readyForLive':False}))

if __name__=='__main__':main()
