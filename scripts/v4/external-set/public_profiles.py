"""Choose checks using public base snapshots only; never open grading records."""
import argparse
import base64
import hashlib
import json
from pathlib import Path
import re

SUITE=Path('.devflow/external-set-suite')

def public_source(snapshot,path,needle):
    entry=next(f for f in snapshot['files'] if f['path']==path and f['kind']=='FILE')
    text=base64.b64decode(entry['contentBase64']).decode('utf-8')
    found=[(i,line) for i,line in enumerate(text.splitlines(),1) if needle in line]
    if not found:raise ValueError('Missing public command provenance: '+path)
    number,line=found[0]
    return {'path':path,'line':number,'quote':line.strip(),'sha256':entry['sha256']}

def proposal(fixture,snapshot):
    repo=fixture['source']['repo']
    exclusions=[];prechecks=[]
    environment={'CI':'true','NO_COLOR':'1'}
    if repo=='pylint-dev/pylint':
        if fixture['caseId']!='X11':
            raise ValueError('Additional pylint bases require their own public base failure log; never reuse X11 exclusions')
        sources=[public_source(snapshot,'.github/workflows/ci.yaml','pytest --benchmark-disable --cov --cov-report= tests/'),
                 public_source(snapshot,'setup.cfg','testpaths = tests')]
        # These IDs come solely from the prior *public* base test log. They are
        # not derived from the official hidden evaluation or its patch.
        log=SUITE/'private/bootstrap/public-profile-X11-correct-interpreter.log'
        text=log.read_text(encoding='utf-8')
        failures=re.findall(r'^FAILED (\S+)',text,re.M)
        if not failures:raise ValueError('No public base failure evidence')
        known_paths={f['path'] for f in snapshot['files']}
        if any(t.split('::')[0] not in known_paths for t in failures):raise ValueError('Failure outside public base')
        exclusions=[{'id':t,'reason':'Fails in unmodified public base and upstream image',
                     'evidence':'private/bootstrap/public-profile-X11-correct-interpreter.log',
                     'upstreamEvidence':'private/bootstrap/public-profile-X11-upstream-comparison.log'} for t in failures]
        program='/opt/miniconda3/envs/testbed/bin/python'
        arguments=['-m','pytest','-q','--benchmark-disable','tests/checkers']+[f'--deselect={t}' for t in failures]
        scope='CI covers tests/. Narrow to public tests/checkers for the Issue checker behaviour and <=120s; omit coverage instrumentation.'
    elif repo=='immutable-js/immutable-js':
        package=json.loads(base64.b64decode(next(f for f in snapshot['files'] if f['path']=='package.json')['contentBase64']))
        unit_script='test:unit' if 'test:unit' in package['scripts'] else 'unit-test' if 'unit-test' in package['scripts'] else None
        if not unit_script:raise ValueError('No public unit test script')
        sources=[public_source(snapshot,'.github/workflows/ci.yml','npm run '+unit_script),public_source(snapshot,'package.json','"'+unit_script+'":')]
        sources.append(public_source(snapshot,'.github/workflows/ci.yml','npm run build'))
        sources.append(public_source(snapshot,'package.json','"build:dist":'))
        sources.append(public_source(snapshot,'resources/dist-stats.mjs','bundlephobia'))
        prechecks=[{'kind':'build','command':{'program':'npm','args':['--offline','run','build:dist'],
                                            'cwd':'/workspace','timeoutMs':115000,'environment':environment}}]
        program='node';arguments=['node_modules/jest/bin/jest.js','--runInBand']
        scope='CI builds dist before unit tests. Use public build:dist, omitting unrelated build:stats that contacts bundlephobia; run complete test:unit/Jest suite under 2 CPU.'
    elif repo=='vuejs/core':
        sources=[public_source(snapshot,'.github/workflows/test.yml','pnpm run test-unit'),public_source(snapshot,'package.json','"test-unit":')]
        program='node';arguments=['node_modules/vitest/vitest.mjs','run','-c','vitest.unit.config.ts','--maxWorkers=2','--minWorkers=1']
        scope='Complete public test-unit suite from CI; no E2E/browser/network; limit worker parallelism to 2 CPU.'
    elif repo=='projectlombok/lombok':
        sources=[public_source(snapshot,'buildScripts/tests.ant.xml','<target name="test.compile"')]
        runtime=json.loads((SUITE/'public'/fixture['caseId']/'runtime-environment.json').read_text(encoding='utf-8'))['environment']
        environment.update(runtime)
        program='ant';arguments=['test.compile']
        scope='Public Ant compilation of project and tests; compile check only, semantic tests scored independently.'
    else:raise ValueError('No reviewed public command policy for '+repo)
    return {'version':1,'status':'PROPOSED','caseId':fixture['caseId'],'sourceBaseCommit':fixture['source']['baseCommit'],
            **({'runtimeEnvironment':runtime} if repo=='projectlombok/lombok' else {}),
            'checks':prechecks+[{'kind':'build' if program=='ant' else 'test','command':{'program':program,'args':arguments,
                        'cwd':'/workspace','timeoutMs':115000,'environment':environment}}],
            'sources':sources,'scopeReason':scope,'excludedBaseTests':exclusions,
            'selectionInputs':['public snapshot','public Issue','public base test logs'],
            'selectionPolicy':'No grading lists, patches or official scores used for command selection'}

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--cases',default='X11,X19,X21,XRJ2')
    parser.add_argument('--generation',default='r2');args=parser.parse_args()
    if not re.fullmatch(r'[a-z0-9-]+',args.generation):raise ValueError('Invalid generation')
    for case in args.cases.split(','):
        directory=SUITE/'public'/case
        fixture=json.loads((directory/'fixture.json').read_text(encoding='utf-8'))
        snapshot=json.loads((directory/'snapshot.json').read_text(encoding='utf-8'))
        profile=proposal(fixture,snapshot)
        encoded=json.dumps(profile,ensure_ascii=False,indent=2).encode('utf-8')
        output=directory/f'proposed-profile-{args.generation}.json'
        if output.exists() and output.read_bytes()!=encoded:raise RuntimeError('Proposal changed; create a new policy generation')
        output.write_bytes(encoded)
        print(json.dumps({'caseId':case,'profileSha256':hashlib.sha256(encoded).hexdigest(),'sources':profile['sources']}))

if __name__=='__main__':main()
