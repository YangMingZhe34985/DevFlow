"""Acquire a pinned, checksummed Linux Node tool for non-JS official images."""
import hashlib
import json
import tarfile
from bootstrap import ROOT, download, used_bytes

def main():
    version='v22.20.0'
    base=f'https://nodejs.org/dist/{version}'
    sums=download(base+'/SHASUMS256.txt','node-SHASUMS256.txt',128*1024)
    filename=f'node-{version}-linux-x64.tar.xz'
    expected=next(line.split()[0] for line in sums.read_text(encoding='utf-8').splitlines() if line.split()[-1]==filename)
    archive=download(base+'/'+filename,filename,45*1024**2)
    actual=hashlib.sha256(archive.read_bytes()).hexdigest()
    if actual!=expected:raise RuntimeError('Node archive checksum mismatch')
    destination=ROOT/'node-seed'
    destination.mkdir(exist_ok=True)
    with tarfile.open(archive) as bundle:
        member=bundle.getmember(filename.removesuffix('.tar.xz')+'/bin/node')
        with bundle.extractfile(member) as source,(destination/'node').open('wb') as target:
            target.write(source.read())
    result={'version':version,'archiveSha256':actual,'verifiedAgainst':'https://nodejs.org/dist/'+version+'/SHASUMS256.txt',
            'binarySha256':hashlib.sha256((destination/'node').read_bytes()).hexdigest(),'t1DownloadedBytes':used_bytes()}
    (destination/'identity.json').write_text(json.dumps(result,indent=2),encoding='utf-8')
    print(json.dumps(result))

if __name__=='__main__':main()
