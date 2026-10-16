"""Public-only module selection, provenance and baseline calibration. No grader imports."""
import argparse
import base64
import hashlib
import importlib.util
import json
from pathlib import Path
import re

SUITE=Path('.devflow/external-set-suite')
def load(name):
    spec=importlib.util.spec_from_file_location(name,Path(__file__).with_name(name+'.py'));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m
def read(p):return json.loads(p.read_text(encoding='utf-8'))
def files_text(snapshot):return {f['path']:base64.b64decode(f['contentBase64']).decode('utf-8','replace') for f in snapshot['files'] if f['kind']=='FILE'}
def source(snapshot,paths,pattern):
    for f in snapshot['files']:
        if f['kind']!='FILE' or f['path'] not in paths:continue
        for number,line in enumerate(base64.b64decode(f['contentBase64']).decode('utf-8','replace').splitlines(),1):
            if re.search(pattern,line):return {'path':f['path'],'line':number,'quote':line.strip(),'sha256':f['sha256']}
    raise ValueError('No base command provenance')
def proposal(fixture,snapshot):
    repo=fixture['source']['repo'];texts=files_text(snapshot);paths=set(texts);issue=fixture['task']['description'].lower();title=issue.splitlines()[0]
    if repo in ['immutable-js/immutable-js','vuejs/core']:return load('public_profiles').proposal(fixture,snapshot)
    python='/opt/miniconda3/envs/testbed/bin/python';arguments=['-m','pytest','-q'];scope=[]
    ci=[p for p in paths if p.startswith(('.github/workflows/','.travis')) or p in ['tox.ini','setup.cfg','pyproject.toml','README.rst','CONTRIBUTING.rst','CONTRIBUTING.md']]
    sources=[]
    if repo!='sympy/sympy':
        try:sources=[source(snapshot,ci,r'pytest[^\n]*(?:--cov|\{posargs|\{toxinidir|\btesting/)')]
        except ValueError:sources=[source(snapshot,ci,r'(?:^\s*pytest\s|run:\s*.*pytest|python[^#]*-m\s+pytest)')]
    if repo=='pylint-dev/pylint':
        if any('--benchmark-disable' in texts[p] for p in ci):arguments.append('--benchmark-disable')
        if 'uml' in title or 'pyreverse' in issue:
            scope=['tests/pyreverse'] if any(p.startswith('tests/pyreverse/') for p in paths) else sorted(p for p in paths if p.startswith('tests/') and 'pyreverse' in p.split('/')[-1] and p.endswith('.py'))
        elif 'directory specification' in title or 'data storage' in issue:scope=[p for p in ['tests/test_config.py','tests/unittest_config.py','tests/config'] if p in paths or any(x.startswith(p+'/') for x in paths)]
        else:scope=['tests/lint']
    elif repo=='pytest-dev/pytest':
        if 'collect' in title:patterns=['test_collection.py']
        elif 'xfail' in title:patterns=['test_skipping.py']
        elif 'headline' in title or 'report' in title:patterns=['test_terminal.py']
        else:patterns=['test_mark.py','test_mark_expression.py']
        scope=[p for p in paths if p.startswith('testing/') and p.split('/')[-1] in patterns]
    elif repo=='sphinx-doc/sphinx':
        if 'translation' in title:patterns=['test_intl.py','test_locale.py']
        elif 'include' in title:patterns=['test_events.py','test_directive_code.py','test_build_html.py']
        elif 'alias' in title:patterns=['test_ext_autodoc.py','test_domain_py.py']
        else:patterns=['test_domain_py.py','test_ext_autodoc.py']
        scope=[p for p in paths if p.startswith('tests/') and p.split('/')[-1] in patterns]
    elif repo=='sympy/sympy':
        # SymPy's documented runner is its own bin/test, not a private grading command.
        sources=[source(snapshot,[p for p in paths if p in ['README.rst','README.md','CONTRIBUTING.md','setup.py','bin/test'] or p.startswith(('.github/workflows/','.ci/'))],r'bin/test|sympy\.test')]
        arguments=['bin/test']
        if 'vector' in title:scope=['sympy/physics/vector/tests']
        elif 'conditionset' in title or 'imageset' in title:scope=['sympy/sets/tests']
        elif 'codegen' in title or 'string' in title:
            scope=['sympy/codegen/tests/test_ast.py'] if 'codegen.ast' in issue and 'sympy/codegen/tests/test_ast.py' in paths else ['sympy/codegen/tests']
        else:scope=['sympy/core/tests/test_subs.py']
    else:raise ValueError('Use previously reviewed JS/TS profile policy')
    if not scope or any(p not in paths and not any(x.startswith(p+'/') for x in paths) for p in scope):raise ValueError('No matching public module tests')
    return {'version':1,'status':'PROPOSED','caseId':fixture['caseId'],'sourceBaseCommit':fixture['source']['baseCommit'],
            'checks':[{'kind':'test','command':{'program':python,'args':arguments+sorted(scope),'cwd':'/workspace','timeoutMs':115000,'environment':{'CI':'true','NO_COLOR':'1'}}}],
            'sources':sources,'scopeReason':'Public Issue topic '+repr(title)+' mapped to public module tests: '+', '.join(sorted(scope))+'. No private material used.',
            'excludedBaseTests':[],'selectionInputs':['public Issue','public base snapshot and CI/config','public base failure logs only']}
def main():
    parser=argparse.ArgumentParser();parser.add_argument('--cases',required=True);parser.add_argument('--generation-prefix',default='stage3-public');args=parser.parse_args();validate=load('profile_validate')
    if not re.fullmatch(r'[a-z0-9-]+',args.generation_prefix):raise ValueError('Invalid calibration generation')
    for case in args.cases.split(','):
        public=SUITE/'public'/case;fixture=read(public/'fixture.json');snapshot=read(public/'snapshot.json')
        profile=proposal(fixture,snapshot)
        for attempt in range(3):
            generation=args.generation_prefix+'-'+str(attempt)
            proposed=public/f'proposed-profile-{generation}.json'
            encoded=json.dumps(profile,ensure_ascii=False,indent=2)
            if proposed.exists() and proposed.read_text(encoding='utf-8')!=encoded:raise RuntimeError('Calibration identity changed')
            proposed.write_text(encoded,encoding='utf-8')
            results=[]
            for repeat in range(1,4):
                result=validate.run(case,profile,fixture['imageId'],'base',repeat,generation)
                results.append(result)
                if not result['passed']:break
            if len(results)==3 and all(r['passed'] for r in results):
                configured={**profile,'status':'CONFIGURED'}
                (public/'public-profile.json').write_text(json.dumps(configured,ensure_ascii=False,indent=2),encoding='utf-8')
                fixture['publicChecks']=configured;(public/'fixture.json').write_text(json.dumps(fixture,ensure_ascii=False,indent=2),encoding='utf-8')
                receipt={'caseId':case,'generation':generation,'profileSha256':hashlib.sha256(json.dumps(profile,sort_keys=True).encode('utf-8')).hexdigest(),'imageId':fixture['imageId'],'basePassed':True}
                (SUITE/'private/bridge'/case/'public-gate.json').write_text(json.dumps(receipt,indent=2),encoding='utf-8')
                print(json.dumps({'caseId':case,'publicBase3':'PASS','generation':generation}),flush=True);break
            log_dir=SUITE/'private/r2/profiles'/generation/case/('base-'+str(len(results)))
            text='\n'.join(p.read_text(encoding='utf-8',errors='replace') for p in log_dir.glob('check-*.log'))
            failed=list(dict.fromkeys(line.removeprefix('FAILED ').split(' - ',1)[0].strip() for line in text.splitlines() if line.startswith('FAILED ')))
            if not failed or fixture['source']['repo']=='sympy/sympy':
                print(json.dumps({'caseId':case,'publicBase3':'FAIL','evidence':str(log_dir),'reason':'Needs public command/environment investigation'}),flush=True);break
            for node in failed:
                if node.split('::')[0] not in {f['path'] for f in snapshot['files']}:raise RuntimeError('Failure does not identify public base test')
                profile['checks'][0]['command']['args'].append('--deselect='+node)
                profile['excludedBaseTests'].append({'id':node,'reason':'Observed failure in exact unmodified public base image','evidence':str(log_dir.relative_to(SUITE))})

if __name__=='__main__':main()
