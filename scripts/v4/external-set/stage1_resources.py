"""Quote official images before any pull. A failed registry query never admits IO."""
import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
from pathlib import Path
import re
import subprocess
import time

SUITE = Path('.devflow/external-set-suite')
GIB = 1024**3
CAPS = {'Python':int(1.5*GIB),'JavaScript':2*GIB,'TypeScript':2*GIB,'Java':3*GIB}

def estimate_manifest(manifest):
    if 'manifests' in manifest:
        raise ValueError('Select and fetch a linux/amd64 child manifest before quoting')
    if not manifest.get('layers') or not manifest.get('config'):
        raise ValueError('Incomplete OCI manifest')
    layers = {}
    for descriptor in [manifest['config'], *manifest['layers']]:
        digest, size = descriptor['digest'], descriptor['size']
        if not re.fullmatch(r'sha256:[a-f0-9]{64}', digest) or type(size) is not int or size<0:
            raise ValueError('Invalid descriptor')
        if digest in layers and layers[digest] != size:
            raise ValueError('Conflicting layer identity')
        layers[digest] = size
    return layers

def admit(layers, existing, per_image_cap, batch_remaining):
    total = sum(layers.values())
    incremental = sum(size for digest,size in layers.items() if digest not in existing)
    return {'admitted':total<=per_image_cap and incremental<=batch_remaining,
            'compressedBytes':total,'incrementalBytes':incremental,
            'reason':'PER_IMAGE_CAP' if total>per_image_cap else 'BATCH_CAP' if incremental>batch_remaining else 'ADMITTED'}

def command(args):
    result = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=45)
    if result.returncode:
        raise RuntimeError(result.stderr.decode('utf-8','replace')[-1500:])
    return result.stdout

def inspect(candidate):
    start = time.monotonic()
    record = {'caseId':candidate['caseId'],'image':candidate['image'],'queriedAt':time.time(),'status':'UNKNOWN','pulled':False}
    try:
        display = command(['docker','buildx','imagetools','inspect',candidate['image']]).decode()
        digest = re.search(r'^Digest:\s+(sha256:[a-f0-9]{64})\s*$', display,re.M)
        if not digest: raise ValueError('Registry did not provide a manifest digest')
        reference = candidate['image'].split(':')[0]+'@'+digest[1]
        raw = command(['docker','buildx','imagetools','inspect','--raw',reference])
        manifest = json.loads(raw)
        if 'manifests' in manifest:
            options = [m for m in manifest['manifests'] if m.get('platform',{}).get('architecture')=='amd64' and m.get('platform',{}).get('os')=='linux']
            if len(options)!=1: raise ValueError('Ambiguous/missing linux/amd64 platform')
            reference = reference.split('@')[0]+'@'+options[0]['digest']
            raw = command(['docker','buildx','imagetools','inspect','--raw',reference])
            manifest = json.loads(raw)
        layers = estimate_manifest(manifest)
        (SUITE/'private/bootstrap'/f"{candidate['caseId']}.manifest.json").write_bytes(raw)
        record.update(status='MANIFEST_VERIFIED',pinnedReference=reference,layers=layers,
                      compressedBytes=sum(layers.values()),manifestFileSha256=hashlib.sha256(raw).hexdigest())
    except (RuntimeError,ValueError,subprocess.TimeoutExpired) as error:
        record.update(status='REGISTRY_UNAVAILABLE',error=str(error))
    record['durationSeconds'] = round(time.monotonic()-start,3)
    return record

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--cases',default='X11,X19,X21,X24')
    args=parser.parse_args()
    candidates=json.loads((SUITE/'stage1-candidates.json').read_text(encoding='utf-8'))['candidates']
    selected=[c for c in candidates if c['caseId'] in args.cases.split(',')]
    with ThreadPoolExecutor(max_workers=4) as pool:
        records=list(pool.map(inspect,selected))
    existing={}
    # Include every already downloaded T1 file and wheel; do not count unpacked copies as network IO.
    boot=SUITE/'private/bootstrap'
    downloaded=sum(e['bytes'] for e in json.loads((boot/'downloads.json').read_text(encoding='utf-8')))
    downloaded+=sum(p.stat().st_size for p in (boot/'wheels').glob('*.whl'))
    remaining=10*GIB-downloaded
    for c,r in zip(selected,records):
        if r['status']=='MANIFEST_VERIFIED':
            r['quote']=admit(r['layers'],existing,CAPS[c['language']],remaining)
            if r['quote']['admitted']:
                remaining-=r['quote']['incrementalBytes']
                existing.update(r['layers'])
    result={'recordedAt':time.time(),'t1DownloadedBytes':downloaded,'phase1CapBytes':10*GIB,
            'quotedRemainingBytes':remaining,'images':records,'pulledImages':0}
    (SUITE/'stage1-image-quotes.json').write_text(json.dumps(result,indent=2),encoding='utf-8')
    print(json.dumps(result))

if __name__=='__main__':main()
