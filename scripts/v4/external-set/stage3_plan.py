"""Stage-three manifest/resource discovery only. Does not pull or freeze cases."""
from concurrent.futures import ThreadPoolExecutor
import importlib.util
import json
from pathlib import Path
import time

SUITE=Path('.devflow/external-set-suite')
def read(p):return json.loads(p.read_text(encoding='utf-8'))
def main():
    if read(SUITE/'stage2-state.json').get('readyForStage3') is not True:raise RuntimeError('Stage-two R2 gate is not complete')
    spec=importlib.util.spec_from_file_location('resources',Path(__file__).with_name('stage1_resources.py'))
    resources=importlib.util.module_from_spec(spec);spec.loader.exec_module(resources)
    candidates=read(SUITE/'stage1-candidates.json')['candidates']
    wanted={f'X{i:02d}' for i in range(1,23)}|{'XRJ2'}
    selected=[c for c in candidates if c['caseId'] in wanted]
    settled={c['caseId']:c for c in read(SUITE/'private/bootstrap/image-acquisition.json')['images']}
    def quote(candidate):
        old=settled.get(candidate['caseId'])
        if old and old['status']=='SETTLED':
            return {'caseId':candidate['caseId'],'status':'ALREADY_ACQUIRED','pinnedReference':old['pinnedReference'],
                    'compressedBytes':old['reservedCompressedBytes'],'pulled':False}
        return resources.inspect(candidate)
    with ThreadPoolExecutor(max_workers=4) as pool:quotes=list(pool.map(quote,selected))
    batches={'A':12*1024**3,'B':int(9.5*1024**3),'C':int(9.5*1024**3),'D':10*1024**3}
    totals={b:0 for b in batches}
    def batch(case):
        n=int(case[1:]) if case[1:].isdigit() else 24
        return 'B' if 1<=n<=5 or n==19 else 'C' if 6<=n<=10 or n==20 else 'D' if 15<=n<=18 or n in [21,22] else 'A'
    # Failed/replaced acquisitions remain charged, without imaginary layer savings.
    for case,entry in settled.items():totals[batch(case)]+=entry['reservedCompressedBytes']
    boot=SUITE/'private/bootstrap'
    tooling=sum(e['bytes'] for e in read(boot/'downloads.json'))+sum(p.stat().st_size for p in (boot/'wheels').glob('*.whl'))
    grand=sum(totals.values())+tooling
    for c,q in zip(selected,quotes):
        b=batch(c['caseId']);q['batch']=b
        if q['status']=='ALREADY_ACQUIRED':q['resourceAdmitted']=True;continue
        if q['status']!='MANIFEST_VERIFIED':q['resourceAdmitted']=False;continue
        size=q['compressedBytes']
        q['resourceAdmitted']=size<=resources.CAPS[c['language']] and totals[b]+size<=batches[b] and grand+size<=41*1024**3
        if q['resourceAdmitted']:totals[b]+=size;grand+=size
        else:q['stopReason']='PER_IMAGE_OR_BATCH_OR_TOTAL_CAP'
    result={'at':time.time(),'status':'RESOURCE_QUOTES_ONLY','readyForLive':False,'downloadPerformed':False,
            'frozenCount':0,'candidateCount':len(selected),'batchQuotedBytes':totals,'batchCaps':batches,
            'grandQuotedBytesIncludingTools':grand,'grandCapBytes':41*1024**3,'images':quotes,
            'remaining':'Acquire admitted images using a phase-three persistent ledger; all additional controls/profiles/strong audits still required. Quotes are not acceptance.'}
    target=SUITE/'private/r2/stage3-resource-plan.json'
    if target.exists():raise RuntimeError('Quote generation already exists; preserve it')
    target.write_text(json.dumps(result,indent=2),encoding='utf-8')
    print(json.dumps({'candidateCount':len(selected),'manifestVerified':sum(q['status'] in ['ALREADY_ACQUIRED','MANIFEST_VERIFIED'] for q in quotes),
                      'resourceAdmitted':sum(q.get('resourceAdmitted',False) for q in quotes),'readyForLive':False}))

if __name__=='__main__':main()
