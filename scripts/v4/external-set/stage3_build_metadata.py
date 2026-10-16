"""Restore public SCM build metadata, never a published project implementation."""
import argparse
import ast
import base64
import hashlib
import json
from pathlib import Path
import re
import subprocess
import uuid
import tomllib

SUITE=Path('.devflow/external-set-suite')
def read(p):return json.loads(p.read_text(encoding='utf-8'))
def command(args,timeout=120):
    p=subprocess.run(args,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=timeout)
    if p.returncode:raise RuntimeError(p.stderr.decode('utf-8','replace')[-1800:])
    return p.stdout
def container(image,role,user='0:0',env=None):
    extra=[v for k,value in (env or {}).items() for v in ['-e',k+'='+value]]
    return command(['docker','create','--label','devflow.suite=external-set','--label','devflow.role='+role,'--network','none','--user',user,'--cpus','2','--memory','4g','--pids-limit','512',*extra,'--entrypoint','/bin/bash',image,'-c','sleep infinity']).decode().strip()
def remove(cid):
    labels=json.loads(command(['docker','inspect',cid]))[0]['Config']['Labels']
    if labels.get('devflow.suite')!='external-set':raise RuntimeError('Ownership mismatch')
    command(['docker','rm','-f',cid])
def extract_constants(text,base,describe):
    if len(text.encode('utf-8'))>65536:raise ValueError('Generated metadata exceeds safety cap')
    values={}
    allowed={'__all__','version','__version__','version_tuple','__version_tuple__','commit_id','__commit_id__'}
    for node in ast.parse(text).body:
        if isinstance(node,ast.ImportFrom) and node.module=='__future__':continue
        if isinstance(node,ast.AnnAssign) and node.value is None and isinstance(node.target,ast.Name) and node.target.id in allowed:continue
        if not isinstance(node,ast.Assign) or any(not isinstance(t,ast.Name) or t.id not in allowed for t in node.targets):raise ValueError('Generated file is not literal-only build metadata')
        value=ast.literal_eval(node.value)
        for name in node.targets:values[name.id]=value
    version=values.get('version',values.get('__version__'))
    parts=re.fullmatch(r'(.+)-(\d+)-g([a-f0-9]+)',describe)
    if not isinstance(version,str) or not re.fullmatch(r'[0-9][0-9A-Za-z.+_-]{0,150}',version) or not parts or not base.startswith(parts[3]):raise ValueError('Version/base identity unknown')
    if int(parts[2]):
        version_node=re.search(r'(?:\+|\.)g([a-f0-9]{7,40})(?:\.|$)',version)
        if not version_node or not base.startswith(version_node[1]) or not re.search(r'\.dev'+re.escape(parts[2])+r'(?:\+|$)',version):raise ValueError('Generated version is not bound to exact base Git commit/distance')
    elif version!=parts[1].removeprefix('v'):raise ValueError('Release version differs from exact base tag')
    return {'version':version,'version_tuple':values.get('version_tuple',values.get('__version_tuple__')),'commit_id':values.get('commit_id','g'+parts[3])}

def main():
    p=argparse.ArgumentParser();p.add_argument('--case',required=True);a=p.parse_args();case=a.case
    if not re.fullmatch(r'X[A-Z0-9]+',case):raise ValueError('Unsafe case')
    directory=SUITE/'private/bridge'/case;image=read(directory/'image.json')
    if image.get('buildMetadata'):return
    # Only public committed build configuration controls whether preparation is required.
    import tarfile
    with tarfile.open(directory/'base.tar') as archive:
        try:setup=archive.extractfile('setup.py').read().decode('utf-8')
        except KeyError:setup=''
        try:configuration=tomllib.loads(archive.extractfile('pyproject.toml').read().decode('utf-8')).get('tool',{}).get('setuptools_scm',{})
        except KeyError:configuration={}
    match=re.search(r'["\']write_to["\']\s*:\s*["\']([^"\']+)["\']',setup)
    target=configuration.get('write_to') or configuration.get('version_file') or (match[1] if 'use_scm_version' in setup and match else None)
    if not target:return
    if target.startswith('/') or '..' in target.split('/'):raise ValueError('Unsafe generated metadata path')
    with tarfile.open(directory/'base.tar') as archive:
        if target in archive.getnames():return
    cid=container(image['upstream'],'trusted-base-version')
    try:
        command(['docker','start',cid]);command(['docker','exec','-w','/testbed',cid,'git','reset','--hard',image['sourceBaseCommit']])
        raw=command(['docker','exec',cid,'cat','/testbed/'+target]).decode('utf-8')
        describe=command(['docker','exec','-w','/testbed',cid,'git','describe','--tags','--long',image['sourceBaseCommit']]).decode().strip()
        values=extract_constants(raw,image['sourceBaseCommit'],describe)
        version=values['version']
    finally:remove(cid)
    env={'SETUPTOOLS_SCM_PRETEND_VERSION':version,'PIP_NO_INDEX':'1','PYTHONDONTWRITEBYTECODE':'1'}
    cid=container(image['imageId'],'public-build-metadata','10001:10001',env)
    try:
        command(['docker','start',cid])
        payload='version = __version__ = '+repr(values['version'])+'\nversion_tuple = __version_tuple__ = '+repr(values['version_tuple'])+'\ncommit_id = __commit_id__ = '+repr(values.get('commit_id'))+'\n'
        metadata=payload.encode('utf-8')
        process=subprocess.run(['docker','exec','-i',cid,'node','-e',"const fs=require('fs'),path=require('path');const p=process.argv[1],parent=fs.realpathSync(path.dirname(p));if(!parent.startsWith('/workspace/'))throw Error('metadata path escape');if(fs.existsSync(p)&&fs.lstatSync(p).isSymbolicLink())throw Error('metadata target symlink');fs.writeFileSync(p,fs.readFileSync(0));",'/workspace/'+target],input=metadata,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=30)
        if process.returncode:raise RuntimeError(process.stderr.decode('utf-8','replace'))
        if command(['docker','exec','-w','/workspace',cid,'git','diff','--name-only']).strip():raise RuntimeError('Metadata restoration changed committed source')
        original=dict(image)
        tag=f'devflow-external-set/bridge-{case.lower()}:build-metadata'
        image_id=command(['docker','commit','--change','ENTRYPOINT []','--change','USER 10001:10001','--change','WORKDIR /workspace','--change','LABEL devflow.suite=external-set','--change','LABEL devflow.role=solver-bridge',cid,tag]).decode().strip()
        old_export=directory/'rootfs.tar'
        if old_export.exists():
            with old_export.open('rb') as h:sha=hashlib.file_digest(h,'sha256').hexdigest()
            if sha!=original['rootfsSha256']:raise RuntimeError('Superseded export changed')
            (directory/'superseded-export.json').write_text(json.dumps({'imageId':original['imageId'],'sha256':sha,'bytes':old_export.stat().st_size,'reason':'Superseded before final audit; not eligible for freeze'},indent=2),encoding='utf-8')
            old_export.unlink()
        command(['docker','export','--output',str(old_export.resolve()),cid],600)
        with old_export.open('rb') as h:root_sha=hashlib.file_digest(h,'sha256').hexdigest()
        (directory/'image-before-build-metadata.json').write_text(json.dumps(original,indent=2),encoding='utf-8')
        identity={'version':version,'runtimeContractVersion':2,'generatedPath':target,'generatedSha256':hashlib.sha256(metadata).hexdigest(),'baseCommit':image['sourceBaseCommit'],
                  'source':'Public SCM write_to/version_file configuration; literal version constants only from official generated metadata, verified against base Git hash/tag distance', 'gitDescribe':describe,'officialGeneratedSha256':hashlib.sha256(raw.encode('utf-8')).hexdigest(),
                  'environment':env,'baseOnlyParentImage':original['imageId'],'preparationOnly':True}
        image.update(imageId=image_id,tag=tag,rootfsSha256=root_sha,rootfsBytes=old_export.stat().st_size,buildMetadata=identity)
        (directory/'image.json').write_text(json.dumps(image,indent=2),encoding='utf-8')
    finally:remove(cid)
    public=SUITE/'public'/case;public.mkdir(parents=True,exist_ok=True)
    (public/'build-environment.json').write_text(json.dumps(identity,indent=2),encoding='utf-8')
    if (public/'fixture.json').exists():
        fixture=read(public/'fixture.json');fixture['imageId']=image['imageId'];fixture['publicChecks']={'status':'NOT_CONFIGURED','checks':[]}
        (public/'fixture.json').write_text(json.dumps(fixture,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps({'caseId':case,'buildMetadata':'PREPARED','version':version,'imageId':image['imageId']}),flush=True)

if __name__=='__main__':main()
