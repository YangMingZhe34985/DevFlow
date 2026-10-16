"""Delete only our enumerated rootfs exports after matching completed audit SHA."""
import hashlib
import json
from pathlib import Path

SUITE=Path('.devflow/external-set-suite').resolve()
def read(p):return json.loads(p.read_text(encoding='utf-8'))
def main():
    entries=[]
    for root,generation,cases in [('private/bridge','', ['X11','X19','X21','XRJ2']),
                                 ('private/r2/bridges','r2-final-v2',['X19','X21','XRJ2'])]:
        for case in cases:
            directory=SUITE/root/case
            target=(directory/'rootfs.tar').resolve()
            if not target.is_relative_to(SUITE/'private') or target.name!='rootfs.tar':raise RuntimeError('Unsafe cleanup path')
            if not target.exists():continue
            reference=SUITE/'private/r2/audits'/generation/case/'strong-audit.json' if generation else SUITE/'private/r2/audits'/case/'strong-audit.json'
            # X11's latest audit is equivalent to its unchanged R1 image.
            if case=='X11':reference=SUITE/'private/r2/audits/r2-final/X11/strong-audit.json'
            audit=read(reference);image=read(directory/'image.json')
            if audit['imageId']!=image['imageId']:raise RuntimeError('Cleanup image differs from audited export')
            with target.open('rb') as handle:digest=hashlib.file_digest(handle,'sha256').hexdigest()
            if digest!=audit['rootfsSha256']:raise RuntimeError('Cleanup export differs from audited hash')
            entries.append({'path':target.relative_to(SUITE).as_posix(),'sha256':digest,'bytes':target.stat().st_size,
                            'audit':reference.relative_to(SUITE).as_posix(),'imageId':image['imageId'],'status':'VERIFIED_NOT_DELETED'})
    record=SUITE/'private/r2/rootfs-cleanup.json'
    if record.exists():raise RuntimeError('Cleanup identity already used; retain previous receipt')
    record.write_text(json.dumps(entries,indent=2),encoding='utf-8')
    for entry in entries:
        (SUITE/entry['path']).unlink();entry['status']='DELETED'
        record.write_text(json.dumps(entries,indent=2),encoding='utf-8')
    print(json.dumps({'deletedFiles':len(entries),'releasedBytes':sum(e['bytes'] for e in entries)}))

if __name__=='__main__':main()
