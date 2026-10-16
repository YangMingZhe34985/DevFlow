"""Execute a previously frozen public proposal; observations always stay private."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import time
import uuid

SUITE=Path('.devflow/external-set-suite')

def command(args,timeout=45):
    result=subprocess.run(args,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,timeout=timeout)
    if result.returncode:raise RuntimeError(result.stdout.decode('utf-8','replace')[-1500:])
    return result.stdout

def run(case,profile,image,variant,repeat,generation='r2'):
    encoded=json.dumps(profile,sort_keys=True).encode('utf-8')
    directory=SUITE/'private/r2/profiles'/generation/case/(variant+'-'+str(repeat))
    directory.mkdir(parents=True,exist_ok=True)
    result_path=directory/'result.json'
    profile_sha=hashlib.sha256(encoded).hexdigest()
    if result_path.exists():
        saved=json.loads(result_path.read_text(encoding='utf-8'))
        if saved['imageId']!=image or saved['profileSha256']!=profile_sha:raise RuntimeError('Control identity changed')
        return saved
    started=time.monotonic();cid=None
    result={'caseId':case,'variant':variant,'repeat':repeat,'profileSha256':profile_sha,'imageId':image,
            'network':'none','user':'10001','passed':False,'checks':[]}
    try:
        environment_args=[argument for key,value in profile.get('runtimeEnvironment',{}).items() for argument in ['-e',key+'='+value]]
        cid=command(['docker','create','--name','devflow-external-profile-'+uuid.uuid4().hex[:10],
            '--label','devflow.suite=external-set','--label','devflow.role='+('trusted-profile-gold' if variant=='gold' else 'public-profile'),
            '--network','none','--cpus','2','--memory','4g','--memory-swap','4g','--pids-limit','512','--user','10001:10001',
            *environment_args,
            '--entrypoint','/bin/bash',image,'-c','sleep infinity']).decode('utf-8').strip()
        command(['docker','start',cid])
        inspected=json.loads(command(['docker','inspect',cid]))[0]
        if inspected['HostConfig']['NetworkMode']!='none':raise RuntimeError('Network isolation failed')
        host=inspected['HostConfig']
        result['resources']={'cpuCount':host['NanoCpus']/1_000_000_000,'memoryBytes':host['Memory'],'memorySwapBytes':host['MemorySwap'],'pids':host['PidsLimit']}
        if result['resources']!={'cpuCount':2,'memoryBytes':4*1024**3,'memorySwapBytes':4*1024**3,'pids':512}:raise RuntimeError('Public profile resources differ from solver')
        if variant=='gold':
            fixture=json.loads((SUITE/'public'/case/'fixture.json').read_text(encoding='utf-8'))
            patch=SUITE/'private'/fixture['source']['instanceId']/'gold.patch'
            result['candidateSha256']=hashlib.sha256(patch.read_bytes()).hexdigest()
            command(['docker','cp',str(patch.resolve()),cid+':/candidate.patch'])
            command(['docker','exec','-w','/workspace',cid,'git','apply','--check','/candidate.patch'])
            command(['docker','exec','-w','/workspace',cid,'git','apply','/candidate.patch'])
        check_started=time.monotonic()
        for i,check in enumerate(profile['checks']):
            c=check['command']
            remaining=min(115,int(119-(time.monotonic()-check_started)))
            if remaining<1:raise RuntimeError('Public profile time exhausted')
            args=['docker','exec','-w',c.get('cwd','/workspace')]
            for key,value in c.get('environment',{}).items():args+=['-e',key+'='+value]
            args+=[cid,'timeout','--signal=TERM','--kill-after=2',str(remaining),c['program'],*c['args']]
            tick=time.monotonic()
            observation=subprocess.run(args,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,timeout=remaining+5)
            (directory/f'check-{i}.log').write_bytes(observation.stdout)
            elapsed=time.monotonic()-tick
            result['checks'].append({'kind':check['kind'],'exitCode':observation.returncode,'seconds':round(elapsed,3)})
            if observation.returncode or elapsed>120:break
        result['checkSeconds']=round(time.monotonic()-check_started,3)
        result['passed']=len(result['checks'])==len(profile['checks']) and all(c['exitCode']==0 for c in result['checks']) and result['checkSeconds']<=120
    except (RuntimeError,subprocess.TimeoutExpired) as error:result['error']=str(error)
    finally:
        if cid:
            info=json.loads(command(['docker','inspect',cid]))[0]
            if info['Config']['Labels'].get('devflow.suite')!='external-set':raise RuntimeError('Ownership mismatch')
            command(['docker','rm','-f',cid]);result['cleanup']='PASS'
        result['durationSeconds']=round(time.monotonic()-started,3)
        result_path.write_text(json.dumps(result,indent=2),encoding='utf-8')
    return result

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--cases',default='X11,X19,X21,XRJ2')
    parser.add_argument('--generation',default='r2')
    parser.add_argument('--bridge-root',choices=['private/bridge','private/r2/bridges'])
    parser.add_argument('--variant',choices=['base','gold'],default='base');args=parser.parse_args()
    for case in args.cases.split(','):
        public=SUITE/'public'/case
        profile=json.loads((public/f'proposed-profile-{args.generation}.json').read_text(encoding='utf-8'))
        fixture=json.loads((public/'fixture.json').read_text(encoding='utf-8'))
        image=fixture['imageId']
        if args.bridge_root:
            bridge=json.loads((SUITE/args.bridge_root/case/'image.json').read_text(encoding='utf-8'))
            if bridge['sourceBaseCommit']!=fixture['source']['baseCommit']:raise RuntimeError('Profile source mismatch')
            image=bridge['imageId']
        results=[]
        for repeat in range(1,4 if args.variant=='base' else 2):
            result=run(case,profile,image,args.variant,repeat,generation=args.generation);results.append(result)
            print(json.dumps({k:result.get(k) for k in ['caseId','variant','repeat','passed','checkSeconds','error']}),flush=True)
            if not result['passed']:break
        if args.variant=='base' and len(results)==3 and all(r['passed'] for r in results):
            # Public status reflects only base stability, never the private gold observation.
            profile['status']='CONFIGURED'
            (public/'public-profile.json').write_text(json.dumps(profile,ensure_ascii=False,indent=2),encoding='utf-8')
            fixture['publicChecks']=profile
            (public/'fixture.json').write_text(json.dumps(fixture,ensure_ascii=False,indent=2),encoding='utf-8')

if __name__=='__main__':main()
