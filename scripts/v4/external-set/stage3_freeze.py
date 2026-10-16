"""Validate all underlying receipts, publish public identities; report each batch."""
import argparse
import base64
from datetime import datetime,timezone
import hashlib
import json
from pathlib import Path
import subprocess

SUITE=Path('.devflow/external-set-suite')
def read(p):return json.loads(p.read_text(encoding='utf-8'))
def write(p,v):p.write_text(json.dumps(v,ensure_ascii=False,indent=2),encoding='utf-8')
def digest(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def official_gate(rows,image):
    return len(rows)==5 and {(r['variant'],r['repeat']) for r in rows}=={('base-test',1),('empty',1),('gold',1),('gold',2),('gold',3)} and all(
        r['status']=='VALID' and r['network']=='none' and r['image']==image and r['durationSeconds']<=300
        and r['officialResolved']==(r['variant']=='gold') and r['strictPatchPass']==(r['variant']=='gold') for r in rows)
def main():
    parser=argparse.ArgumentParser();parser.add_argument('--batch',choices=list('ABCD'),required=True);parser.add_argument('--final',action='store_true');args=parser.parse_args()
    catalog=read(SUITE/'stage1-candidates.json')['candidates'];old=read(SUITE/'stage1-state.json')
    active=read(SUITE/'private/r2/active-bridges.json')
    stage2_ids={c['caseId'] for c in read(SUITE/'stage2-state.json')['cases']}
    acquired={x['caseId']:x for x in read(SUITE/'private/bootstrap/image-acquisition.json')['images']}
    cases=[];errors=[];timings={}
    if any(x.get('status')!='SETTLED' for x in acquired.values()):errors.append({'caseId':'RESOURCE_LEDGER','reason':'Unknown acquisition consumption remains reserved'})
    for c in catalog:
        case=c['caseId'];accept=SUITE/'private/stage3'/case/'accepted.json'
        if case not in active and not accept.exists():continue
        try:
            existing=case in stage2_ids
            bridge=SUITE/(active[case] if existing else 'private/bridge/'+case)
            image=read(bridge/'image.json');fixture=read(SUITE/'public'/case/'fixture.json')
            snapshot_path=SUITE/'public'/case/'snapshot.json';profile_path=SUITE/'public'/case/'public-profile.json';profile=read(profile_path)
            if image['imageId']!=fixture['imageId'] or image['sourceBaseCommit']!=c['baseCommit'] or fixture['snapshotSha256']!=digest(snapshot_path):raise ValueError('Fixture identity changed')
            if profile!=fixture['publicChecks'] or profile['status']!='CONFIGURED' or profile['sourceBaseCommit']!=c['baseCommit']:raise ValueError('Profile differs')
            snapshot=read(snapshot_path);by_path={f['path']:f for f in snapshot['files']}
            for source in profile['sources']:
                f=by_path[source['path']];text=base64.b64decode(f['contentBase64']).decode('utf-8')
                if f['sha256']!=source['sha256'] or text.splitlines()[source['line']-1].strip()!=source['quote']:raise ValueError('Public provenance mismatch')
            if existing:
                campaign=next(o['campaign'] for o in old['cases'] if o['caseId']==case)
                rows=[read(SUITE/'private/preflight'/campaign/case/(v+'-'+str(r))/'result.json') for v,r in [('base-test',1),('gold',1),('gold',2),('gold',3),('empty',1)]]
                compatible=read(bridge/'rootfs-audit.json')
                receipts=[read(SUITE/ref) for ref in compatible['privateProfileReceipts']]
                proposed={**profile,'status':'PROPOSED'}
            else:
                accepted=read(accept);rows=read(SUITE/accepted['officialControls']);compatible=read(bridge/'rootfs-audit.json')
                generation=accepted['profileGeneration'];proposed=read(SUITE/'public'/case/f'proposed-profile-{generation}.json')
                receipts=[read(SUITE/'private/r2/profiles'/generation/case/label/'result.json') for label in ['base-1','base-2','base-3','gold-1']]
                cleanup=read(SUITE/'private/stage3'/case/'cleanup.json')
                if cleanup['status']!='DELETED' or (bridge/'rootfs.tar').exists():raise ValueError('Audit export cleanup incomplete')
            if not official_gate(rows,acquired[case]['pinnedReference']):raise ValueError('Official gate failed')
            resource_receipts=SUITE/'private/stage3'/case/'resource-profile-receipts.json'
            if resource_receipts.exists():receipts=[read(SUITE/ref) for ref in read(resource_receipts)]
            profile_sha=hashlib.sha256(json.dumps(proposed,sort_keys=True).encode('utf-8')).hexdigest()
            if profile!={**proposed,'status':'CONFIGURED'} or len(receipts)!=4 or any(not r['passed'] or r['imageId']!=image['imageId'] or r['profileSha256']!=profile_sha or r['checkSeconds']>120 or r['network']!='none' or r['user']!='10001' for r in receipts):raise ValueError('Profile gate mismatch')
            if args.final and any(r.get('resources')!={'cpuCount':2,'memoryBytes':4*1024**3,'memorySwapBytes':4*1024**3,'pids':512} for r in receipts):raise ValueError('Exact solver resource receipts still required')
            audit=read(SUITE/compatible['strongAuditRef'])
            if not audit['passed'] or audit['imageId']!=image['imageId'] or not audit['fileLevel']['passed'] or audit['dependencies']['dependencyFindings'] or audit['dependencies']['residueFindings']:raise ValueError('Strong audit failed')
            if not existing and cleanup['sha256']!=audit['rootfsSha256']:raise ValueError('Cleanup audit SHA mismatch')
            preparation=read(SUITE/'private'/c['instanceId']/'preparation.json')
            source_policy=any(r.get('materializeBasePolicy',False) for r in rows)
            report_policy=any(r.get('pytestReportAllPolicy',False) for r in rows)
            if preparation.get('materializeBase',False)!=source_policy or preparation.get('pytestReportAll',False)!=report_policy:raise ValueError('Future scorer source/report protocol differs from qualification')
            record_directory=SUITE/'private'/c['instanceId']
            if digest(record_directory/'record.json')!=c['recordSha256'] or any(digest(record_directory/name)!=value for name,value in preparation['privateHashes'].items()):raise ValueError('Private fixture identity changed')
            if preparation['publicProfileSha256']!=digest(profile_path) or preparation['snapshotSha256']!=fixture['snapshotSha256'] or preparation['imageId']!=image['imageId']:raise ValueError('Preparation identity mismatch')
            cases.append({'caseId':case,'source':fixture['source'],'language':c['language'],'difficulty':c['difficulty'],
                          'imageId':image['imageId'],'upstreamDigest':acquired[case]['pinnedReference'],'snapshotSha256':fixture['snapshotSha256'],
                          'publicProfileSha256':digest(profile_path),'publicChecks':profile,'audit':{'passed':True,'fileLevel':'PASS','dependencyCopies':'PASS','residualMaterials':'PASS','reference':compatible['strongAuditRef'],'rootfsSha256':audit['rootfsSha256']}})
            if image.get('buildMetadata'):cases[-1]['buildPreparation']=image['buildMetadata']
            cases[-1]['gradingSourcePreparation']={'allowVerifiedReportingOrCleanBaseCheckout':source_policy,'pytestReportAll':report_policy,
                                                  'reportingConfigFiles':sorted({p for r in rows for p in r.get('sourceIdentity',{}).get('reportingFiles',[])})}
            timings[case]={'publicBase':[r['checkSeconds'] for r in receipts[:3]],'goldOfficial':[r['durationSeconds'] for r in rows if r['variant']=='gold'],
                           'baseOfficial':next(r['durationSeconds'] for r in rows if r['variant']=='base-test'),'emptyOfficial':next(r['durationSeconds'] for r in rows if r['variant']=='empty')}
            active[case]=bridge.relative_to(SUITE).as_posix()
        except (ValueError,KeyError,OSError) as error:errors.append({'caseId':case,'reason':str(error)})
    tools_dir=SUITE/'private/bootstrap'
    tooling=sum(x['bytes'] for x in read(tools_dir/'downloads.json'))+sum(p.stat().st_size for p in (tools_dir/'wheels').glob('*.whl'))
    reserved=sum(x['reservedCompressedBytes'] for x in acquired.values())
    if reserved+tooling>41*1024**3:errors.append({'caseId':'RESOURCE_LEDGER','reason':'Total compressed reservation exceeds 41GiB'})
    ready=bool(args.final and 20<=len(cases)<=24 and not errors)
    if ready:
        inspected=json.loads(subprocess.check_output(['docker','image','inspect',*[c['imageId'] for c in cases]],timeout=60))
        runtime=[]
        for image in inspected:
            cfg=image['Config'];okay=cfg.get('Entrypoint') in [None,[]] and cfg.get('User')=='10001:10001'
            runtime.append({'imageId':image['Id'],'entrypoint':cfg.get('Entrypoint'),'user':cfg.get('User'),'passed':okay})
            if not okay:errors.append({'caseId':image['Id'],'reason':'Image default startup violates SandboxManager runtime contract'})
        write(SUITE/'private/stage3/runtime-image-contracts.json',runtime)
        ready=not errors
    by_language={}
    for c in cases:by_language[c['language']]=by_language.get(c['language'],0)+1
    state={'at':datetime.now(timezone.utc).isoformat(),'lastBatch':args.batch,'qualifiedCount':len(cases),'readyForLive':ready,'cases':[c['caseId'] for c in cases],'languages':by_language,'receiptErrors':errors,'paidModelCalls':0}
    history_path=SUITE/'private/stage3/batch-checkpoints.json';history_path.parent.mkdir(parents=True,exist_ok=True)
    history=read(history_path) if history_path.exists() else []
    if not history and (SUITE/'stage3-state.json').exists():history.append(read(SUITE/'stage3-state.json'))
    history.append(state);write(history_path,history)
    write(SUITE/'stage3-state.json',state);write(SUITE/'private/r2/active-bridges.json',active)
    if ready:
        stage2=read(SUITE/'stage2-state.json');stage2.update(readyForLive=True,finalFrozenCount=len(cases),stage3='FROZEN')
        write(SUITE/'stage2-state.json',stage2)
    manifest={'version':3,'status':'FROZEN' if ready else 'IN_PROGRESS','readyForLive':ready,'finalFrozenCount':len(cases) if ready else 0,
              'qualifiedCount':len(cases),'resources':{'compressedReservationsBytes':reserved,'toolingPayloadBytes':tooling,'grandCapBytes':41*1024**3,'accounting':'Conservative manifest reservations, not wire bytes'},
              'harness':old['harness'],'datasetSources':old['datasets'],
              'provenanceLimitations':['Dataset mirror/LFS provenance qualifications from stage1 remain applicable; see preserved R1 report.'],
              'languages':by_language,'cases':cases,'receiptErrors':errors,
              'excluded':[{'caseId':c['caseId'],'instanceId':c['instanceId'],'reason':read(SUITE/'private/stage3'/c['caseId']/'blocked.json')} for c in catalog if (SUITE/'private/stage3'/c['caseId']/'blocked.json').exists() and c['caseId'] not in state['cases']],
              'replacements':old.get('replacements',[]),'paidModelCalls':0}
    write(SUITE/'manifest.json',manifest)
    write(SUITE/'inputs.json',{'readyForLive':ready,'cases':[read(SUITE/'public'/c['caseId']/'fixture.json') for c in cases]})
    write(SUITE/'images.json',{'readyForLive':ready,'cases':[{k:c[k] for k in ['caseId','imageId','upstreamDigest','snapshotSha256','audit']} for c in cases]})
    marker='\n<!-- EXTERNAL_SET_STAGE3_PROGRESS -->\n';report=Path('.devflow/v4-research/external-set-build-report.md')
    text=report.read_text(encoding='utf-8').split(marker)[0]
    current_marker='<!-- EXTERNAL_SET_CURRENT_STATUS_END -->\n'
    if text.startswith('<!-- EXTERNAL_SET_CURRENT_STATUS_START -->'):
        text=text.split(current_marker,1)[1]
    appendix=['## 阶段三续建（逐批更新）',json.dumps(state,ensure_ascii=False,indent=2),'|题号|语言|实例|求解镜像|','|---|---|---|---|']
    appendix += [f'|{c["caseId"]}|{c["language"]}|{c["source"]["instanceId"]}|`{c["imageId"]}`|' for c in cases]
    appendix+=['\n### 逐题免费门槛耗时（秒）','|题号|公开base三次|官方gold三次|官方base-test|官方empty|','|---|---|---|---:|---:|']
    appendix += [f'|{case}|{t["publicBase"]}|{t["goldOfficial"]}|{t["baseOfficial"]}|{t["emptyOfficial"]}|' for case,t in timings.items()]
    appendix+=['\n公开命令、来源行号、base排除项与三项审计结论逐题列于 manifest.cases[].publicChecks / audit；私有gold与官方对照仅保留于private，不进入求解/审查输入。资格数不等于真实模型成功数，全部付费请求为0。',
               '\n构建准备修正：pytest 的 Git archive 不含 SCM 生成的版本元数据。仅按公开 setup.py/pyproject.toml 声明提取官方生成文件中的字面常量，验证 base Git 哈希、tag距离并重建 metadata-only overlay；未复制任何主项目实现、未联网补包。初次缺元数据的镜像/失败profile与新镜像身份均保留；最终只采纳新镜像完成的三连公开自测和强审计。该overlay的父层已是纯base扁平层，并非保留原始官方镜像未来源码历史。',
               '\n运行契约修正：Docker commit未实际清除准备容器继承的入口。已用本地Dockerfile显式清除ENTRYPOINT，校验文件系统层未变、执行真实默认sleep探针，并在新镜像重新跑公开base三连/private gold与完整强审计。真实SandboxManager/Fake空补丁的快照恢复、公开自测及独立负验收另存stage3-runtime-empty-v3，旧失败不覆盖。',
               '\n官方准备差异：某些官方镜像将tox.ini中的pytest命令加入-rA并提交。旧启动器把任何树差异直接拒绝，恢复base又会丢失parser所需报告。现仅在配置文本差异严格等于pytest插入-rA时保留原官方准备；不会保留测试选择、断言或实现变化。其余差异只在无未提交受跟踪准备时checkout指定base并核对Git树。原harness/eval script/scorer不修改；source/report策略随准备与manifest冻结，并传入未来评分。求解镜像仍从原始base archive构建、逐文件SHA审计。',
               '未通过候选及其具体证据：'+json.dumps(manifest['excluded'],ensure_ascii=False),
               '最终readyForLive只在--final、20–24题全部逐项证据有效且无回执错误时置true；任一遗漏/身份变更保持关闭。']
    appendix+=['\n### 批次验收历史','|时间UTC|批次|累计合格|回执错误|正式冻结|','|---|---|---:|---:|---|']
    appendix += [f'|{h["at"]}|{h["lastBatch"]}|{h["qualifiedCount"]}|{len(h["receiptErrors"])}|{h["readyForLive"]}|' for h in history]
    current='<!-- EXTERNAL_SET_CURRENT_STATUS_START -->\n> 最新阶段三状态：'+('正式冻结' if ready else '构建中，累计合格')+f' **{len(cases)}题**，`readyForLive={str(ready).lower()}`；最近完成{args.batch}批，回执错误{len(errors)}。以下R1/R2内容为历史检查点，最新逐批结果见文末。未发付费请求。\n'+current_marker
    report.write_text(current+text+marker+'\n\n'.join(appendix[:2])+'\n\n'+'\n'.join(appendix[2:])+'\n',encoding='utf-8')
    status=Path('.devflow/v4-research/STATUS.md')
    with status.open('a',encoding='utf-8') as f:f.write('\n'+state['at']+f' 外部集阶段三 {args.batch} 批检查点：合格{len(cases)}，语言{json.dumps(by_language,ensure_ascii=False)}，回执错误{len(errors)}，readyForLive={ready}；未付费，未提交Git。\n')
    print(json.dumps(state))
    if args.final and not ready:raise SystemExit(2)

if __name__=='__main__':main()
