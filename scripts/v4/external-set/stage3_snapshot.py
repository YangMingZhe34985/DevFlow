"""Create public-only snapshot/fixture from exact public base archive. No answers."""
import argparse
import base64
import hashlib
import json
from pathlib import Path
import tarfile

SUITE=Path('.devflow/external-set-suite')
def read(p):return json.loads(p.read_text(encoding='utf-8'))
def main():
    parser=argparse.ArgumentParser();parser.add_argument('--case',required=True);args=parser.parse_args()
    c=next(c for c in read(SUITE/'stage1-candidates.json')['candidates'] if c['caseId']==args.case)
    directory=SUITE/'private/bridge'/args.case;image=read(directory/'image.json')
    if image['sourceBaseCommit']!=c['baseCommit']:raise RuntimeError('Base differs')
    files=[]
    with tarfile.open(directory/'base.tar') as archive:
        for f in archive:
            if f.isdir():continue
            if f.isfile():
                data=archive.extractfile(f).read();entry={'kind':'FILE','contentBase64':base64.b64encode(data).decode('ascii'),'mode':0o755 if f.mode&0o111 else 0o644}
            elif f.issym():data=f.linkname.encode('utf-8');entry={'kind':'SYMLINK','target':f.linkname,'mode':0o777}
            else:raise RuntimeError('Unsupported entry')
            if f.name.startswith('/') or '..' in f.name.split('/'):raise RuntimeError('Unsafe base archive')
            files.append({**entry,'path':f.name,'sizeBytes':len(data),'sha256':hashlib.sha256(data).hexdigest()})
    total=sum(f['sizeBytes'] for f in files)
    if len(files)>20000 or total>50*1024**2 or any(f['sizeBytes']>10*1024**2 for f in files):raise RuntimeError('Existing snapshot limits exceeded')
    snapshot={'version':1,'sourceHead':c['baseCommit'],'totalBytes':total,'files':files}
    text=json.dumps(snapshot,separators=(',',':'),ensure_ascii=False)
    # Use only the public problem field, never spread the private source record.
    record=read(SUITE/'private'/c['instanceId']/'record.json')
    fixture={'version':1,'caseId':args.case,'source':{'dataset':c['dataset'],'revision':c['datasetRevision'],'instanceId':c['instanceId'],'repo':c['repo'],'baseCommit':c['baseCommit']},
             'task':{'title':c['instanceId'],'description':record['problem_statement']},'imageId':image['imageId'],'snapshotSha256':hashlib.sha256(text.encode('utf-8')).hexdigest(),
             'publicChecks':{'status':'NOT_CONFIGURED','checks':[]}}
    public=SUITE/'public'/args.case;public.mkdir(parents=True,exist_ok=True)
    if (public/'fixture.json').exists():raise RuntimeError('Public preparation already exists; do not overwrite frozen identity')
    (public/'snapshot.json').write_text(text,encoding='utf-8')
    (public/'fixture.json').write_text(json.dumps(fixture,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps({'caseId':args.case,'files':len(files),'bytes':total}))

if __name__=='__main__':main()
