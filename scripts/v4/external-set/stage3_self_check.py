"""Record final, local-only acceptance evidence without changing frozen inputs."""
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import shutil
import subprocess

SUITE = Path('.devflow/external-set-suite').resolve()


def read(path):
    return json.loads(path.read_text(encoding='utf-8'))


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    manifest = read(SUITE / 'manifest.json')
    state = read(SUITE / 'stage3-state.json')
    inputs = read(SUITE / 'inputs.json')
    images = read(SUITE / 'images.json')
    assert all(x['readyForLive'] is True for x in [manifest, state, inputs, images])
    ids = [c['caseId'] for c in manifest['cases']]
    assert 20 <= len(ids) <= 24 and len(set(ids)) == len(ids)
    assert ids == state['cases'] == [c['caseId'] for c in inputs['cases']] == [c['caseId'] for c in images['cases']]
    assert manifest['receiptErrors'] == state['receiptErrors'] == []
    assert manifest['paidModelCalls'] == state['paidModelCalls'] == 0
    forbidden = {'patch', 'test_patch', 'gold_patch', 'goldPatch', 'testPatch', 'FAIL_TO_PASS', 'PASS_TO_PASS', 'evalScript'}

    def public_keys(value):
        if isinstance(value, dict):
            assert not forbidden.intersection(value), 'Private field in public material'
            for child in value.values():
                public_keys(child)
        elif isinstance(value, list):
            for child in value:
                public_keys(child)

    for value in [manifest, inputs, images]:
        public_keys(value)
    for fixture in inputs['cases']:
        public = SUITE / 'public' / fixture['caseId']
        assert fixture == read(public / 'fixture.json')
        assert fixture['snapshotSha256'] == sha(public / 'snapshot.json')
    contracts = read(SUITE / 'private/stage3/runtime-image-contracts.json')
    assert len(contracts) == len(ids) and all(c['passed'] for c in contracts)
    cleaned = []
    for receipt in (SUITE / 'private/stage3').glob('*/cleanup.json'):
        value = read(receipt)
        assert value['status'] == 'DELETED' and not (SUITE / value['path']).exists()
        cleaned.append(value)
    # Historical R2 exports were removed by their own separately recorded operation.
    historical = read(SUITE / 'private/r2/rootfs-cleanup.json')
    assert all(v['status'] == 'DELETED' and not (SUITE / v['path']).exists() for v in historical)
    tracked = subprocess.check_output(['git', 'diff', '--name-only', 'HEAD']).decode().splitlines()
    assert tracked == [], 'Tracked work changed; investigate rather than overwrite it'
    active = subprocess.check_output(['docker', 'ps', '-aq', '--filter', 'label=devflow.suite=external-set'], timeout=30).decode().splitlines()
    assert active == [], 'Owned temporary containers remain'
    tests = [
        ['python', '-B', '-X', 'utf8', '-m', 'unittest', 'discover', '-s', 'tests/external-set', '-p', 'test_*.py', '-v'],
        ['npx.cmd', '--no-install', 'vitest', 'run', 'tests/external-set', '--maxWorkers=2'],
        ['npx.cmd', '--no-install', 'tsc', '--project', 'scripts/v4/external-set/tsconfig.json'],
        ['npx.cmd', '--no-install', 'eslint', 'scripts/v4/external-set/*.ts', 'tests/external-set/*.ts'],
        ['npx.cmd', '--no-install', 'prettier', '--check', 'scripts/v4/external-set/*.ts', 'scripts/v4/external-set/*.json', 'tests/external-set/*.ts'],
    ]
    destination = SUITE / 'private/stage3/final-checks'
    destination.mkdir(exist_ok=True)
    results = []
    for index, command in enumerate(tests):
        result = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=180)
        log = destination / f'check-{index + 1}.log'
        log.write_bytes(result.stdout)
        results.append({'command': command, 'exitCode': result.returncode, 'log': log.relative_to(SUITE).as_posix(), 'sha256': sha(log)})
        assert result.returncode == 0, f'Engineering check failed; see {log}'
    source_paths = [p for root in ['scripts/v4/external-set', 'tests/external-set'] for p in Path(root).rglob('*') if p.is_file() and '__pycache__' not in p.parts]
    receipt = {
        'at': datetime.now(timezone.utc).isoformat(), 'passed': True,
        'frozenCases': len(ids), 'languages': manifest['languages'], 'paidModelCalls': 0,
        'manifestSha256': sha(SUITE / 'manifest.json'),
        'inputSha256': sha(SUITE / 'inputs.json'), 'imagesSha256': sha(SUITE / 'images.json'),
        'trackedDiff': tracked, 'ownedContainersRemaining': active, 'publicFieldCheck': 'PASS',
        'checks': results, 'sourceHashes': {p.as_posix(): sha(p) for p in source_paths},
        'rootfsCleanupFiles': len(cleaned) + len(historical),
        'rootfsCleanupBytes': sum(v['bytes'] for v in cleaned + historical),
        'hostDisk': dict(zip(['total', 'used', 'free'], shutil.disk_usage(SUITE))),
        'resources': manifest['resources'],
    }
    observed = read(SUITE / 'private/bootstrap/docker-host-vhdx-observation.json')
    vhdx = Path(observed['FullName'])
    if vhdx.exists():
        receipt['dockerVhdxLogicalBytes'] = vhdx.stat().st_size
    target = SUITE / 'private/stage3/final-self-check.json'
    target.write_text(json.dumps(receipt, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({k: receipt[k] for k in ['passed', 'frozenCases', 'languages', 'paidModelCalls', 'rootfsCleanupBytes']}))


if __name__ == '__main__':
    main()
