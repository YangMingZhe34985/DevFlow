/** Runs inside the owned sandbox; stdin never becomes shell code. */
export const GUARDED_PATCH_SCRIPT = String.raw`
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), cp = require('node:child_process');
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
const fail = (kind, message, diagnostics = []) => ({applied:false,changedFiles:[],diagnostics,patchFailure:{kind,message,needsRead:kind==='STALE_SOURCE',diagnostics}});
const reply = value => process.stdout.write(JSON.stringify(value));
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const expected = input.expectedHashes;
const validate = () => {
  for (const [name, digest] of Object.entries(expected)) {
    if (!name || path.isAbsolute(name) || name.includes('\\') || name.includes(':') || name.split('/').some(p=>!p||p==='.'||p==='..'||p==='.git') || /[\x00-\x1f]/.test(name)) return fail('TARGET_FORBIDDEN','Unsafe target path.');
    let cursor = process.cwd();
    for (const part of name.split('/')) {
      cursor = path.join(cursor, part);
      let stat; try { stat=fs.lstatSync(cursor); } catch (e) { if(e.code!=='ENOENT') throw e; }
      if (stat && stat.isSymbolicLink()) return fail('TARGET_FORBIDDEN','Symbolic-link targets/parents are forbidden.');
    }
    if (digest === null) { if (fs.existsSync(cursor)) return fail('STALE_SOURCE','CREATE target already exists.'); }
    else if (!fs.existsSync(cursor) || !fs.statSync(cursor).isFile() || hash(fs.readFileSync(cursor)) !== digest) return fail('STALE_SOURCE','Target content hash changed; no mutation was attempted.');
  }
};
const forbidden = /^(?:GIT binary patch|Binary files |old mode |new mode |rename |copy |similarity index|dissimilarity index|(?:new|deleted) file mode (?:120000|160000))/m;
if (forbidden.test(input.patch)) { reply(fail('UNSUPPORTED_PATCH','Binary/mode/rename/symlink patches are not supported by guarded execution.')); process.exit(0); }
const headers = [...input.patch.matchAll(/^(?:--- |\+\+\+ )([^\r\n]+)$/gm)].map(m=>m[1]);
if (!headers.length || headers.some(p=>p!=='/dev/null'&&(!/^[ab]\//.test(p)||!Object.hasOwn(expected,p.slice(2))))) { reply(fail('TARGET_FORBIDDEN','Patch headers are outside the approved guard.')); process.exit(0); }
const invalid = validate(); if (invalid) { reply(invalid); process.exit(0); }
const git = args => cp.spawnSync('git', ['-c','core.autocrlf=false',...args], {input:input.patch,encoding:'utf8',timeout:20000,maxBuffer:100000,windowsHide:true});
const checked = git(['apply','--check','--whitespace=nowarn','-']);
if (checked.status !== 0) {
  const diagnostics = [(checked.stderr || checked.stdout || 'Git check failed.').slice(0,3000)];
  const kind = /corrupt patch|No valid patches|patch fragment without header|unrecognized input/i.test(diagnostics[0]) ? 'FORMAT_INVALID' : 'CONTEXT_MISMATCH';
  reply(fail(kind,kind==='FORMAT_INVALID'?'Correct unified hunk syntax; unchanged source does not require another read.':'Patch context does not exactly apply to the verified source.',diagnostics)); process.exit(0);
}
const stat = git(['-c','core.quotePath=false','apply','--numstat','-']);
const affected = stat.stdout.trim().split('\n').filter(Boolean).map(l=>l.split('\t').slice(2).join('\t'));
if (stat.status !== 0 || !affected.length || affected.some(p=>!Object.hasOwn(expected,p))) { reply(fail('TARGET_FORBIDDEN','Git reported a target outside the approved guard.')); process.exit(0); }
const changed = validate(); if (changed) { reply(changed); process.exit(0); }
const applied = git(['apply','--whitespace=nowarn','-']);
if (applied.status !== 0) { reply(fail('APPLY_FAILED','Git rejected the checked patch.',[(applied.stderr||applied.stdout).slice(0,3000)])); process.exit(0); }
const changedFiles = Object.keys(expected).filter(name => !fs.existsSync(name) || expected[name]===null || hash(fs.readFileSync(name))!==expected[name]);
if (!changedFiles.length) { reply(fail('NO_CHANGE','Patch produced no content change.')); process.exit(0); }
reply({applied:true,changedFiles,diagnostics:[]});
`;
