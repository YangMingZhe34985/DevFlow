"""Preserve only non-secret compiler selectors from the official image."""
import hashlib
import json
from pathlib import Path
import re
import subprocess

SUITE=Path('.devflow/external-set-suite')

def main():
    image=json.loads((SUITE/'private/bridge/XRJ2/image.json').read_text(encoding='utf-8'))
    raw=subprocess.check_output(['docker','image','inspect',image['upstream'],'--format','{{json .Config.Env}}'],timeout=45)
    pairs=dict(line.split('=',1) for line in json.loads(raw) if '=' in line)
    environment={key:pairs[key] for key in ['JAVA_HOME','PATH']}
    if not re.fullmatch(r'/[a-zA-Z0-9/_.-]+',environment['JAVA_HOME']) or any(not re.fullmatch(r'/[a-zA-Z0-9/_.-]+',p) for p in environment['PATH'].split(':')):
        raise RuntimeError('Unexpected compiler selector format')
    version=subprocess.check_output(['docker','run','--rm','--network','none','--label','devflow.suite=external-set',
        '--label','devflow.role=trusted-toolchain-inspection','--entrypoint',environment['JAVA_HOME']+'/bin/javac',
        image['upstream'],'-version'],stderr=subprocess.STDOUT,timeout=45).decode('utf-8').strip()
    output={'environment':environment,'sourceImage':image['upstream'],'javacVersion':version,
            'policy':'Only official JAVA_HOME/PATH preserved; no credentials/proxy settings copied'}
    (SUITE/'public/XRJ2/runtime-environment.json').write_text(json.dumps(output,indent=2),encoding='utf-8')
    print(json.dumps({'caseId':'XRJ2','javacVersion':version,'keys':list(environment)}))

if __name__=='__main__':main()
