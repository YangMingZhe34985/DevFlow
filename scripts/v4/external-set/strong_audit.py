"""Trusted, read-only audit. Patch paths and dependency findings stay host-private."""
import argparse
import base64
from datetime import datetime
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import re
import subprocess
import sys
import tarfile
import time
import uuid
import zipfile

SUITE=Path('.devflow/external-set-suite')

def read(path):return json.loads(path.read_text(encoding='utf-8'))
def sha(content):return hashlib.sha256(content).hexdigest()

def valid_release_proof(proof):
    try:
        publication=datetime.fromisoformat(proof['publication'].replace('Z','+00:00'))
        base=datetime.fromisoformat(proof['baseDate'])
        return proof.get('approved') is True and publication.tzinfo is not None and base.tzinfo is not None and publication<base
    except (KeyError,ValueError,TypeError):return False

def touched_paths(text):
    # Use the frozen harness dependency, not a lossy diff-header regex.
    sys.path.insert(0,str((SUITE/'private/tool-packages').resolve()))
    from unidiff import PatchSet
    paths=set()
    for patch in PatchSet(io.StringIO(text)):
        for name in [patch.source_file,patch.target_file]:
            if name=='/dev/null':continue
            name=name[2:] if name.startswith(('a/','b/')) else name
            if name.startswith('"') or PurePosixPath(name).is_absolute() or any(p in ['..','.git'] for p in PurePosixPath(name).parts):
                raise ValueError('Unrecognized/unsafe patch path')
            paths.add(name)
    return sorted(paths)

def workspace_expectations(snapshot,paths):
    by_path={f['path']:f for f in snapshot['files']}
    return [{'path':p,'kind':by_path[p]['kind'],'sha256':by_path[p]['sha256']} if p in by_path
            else {'path':p,'kind':'ABSENT'} for p in paths]

def own_node_names(snapshot):
    result=set()
    for entry in snapshot['files']:
        if entry['kind']!='FILE' or not (entry['path']=='package.json' or re.fullmatch(r'packages(?:-private)?/[^/]+/package.json',entry['path'])):continue
        data=json.loads(base64.b64decode(entry['contentBase64']))
        if data.get('name'):result.add(data['name'])
    return result

def scan_rootfs(rootfs,repo,snapshot,patterns,allowed_bootstraps=None,release_proofs=None):
    own=own_node_names(snapshot)
    python_name=repo.split('/')[-1].lower().replace('-','_')
    python_modules={python_name}|({'_pytest','pytest.py'} if python_name=='pytest' else set())
    editable_roots={'/testbed','/workspace'}
    if any(f['path'].startswith('src/') for f in snapshot['files']):editable_roots.update(['/testbed/src','/workspace/src'])
    inventory=[];violations=[];residues=[];links=[];git_roots=set();scanned=0
    cache_roots=set();script_files=[];jar_inventory=[];package_by_path={};hardlinks=[]
    allowed_bootstraps=allowed_bootstraps or [];release_proofs=release_proofs or []
    with tarfile.open(rootfs,mode='r|') as archive:
        for member in archive:
            name=member.name.removeprefix('./')
            if '/.git/' in name or name.endswith('/.git'):git_roots.add(name.split('/.git')[0])
            if member.issym() and ('node_modules/' in name or name.endswith('/testbed') or name=='testbed'):
                links.append({'path':name,'target':member.linkname})
            if member.islnk():hardlinks.append({'path':name,'target':member.linkname.removeprefix('./')})
            if not member.isfile():continue
            scanned+=1
            # Opaque package caches are not accepted as evidence of absence.
            cache=re.search(r'(^|/)(?:\.npm|\.cache/pip|\.cache/yarn|\.local/share/pnpm/store|\.pnpm-store)(?:/|$)',name)
            if cache:cache_roots.add(name[:cache.end()].rstrip('/'))
            if name.startswith('opt/miniconda3/pkgs/') and '/info/' not in name:
                # Conda cache is checked for own-project package copies below.
                if re.search(r'/'+re.escape(python_name)+r'[-/]',name,re.I):
                    violations.append({'path':name,'reason':'OWN_PROJECT_CONDA_CACHE'})
            if name.endswith(('.bash_history','.zsh_history','.python_history')) or re.search(r'(^|/)(?:eval\.sh|gold\.patch|candidate\.patch|patch\.diff)$',name):
                residues.append({'path':name,'reason':'PRIVATE_ENTRYPOINT_OR_HISTORY'})
            interesting_json=name.endswith('/package.json') and 'node_modules/' in name
            python_link='site-packages/' in name and name.endswith('.egg-link')
            python_pth='site-packages/' in name and name.endswith('.pth') and python_name in PurePosixPath(name).name.lower()
            python_metadata='site-packages/' in name and name.endswith(('/METADATA','/PKG-INFO','/direct_url.json'))
            jar=name.lower().endswith('.jar') and any(part in name for part in ['.ivy2/','.m2/','workspace/lib/','/ivyCache/'])
            own_python_code=any('site-packages/'+module+'/' in name or name.endswith('site-packages/'+module) for module in python_modules)
            if own_python_code:
                violations.append({'path':name,'reason':'OWN_PROJECT_INSTALLED_SOURCE_COPY'})
            top_script=re.fullmatch(r'(?:root|home/[^/]+)/[^/]+\.(?:sh|bash|py)',name)
            if top_script:script_files.append({'path':name,'sizeBytes':member.size})
            need_content=interesting_json or python_link or python_pth or python_metadata or jar or top_script or name.startswith('tmp/')
            content=None;digest=hashlib.sha256();overlap=b''
            max_pattern=max(map(len,patterns),default=0)
            with archive.extractfile(member) as handle:
                chunks=[] if need_content and member.size<=32*1024**2 else None
                while chunk:=handle.read(1024*1024):
                    digest.update(chunk)
                    combined=overlap+chunk
                    if any(p in combined for p in patterns if len(p)>80):
                        residues.append({'path':name,'reason':'PRIVATE_MATERIAL_CONTENT'})
                    overlap=combined[-max_pattern:] if max_pattern else b''
                    if chunks is not None:chunks.append(chunk)
                if chunks is not None:content=b''.join(chunks)
            if interesting_json:
                try:
                    package=json.loads(content) if content is not None else None
                    if package is None:raise ValueError('oversized metadata')
                    info={'path':name,'name':package.get('name'),'version':package.get('version'),'sha256':digest.hexdigest()}
                    inventory.append(info);package_by_path[name]=info
                    if package.get('name') in own:
                        violations.append({**info,'reason':'OWN_PROJECT_PUBLISHED_NODE_COPY','policy':'No published own-project copies allowed without dated provenance'})
                    elif str(package.get('name','')).startswith('@vue/') and repo=='vuejs/core':
                        proof=next((p for p in release_proofs if p.get('name')==info['name'] and p.get('version')==info['version'] and valid_release_proof(p)),None)
                        if not proof:violations.append({**info,'reason':'VUE_NAMESPACE_RELEASE_DATE_UNVERIFIED'})
                        else:info['releaseProof']=proof
                except (ValueError,UnicodeError):
                    violations.append({'path':name,'reason':'UNREADABLE_PACKAGE_METADATA'})
            if python_link:
                target=(content or b'').decode('utf-8','replace').splitlines()[0] if content else ''
                info={'path':name,'editableTarget':target,'sha256':digest.hexdigest()};inventory.append(info)
                if python_name in name.lower() and target not in editable_roots:
                    violations.append({**info,'reason':'EDITABLE_NOT_WORKSPACE'})
            if python_metadata and content:
                text=content.decode('utf-8','replace')
                if name.endswith('/direct_url.json') and re.match(re.escape(python_name)+r'[-_.]',name.split('site-packages/',1)[1],re.I):
                    try:
                        direct=json.loads(text);target=direct.get('url','').removeprefix('file://').rstrip('/')
                        inventory.append({'path':name,'editable':direct.get('dir_info',{}).get('editable'),'target':target})
                        if direct.get('dir_info',{}).get('editable') is not True or target not in editable_roots:
                            violations.append({'path':name,'reason':'DIRECT_URL_NOT_WORKSPACE_EDITABLE'})
                    except ValueError:violations.append({'path':name,'reason':'INVALID_DIRECT_URL_METADATA'})
                package_name=re.search(r'^Name: (.+)$',text,re.M);version=re.search(r'^Version: (.+)$',text,re.M)
                if package_name and package_name[1].strip().lower().replace('-','_')==python_name:
                    inventory.append({'path':name,'name':package_name[1].strip(),'version':version[1].strip() if version else None})
            if python_pth and content:
                for target in content.decode('utf-8','replace').splitlines():
                    if target.startswith('/'):
                        inventory.append({'path':name,'pthTarget':target})
                        if target.rstrip('/') not in editable_roots:violations.append({'path':name,'target':target,'reason':'PTH_NOT_WORKSPACE'})
            if jar:
                info={'path':name,'sha256':digest.hexdigest(),'sizeBytes':member.size,'maven':[]}
                if content is not None:
                    try:
                        with zipfile.ZipFile(io.BytesIO(content)) as zipped:
                            for filename in zipped.namelist():
                                if filename.startswith('META-INF/maven/') and filename.endswith('/pom.properties'):
                                    text=zipped.read(filename).decode('utf-8','replace')
                                    info['maven'].append(dict(re.findall(r'^(groupId|artifactId|version)=(.+)$',text,re.M)))
                            info['containsProjectHandlers']=any(p.startswith('lombok/javac/handlers/') for p in zipped.namelist())
                    except zipfile.BadZipFile:info['zipError']=True
                jar_inventory.append(info)
                if 'lombok' in PurePosixPath(name).name.lower() and repo=='projectlombok/lombok':
                    proof=next((p for p in allowed_bootstraps if p['sha256']==info['sha256'] and p['name']==PurePosixPath(name).name),None)
                    if proof and info.get('containsProjectHandlers') is False:info['bootstrapProof']=proof
                    else:violations.append({**info,'reason':'LOMBOK_NAMED_ARTIFACT_REQUIRES_EXCLUSION_OR_DATED_BOOTSTRAP_PROOF'})
            if content and (top_script or name.startswith(('root/','tmp/','home/'))) and b'>>>>> Start Test Output' in content:
                residues.append({'path':name,'reason':'EVALUATION_SCRIPT_MARKER'})
    if cache_roots:residues.extend({'path':p,'reason':'OPAQUE_PACKAGE_CACHE_NOT_CLEARED'} for p in sorted(cache_roots))
    for link in hardlinks:
        if 'node_modules/' in link['path'] and link['path'].endswith('/package.json'):
            package=package_by_path.get(link['target'])
            if package is None:violations.append({**link,'reason':'UNRESOLVED_HARDLINK_PACKAGE'})
            else:
                info={**package,'path':link['path'],'hardlinkTarget':link['target']};inventory.append(info)
                if info['name'] in own:violations.append({**info,'reason':'OWN_PROJECT_HARDLINK_COPY'})
        if 'site-packages/'+python_name+'/' in link['path']:
            violations.append({**link,'reason':'OWN_PROJECT_INSTALLED_HARDLINK_COPY'})
    return {'filesScanned':scanned,'ownProjectNodeNames':sorted(own),'packages':inventory,'nodeLinks':links,
            'artifacts':jar_inventory,'dependencyFindings':violations,'residueFindings':residues,
            'homeScripts':script_files,'gitRoots':sorted(git_roots),'hardlinks':hardlinks}

def command(args,**kwargs):
    p=subprocess.run(args,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=90,**kwargs)
    if p.returncode:raise RuntimeError(p.stderr.decode('utf-8','replace')[-1500:])
    return p.stdout

def resolve_workspace_links(image_id,links):
    """One batched IO, independent of the number of workspace symlinks."""
    return json.loads(command(['docker','run','--rm','-i','--network','none','--read-only','--user','10001:10001','--cpus','2','--memory','2g','--pids-limit','512',
            '--label','devflow.suite=external-set','--label','devflow.role=trusted-link-audit','--entrypoint','node',image_id,
            '-e',"const fs=require('fs');let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>console.log(JSON.stringify(JSON.parse(s).map(r=>{try{return {...r,resolved:fs.realpathSync('/'+r.path)}}catch(e){return {...r,error:e.code}}}))));"],input=json.dumps(links).encode('utf-8')))

def audit_case(case,bridge_root='private/bridge',generation='r2-c2'):
    directory=SUITE/bridge_root/case
    image=read(directory/'image.json');fixture=read(SUITE/'public'/case/'fixture.json')
    snapshot=read(SUITE/'public'/case/'snapshot.json')
    if snapshot['sourceHead']!=image['sourceBaseCommit'] or fixture['source']['baseCommit']!=image['sourceBaseCommit']:
        raise RuntimeError('Audit source identity mismatch')
    if sha((directory/'base.tar').read_bytes())!=image['baseSnapshotSha256']:
        raise RuntimeError('Base archive changed')
    base_entries={}
    with tarfile.open(directory/'base.tar') as base:
        for entry in base:
            if entry.isfile():base_entries[entry.name]=('FILE',sha(base.extractfile(entry).read()))
            elif entry.issym():base_entries[entry.name]=('SYMLINK',sha(entry.linkname.encode('utf-8')))
    if base_entries!={entry['path']:(entry['kind'],entry['sha256']) for entry in snapshot['files']}:
        raise RuntimeError('Public snapshot differs from frozen base archive')
    record=read(SUITE/'private'/fixture['source']['instanceId']/'record.json')
    paths=sorted(set(touched_paths(record['patch'])+touched_paths(record['test_patch'])))
    expected=workspace_expectations(snapshot,sorted(set(paths+[f['path'] for f in snapshot['files']])))
    node_directories={}
    for entry in snapshot['files']:
        if entry['kind']=='FILE' and (entry['path']=='package.json' or re.fullmatch(r'packages(?:-private)?/[^/]+/package.json',entry['path'])):
            package=json.loads(base64.b64decode(entry['contentBase64']))
            if package.get('name'):node_directories[package['name']]='/workspace/'+str(PurePosixPath(entry['path']).parent)
    output=SUITE/'private/r2/audits'/generation/case;output.mkdir(parents=True,exist_ok=True)
    cid=command(['docker','create','--name','devflow-external-audit-'+uuid.uuid4().hex[:10],
                 '--label','devflow.suite=external-set','--label','devflow.role=trusted-readonly-audit',
                 '--network','none','--read-only','--user','10001:10001','--cpus','2','--memory','2g',
                 '--entrypoint','/bin/bash',image['imageId'],'-c','sleep infinity']).decode('utf-8').strip()
    script=r'''const fs=require('fs'),crypto=require('crypto'),path=require('path');const rows=JSON.parse(fs.readFileSync(0,'utf8'));const h=b=>crypto.createHash('sha256').update(b).digest('hex');console.log(JSON.stringify({workspaceAlias:fs.realpathSync('/testbed'),files:rows.map(r=>{const p='/workspace/'+r.path;try{const parent=fs.realpathSync(path.dirname(p));if(parent!='/workspace'&&!parent.startsWith('/workspace/'))return {path:r.path,kind:'ERROR',error:'PATH_ESCAPE'};const s=fs.lstatSync(p);return {path:r.path,kind:s.isSymbolicLink()?'SYMLINK':s.isFile()?'FILE':'OTHER',sha256:h(s.isSymbolicLink()?Buffer.from(fs.readlinkSync(p)):fs.readFileSync(p))}}catch(e){if(e.code==='ENOENT')return {path:r.path,kind:'ABSENT'};return {path:r.path,kind:'ERROR',error:e.code}}})}));'''
    try:
        command(['docker','start',cid])
        actual=json.loads(command(['docker','exec','-i',cid,'node','-e',script],input=json.dumps(expected).encode('utf-8')))
    finally:
        labels=json.loads(command(['docker','inspect',cid]))[0]['Config']['Labels']
        if labels.get('devflow.suite')!='external-set':raise RuntimeError('Audit cleanup ownership mismatch')
        command(['docker','rm','-f',cid])
    expected_by={r['path']:r for r in expected};mismatches=[]
    for row in actual['files']:
        if row!=expected_by[row['path']]:mismatches.append({'expected':expected_by[row['path']],'actual':row})
    rootfs=directory/'rootfs.tar'
    with rootfs.open('rb') as handle:rootfs_sha=hashlib.file_digest(handle,'sha256').hexdigest()
    if image.get('rootfsSha256') and image['rootfsSha256']!=rootfs_sha:raise RuntimeError('Rootfs export changed')
    bootstrap_path=SUITE/'private/r2/java/cache-manifest.json'
    bootstrap=[p for p in read(bootstrap_path).get('allowedBootstraps',[]) if p.get('baseCommit')==image['sourceBaseCommit']] if bootstrap_path.exists() and fixture['source']['repo']=='projectlombok/lombok' else []
    proof_path=SUITE/'private/r2/release-provenance'/f'{case}.json'
    proofs=read(proof_path).get('releases',[]) if proof_path.exists() else []
    scan=scan_rootfs(rootfs,fixture['source']['repo'],snapshot,[record[f].encode('utf-8') for f in ['patch','test_patch','eval_script']],bootstrap,proofs)
    own_links=[]
    for link in scan['nodeLinks']:
        for name,target in node_directories.items():
            if link['path'].endswith('/node_modules/'+name):own_links.append({**link,'expectedDirectory':target.rstrip('/.')})
    # Validate own-package links against base workspace directories, not labels.
    observations=resolve_workspace_links(image['imageId'],own_links)
    for observation in observations:
        if observation.get('resolved')!=observation['expectedDirectory']:
            scan['dependencyFindings'].append({**observation,'reason':'OWN_PACKAGE_LINK_NOT_BASE_WORKSPACE'})
    scan['verifiedWorkspaceLinks']=observations
    result={'caseId':case,'at':time.time(),'imageId':image['imageId'],'rootfsSha256':rootfs_sha,
            'rootfsBytes':rootfs.stat().st_size,'fileLevel':{'passed':not mismatches and actual['workspaceAlias']=='/workspace',
            'expected':expected,'observed':actual,'mismatches':mismatches},'dependencies':scan,
            'passed':not mismatches and actual['workspaceAlias']=='/workspace' and not scan['dependencyFindings'] and not scan['residueFindings'] and scan['gitRoots']==['workspace']}
    (output/'strong-audit.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps({'caseId':case,'passed':result['passed'],'fileMismatches':len(mismatches),'dependencyFindings':len(scan['dependencyFindings']),
                      'residueFindings':len(scan['residueFindings']),'artifacts':len(scan['artifacts'])}),flush=True)

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--cases',default='X11,X19,X21,XRJ2')
    parser.add_argument('--bridge-root',default='private/bridge');parser.add_argument('--generation',default='r2-c2');args=parser.parse_args()
    if args.bridge_root not in ['private/bridge','private/r2/bridges'] or not re.fullmatch(r'[a-z0-9-]+',args.generation):raise ValueError('Invalid audit location')
    for case in args.cases.split(','):audit_case(case,args.bridge_root,args.generation)

if __name__=='__main__':main()
