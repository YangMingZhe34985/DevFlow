"""Primary-registry dates for non-core @vue namespace dependencies, not model input."""
import base64
import argparse
from datetime import datetime
import hashlib
import json
from pathlib import Path
import subprocess
import urllib.parse
from bootstrap import download

SUITE=Path('.devflow/external-set-suite')

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--case',default='X21');parser.add_argument('--audit',default='private/r2/audits/X21/strong-audit.json');args=parser.parse_args()
    case=args.case
    reference=(SUITE/args.audit).resolve()
    if not reference.is_relative_to((SUITE/'private/r2/audits').resolve()):raise ValueError('Invalid provenance audit reference')
    audit=json.loads(reference.read_text(encoding='utf-8'))
    packages=audit['dependencies']['packages'];own=set(audit['dependencies']['ownProjectNodeNames'])
    image=json.loads((SUITE/'private/bridge'/case/'image.json').read_text(encoding='utf-8'))
    if audit['imageId']!=image['imageId']:raise ValueError('Provenance image mismatch')
    command=['docker','run','--rm','--network','none','--label','devflow.suite=external-set',
        '--label','devflow.role=trusted-source-date','--entrypoint','git',image['upstream'],
        '-C','/testbed','show','-s','--format=%cI',image['sourceBaseCommit']]
    base_text=subprocess.check_output(command,timeout=45).decode('utf-8').strip();base=datetime.fromisoformat(base_text)
    snapshot=json.loads((SUITE/'public'/case/'snapshot.json').read_text(encoding='utf-8'))
    releases=[]
    for name,version in sorted({(p['name'],p['version']) for p in packages if str(p.get('name','')).startswith('@vue/') and p['name'] not in own}):
        canonical='https://registry.npmjs.org/'+urllib.parse.quote(name,safe='')
        metadata_path=download(canonical,'r2-npm-'+name.replace('/','_').replace('@','')+'.json',8*1024**2)
        metadata=json.loads(metadata_path.read_text(encoding='utf-8'))
        publication=metadata.get('time',{}).get(version)
        published=datetime.fromisoformat(publication.replace('Z','+00:00')) if publication else None
        declared=[]
        for entry in snapshot['files']:
            if entry['kind']!='FILE' or not entry['path'].endswith('package.json'):continue
            source=base64.b64decode(entry['contentBase64']).decode('utf-8')
            for line_no,line in enumerate(source.splitlines(),1):
                if '"'+name+'"' in line:
                    declared.append({'path':entry['path'],'line':line_no,'quote':line.strip(),'sha256':entry['sha256']})
        release=metadata['versions'][version]
        repository=release.get('repository',{})
        repository=repository.get('url','') if isinstance(repository,dict) else str(repository)
        approved=bool(published and published<base and declared and 'vuejs/core' not in repository)
        releases.append({'name':name,'version':version,'publication':publication,'baseDate':base_text,
                         'approved':approved,'registryUrl':canonical,'registryMetadataSha256':hashlib.sha256(metadata_path.read_bytes()).hexdigest(),
                         'registryMetadataFile':str(metadata_path),'repository':repository,'publicDeclarations':declared,
                         'distIntegrity':release.get('dist',{}).get('integrity'),
                         'rule':'Only separately published dependencies with a public base declaration and publication before base; core workspace packages must remain workspace links'})
    output=SUITE/'private/r2/release-provenance';output.mkdir(parents=True,exist_ok=True)
    (output/(case+'.json')).write_text(json.dumps({'caseId':case,'releases':releases},ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps({'releases':len(releases),'approved':sum(r['approved'] for r in releases)}))

if __name__=='__main__':main()
