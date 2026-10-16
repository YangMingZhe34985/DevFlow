"""Pull only prequoted immutable images; persist reservations before dispatch."""
import json
from pathlib import Path
import subprocess
import time

SUITE=Path('.devflow/external-set-suite')

def main():
    quotes=json.loads((SUITE/'stage1-image-quotes.json').read_text(encoding='utf-8'))
    ledger=SUITE/'private/bootstrap/image-acquisition.json'
    state=json.loads(ledger.read_text(encoding='utf-8')) if ledger.exists() else {'images':[],'createdBy':'external-set'}
    settled={r['caseId']:r for r in state['images']}
    for item in quotes['images']:
        if not item.get('quote',{}).get('admitted'):
            continue
        if item['caseId'] in settled:
            if settled[item['caseId']]['status']!='SETTLED':
                raise RuntimeError('Prior pull has unknown consumption; inspect it before continuing')
            continue
        total_reserved=sum(i['reservedCompressedBytes'] for i in state['images'])
        if total_reserved+quotes['t1DownloadedBytes']+item['quote']['incrementalBytes']>10*1024**3:
            raise RuntimeError('Existing and new image reservations exceed the Stage-1 cap')
        record={'caseId':item['caseId'],'pinnedReference':item['pinnedReference'],
                'reservedCompressedBytes':item['quote']['incrementalBytes'],
                'status':'DISPATCHED','startedAt':time.time()}
        state['images'].append(record)
        ledger.write_text(json.dumps(state,indent=2),encoding='utf-8')
        log=SUITE/'private/bootstrap'/f"pull-{item['caseId']}.log"
        with log.open('wb') as output:
            result=subprocess.run(['docker','pull','--platform','linux/amd64',item['pinnedReference']],stdout=output,stderr=subprocess.STDOUT,timeout=1800)
        record['finishedAt']=time.time()
        if result.returncode:
            record['status']='FAILED_UNKNOWN_CONSUMPTION'
            ledger.write_text(json.dumps(state,indent=2),encoding='utf-8')
            raise RuntimeError('Image pull failed; reserved upper bound retained')
        identity=json.loads(subprocess.check_output(['docker','image','inspect',item['pinnedReference']]))[0]
        if identity['Architecture']!='amd64' or identity['Os']!='linux':
            raise RuntimeError('Image platform mismatch')
        local_tag=f"devflow-external-set/upstream-{item['caseId'].lower()}:frozen"
        subprocess.run(['docker','tag',item['pinnedReference'],local_tag],check=True)
        record.update(status='SETTLED',imageId=identity['Id'],repoDigests=identity['RepoDigests'],
                      uncompressedBytes=identity['Size'],localTag=local_tag)
        ledger.write_text(json.dumps(state,indent=2),encoding='utf-8')
        print(json.dumps({k:record[k] for k in ['caseId','status','imageId','uncompressedBytes']}),flush=True)

if __name__=='__main__':main()
