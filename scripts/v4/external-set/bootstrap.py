"""Stage-1 metadata acquisition only. No model calls or container execution.

All upstream task fields (including answers) remain under private/. Downloads are
bounded and pinned before reading task contents. Run from the DevFlow repository.
"""
import hashlib
import argparse
import json
from pathlib import Path
import urllib.request
import zipfile

ROOT = Path('.devflow/external-set-suite/private/bootstrap')
ROOT.mkdir(parents=True, exist_ok=True)
LEDGER = ROOT / 'downloads.json'
entries = json.loads(LEDGER.read_text(encoding='utf-8')) if LEDGER.exists() else []
CAP = 300 * 1024**2

def used_bytes():
    return sum(e['bytes'] for e in entries) + sum(p.stat().st_size for p in (ROOT/'wheels').glob('*.whl'))

def download(url, filename, cap, canonical_url=None):
    target = ROOT / filename
    if target.exists():
        prior=next((e for e in entries if e['file']==str(target)),None)
        if prior and hashlib.sha256(target.read_bytes()).hexdigest()!=prior['sha256']:
            raise RuntimeError('Cached download SHA differs from recorded provenance')
        if not any(e['file'] == str(target) for e in entries):
            entries.append({'url': url, 'canonicalUrl': canonical_url or url,
                            'file': str(target), 'bytes': target.stat().st_size,
                            'sha256': hashlib.sha256(target.read_bytes()).hexdigest()})
            LEDGER.write_text(json.dumps(entries, indent=2), encoding='utf-8')
        return target
    req = urllib.request.Request(url, headers={'User-Agent': 'DevFlow-external-set-build'})
    size = 0
    temporary = target.with_suffix(target.suffix + '.partial')
    with urllib.request.urlopen(req, timeout=90) as response, temporary.open('wb') as output:
        declared = int(response.headers.get('Content-Length', '0'))
        if declared > cap or used_bytes() + declared > CAP:
            raise RuntimeError('T1 download budget exceeded before acquisition')
        while chunk := response.read(1024 * 1024):
            size += len(chunk)
            if size > cap or used_bytes() + size > CAP:
                raise RuntimeError('T1 download budget exceeded while streaming')
            output.write(chunk)
    temporary.replace(target)
    entries.append({'url': url, 'canonicalUrl': canonical_url or url, 'file': str(target), 'bytes': size,
                    'sha256': hashlib.sha256(target.read_bytes()).hexdigest()})
    LEDGER.write_text(json.dumps(entries, indent=2), encoding='utf-8')
    return target

def main():
    args = argparse.ArgumentParser()
    args.add_argument('--hf-endpoint', default='https://huggingface.co')
    endpoint = args.parse_args().hf_endpoint.rstrip('/')
    for name in ['SWE-bench_Verified', 'SWE-bench_Multilingual']:
        meta_path = download(f'{endpoint}/api/datasets/SWE-bench/{name}', name+'.metadata.json', 1024**2,
                             f'https://huggingface.co/api/datasets/SWE-bench/{name}')
        meta = json.loads(meta_path.read_text(encoding='utf-8'))
        revision = meta['sha']
        for entry in meta['siblings']:
            filename = entry['rfilename']
            if filename.endswith('.parquet'):
                tree_path = download(f'{endpoint}/api/datasets/SWE-bench/{name}/tree/{revision}/data', name+'.tree.json', 1024**2)
                tree = json.loads(tree_path.read_text(encoding='utf-8'))
                expected = next(t['lfs']['oid'] for t in tree if t['path'] == filename)
                parquet = download(f'{endpoint}/datasets/SWE-bench/{name}/resolve/{revision}/{filename}', name+'.parquet', 30*1024**2,
                                  f'https://huggingface.co/datasets/SWE-bench/{name}/resolve/{revision}/{filename}')
                if hashlib.sha256(parquet.read_bytes()).hexdigest() != expected:
                    raise RuntimeError('Dataset LFS hash mismatch')
        print(json.dumps({'dataset': name, 'revision': revision}))
    commit_path = download('https://api.github.com/repos/SWE-bench/SWE-bench/commits/main', 'harness-commit.json', 1024**2)
    revision = json.loads(commit_path.read_text(encoding='utf-8'))['sha']
    archive = download(f'https://codeload.github.com/SWE-bench/SWE-bench/zip/{revision}', 'harness.zip', 30*1024**2)
    extraction = (ROOT/'harness-source').resolve()
    extraction.mkdir(exist_ok=True)
    with zipfile.ZipFile(archive) as bundle:
        for info in bundle.infolist():
            if not (extraction/info.filename).resolve().is_relative_to(extraction):
                raise RuntimeError('Unsafe archive path')
        bundle.extractall(extraction)
    print(json.dumps({'harnessCommit': revision, 'downloadedBytes': sum(e['bytes'] for e in entries)}))

if __name__ == '__main__':
    main()
