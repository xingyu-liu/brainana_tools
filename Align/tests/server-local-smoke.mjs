import {spawn} from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root=fs.mkdtempSync(path.join(os.tmpdir(),'ba-smoke-'))
const handshake=fs.mkdtempSync(path.join(os.tmpdir(),'ba-port-'))
const portFile=path.join(handshake,'port')
fs.writeFileSync(path.join(root,'x.nii'),Buffer.from([1,2,3]))
const testDir=path.dirname(new URL(import.meta.url).pathname)
const serverPath=path.resolve(testDir,'../source/server.mjs')
const p=spawn(process.execPath,[serverPath,'--port','0','--port-file',portFile,'--root',root],{stdio:['ignore','pipe','pipe']})
let stderr='';p.stderr.on('data',d=>stderr+=d)
try{
  let port=0
  for(let i=0;i<200;i++){
    if(fs.existsSync(portFile)){port=Number(fs.readFileSync(portFile,'utf8').trim());break}
    if(p.exitCode!==null)throw Error(`server exited early: ${stderr}`)
    await new Promise(r=>setTimeout(r,25))
  }
  if(!port)throw Error(`server did not publish port: ${stderr}`)
  const h=await fetch(`http://127.0.0.1:${port}/api/health`).then(r=>r.json())
  if(!h.ok)throw Error('health')
  const l=await fetch(`http://127.0.0.1:${port}/api/list`).then(r=>r.json())
  if(l.entries[0].name!=='x.nii')throw Error('list')
  console.log('local smoke ok')
} finally {
  p.kill('SIGTERM')
  fs.rmSync(root,{recursive:true,force:true});fs.rmSync(handshake,{recursive:true,force:true})
}
