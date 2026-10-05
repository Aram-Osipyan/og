// Integration test for src/electron/electron/webdav_sync.js.
// Needs a WebDAV server, e.g.:  pip install wsgidav cheroot && wsgidav --root /tmp/dav --auth anonymous --port 8765
// Run:  WEBDAV_URL=http://127.0.0.1:8765/test-<n> node scripts/webdav-sync-test.mjs
import { spawn } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import assert from 'assert'
import { WebDAVClient, WebDAVGitSync } from '../src/electron/electron/webdav_sync.js'

const url = process.env.WEBDAV_URL || `http://127.0.0.1:8765/test-${Date.now()}`
const client = new WebDAVClient({ url, username: process.env.WEBDAV_USER, password: process.env.WEBDAV_PASS })

function git (args, { cwd, input } = {}) {
  return new Promise((resolve) => {
    const p = spawn('git', args, { cwd })
    let stdout = ''; let stderr = ''
    p.stdout.on('data', d => { stdout += d })
    p.stderr.on('data', d => { stderr += d })
    p.on('close', exitCode => resolve({ exitCode, stdout, stderr }))
    if (input) p.stdin.end(input); else p.stdin.end()
  })
}

async function device (name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `graph-${name}-`))
  await git(['init', '-q', '-b', 'main'], { cwd: dir })
  await git(['config', 'user.email', `${name}@test`], { cwd: dir })
  await git(['config', 'user.name', name], { cwd: dir })
  const sync = new WebDAVGitSync({ git, dir, client, log: m => console.log(`  [${name}] ${m}`) })
  const write = (f, s) => { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), s) }
  const read = f => fs.readFileSync(path.join(dir, f), 'utf8')
  const commit = async (m) => { await git(['add', '-A'], { cwd: dir }); await git(['commit', '-q', '-m', m], { cwd: dir }) }
  return { dir, sync, write, read, commit }
}

const a = await device('laptop')
const b = await device('desktop')

console.log('1. first push from laptop')
a.write('pages/Привет.md', '- первая заметка\n')
await a.commit('a1')
assert.equal((await a.sync.sync()).status, 'pushed')

console.log('2. empty device pulls')
assert.equal((await b.sync.sync()).status, 'pulled')
assert.equal(b.read('pages/Привет.md'), '- первая заметка\n')

console.log('3. concurrent edits to the same page merge without loss')
a.write('pages/Привет.md', '- первая заметка\n- с ноутбука\n')
await a.commit('a2')
b.write('pages/Привет.md', '- первая заметка\n- с компьютера\n')
b.write('journals/2026_10_05.md', '- журнал\n')
await b.commit('b1')
assert.equal((await a.sync.sync()).status, 'pushed')
assert.equal((await b.sync.sync()).status, 'pushed')
const merged = b.read('pages/Привет.md')
assert.ok(merged.includes('с ноутбука') && merged.includes('с компьютера') && !merged.includes('<<<<'), merged)
assert.equal((await a.sync.sync()).status, 'pulled')
assert.equal(a.read('pages/Привет.md'), merged)
assert.equal(a.read('journals/2026_10_05.md'), '- журнал\n')

console.log('4. nothing to do')
assert.equal((await a.sync.sync()).status, 'up-to-date')

console.log('5. a lost ref update heals on the next sync')
b.write('pages/x.md', '- x\n'); await b.commit('b2')
const before = (await client.getText('refs/heads/main')).text
await b.sync.sync()
await client.put('refs/heads/main', before) // someone overwrote the ref with an older tip
assert.equal((await b.sync.sync()).status, 'pushed')
assert.equal((await a.sync.sync()).status, 'pulled')
assert.equal(a.read('pages/x.md'), '- x\n')

console.log('5b. sync retries when another device wins the race')
a.write('pages/race.md', '- a\n'); await a.commit('a-race')
b.write('pages/race2.md', '- b\n'); await b.commit('b-race')
const orig = a.sync.updateRemoteRef.bind(a.sync)
let raced = false
a.sync.updateRemoteRef = async (...args) => {
  if (!raced) { raced = true; assert.equal((await b.sync.sync()).status, 'pushed') }
  return orig(...args)
}
assert.equal((await a.sync.sync()).status, 'pushed')
assert.ok(raced)
assert.equal(a.read('pages/race2.md'), '- b\n')
a.sync.updateRemoteRef = orig
await b.sync.sync()
assert.equal(b.read('pages/race.md'), '- a\n')

console.log('6. existing folder with its own history joins the remote')
const c = await device('phone-export')
c.write('pages/local.md', '- только тут\n'); await c.commit('c1')
assert.equal((await c.sync.sync()).status, 'pushed')
assert.equal(c.read('pages/x.md'), '- x\n')
assert.equal((await a.sync.sync()).status, 'pulled')
assert.equal(a.read('pages/local.md'), '- только тут\n')

console.log('ok')
