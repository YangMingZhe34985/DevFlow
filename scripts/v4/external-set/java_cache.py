"""Extract only the official image's existing Ivy cache, with dated bootstrap proof."""
import base64
from datetime import datetime,timezone
import hashlib
import json
from pathlib import Path
import re
import subprocess
import uuid
import xml.etree.ElementTree as ET
import zipfile

SUITE=Path('.devflow/external-set-suite')

def command(args):
    p=subprocess.run(args,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=120)
    if p.returncode:raise RuntimeError(p.stderr.decode('utf-8','replace')[-1500:])
    return p.stdout

def main():
    root=SUITE/'private/r2/java';root.mkdir(parents=True,exist_ok=True)
    image=json.loads((SUITE/'private/bridge/XRJ2/image.json').read_text(encoding='utf-8'))
    snapshot=json.loads((SUITE/'public/XRJ2/snapshot.json').read_text(encoding='utf-8'))
    metadata=next(f for f in snapshot['files'] if f['path']=='buildScripts/ivy-repo/org.projectlombok-lombok.patcher-0.46.xml')
    ivy=ET.fromstring(base64.b64decode(metadata['contentBase64']));info=ivy.find('info')
    publication=datetime.strptime(info.attrib['publication'],'%Y%m%d%H%M%S').replace(tzinfo=timezone.utc)
    cid=command(['docker','create','--name','devflow-external-cache-'+uuid.uuid4().hex[:10],
        '--label','devflow.suite=external-set','--label','devflow.role=trusted-cache-export',
        '--network','none','--entrypoint','/bin/bash',image['upstream'],'-c','sleep infinity']).decode('utf-8').strip()
    try:
        command(['docker','start',cid])
        base_date=command(['docker','exec',cid,'git','-C','/testbed','show','-s','--format=%cI',image['sourceBaseCommit']]).decode('utf-8').strip()
        source_commit=command(['docker','exec',cid,'git','-C','/testbed','log','-1','--format=%H %cI',image['sourceBaseCommit'],'--',metadata['path']]).decode('utf-8').strip()
        if not (root/'ivyCache').exists():command(['docker','cp',cid+':/testbed/ivyCache',str(root.resolve())])
    finally:
        labels=json.loads(command(['docker','inspect',cid]))[0]['Config']['Labels']
        if labels.get('devflow.suite')!='external-set':raise RuntimeError('Ownership mismatch')
        command(['docker','rm','-f',cid])
    base=datetime.fromisoformat(base_date)
    if publication>=base:raise RuntimeError('Bootstrap is not earlier than base')
    artifacts=[];allowed=[];excluded=[]
    for p in sorted((root/'ivyCache').rglob('*')):
        if not p.is_file():continue
        relative=p.relative_to(root/'ivyCache').as_posix()
        if p.suffix.lower()!='.jar':continue
        content=p.read_bytes();digest=hashlib.sha256(content).hexdigest()
        pieces=relative.split('/')
        with zipfile.ZipFile(p) as zipped:
            names=zipped.namelist()
            handlers=any(n.startswith(('lombok/javac/handlers/','lombok/eclipse/handlers/','lombok/core/handlers/')) for n in names)
            own=any(n.startswith('lombok/') and not n.startswith(('lombok/patcher/','lombok/injector/')) for n in names if n.endswith('.class'))
        artifact={'path':relative,'name':p.name,'organisation':pieces[0] if len(pieces)>2 else None,
                  'module':pieces[1] if len(pieces)>2 else None,'versionFromFilename':re.sub(r'^.*?-([0-9][^-]*)\.jar$',r'\1',p.name),
                  'sha256':digest,'sizeBytes':len(content),'containsProjectHandlers':handlers}
        artifacts.append(artifact)
        if 'lombok' in p.name.lower():
            exact=p.name=='lombok.patcher-0.46.jar' and pieces[:2]==['org.projectlombok','lombok.patcher']
            if not exact or handlers or own:
                excluded.append({**artifact,'reason':'OWN_OR_UNVERIFIED_LOMBOK_ARTIFACT'});continue
            allowed.append({**artifact,'role':'base-pinned patcher bootstrap; separate projectlombok/lombok.patcher',
                            'publication':publication.isoformat(),'publicationTimezone':'Ivy publication parsed as UTC; base Git includes this exact version metadata',
                            'baseDate':base_date,'baseCommit':image['sourceBaseCommit'],'metadataPath':metadata['path'],
                            'metadataSha256':metadata['sha256'],'metadataLastCommit':source_commit,
                            'sourceUrl':'https://github.com/projectlombok/lombok.patcher',
                            'namespacePolicy':'Only lombok/patcher and lombok/injector classes; no target project handler classes'})
    if excluded:raise RuntimeError('Cache contains project/unverified artifacts; inspect private manifest before copying')
    if len(allowed)!=1:raise RuntimeError('Expected one explicitly verified bootstrap artifact')
    # Do not carry run-specific target-project resolution reports into the solver.
    for p in (root/'ivyCache').iterdir():
        if p.is_file() and ('projectlombok.org-lombok' in p.name):
            excluded.append({'path':p.name,'sha256':hashlib.sha256(p.read_bytes()).hexdigest(),'reason':'GENERATED_TARGET_RESOLUTION_REPORT'})
            p.unlink()
    manifest={'upstream':image['upstream'],'baseDate':base_date,'artifacts':artifacts,'allowedBootstraps':allowed,
              'excluded':excluded,'networkDownloads':0,'cacheRoot':'/workspace/ivyCache',
              'rule':'No main lombok library/source artifact at any version; only exact dated base-declared patcher bootstrap'}
    (root/'cache-manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps({'artifacts':len(artifacts),'allowedBootstraps':len(allowed),'excludedReports':len(excluded),'networkDownloads':0}))

if __name__=='__main__':main()
