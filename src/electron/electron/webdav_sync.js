// WebDAV remote for the graph's git repository.
//
// The remote is a plain WebDAV folder laid out like a minimal git repo:
//
//   <remote>/HEAD                      "ref: refs/heads/<branch>"
//   <remote>/refs/heads/<branch>       commit sha of the branch tip
//   <remote>/objects/pack/pack-*.pack  immutable packfiles
//   <remote>/objects/pack/pack-*.idx   their indexes (uploaded after the .pack)
//
// Packs are content addressed and never rewritten, so uploading them is safe
// to repeat. The only mutable file is the branch ref, which is updated with a
// conditional PUT (If-Match on its ETag, or If-None-Match: * when creating
// it; see updateRemoteRef for servers with coarse ETags), so two devices pushing at the same time cannot overwrite each other:
// the loser gets 412, pulls, merges and retries.
//
// The module has no Electron dependencies; git is reached through the
// `git(args, opts)` function passed in, which must resolve to
// {exitCode, stdout, stderr}.

import fs from 'fs'
import os from 'os'
import path from 'path'

const REMOTE_REF = 'refs/remotes/webdav/main'
const MERGE_ATTRIBUTES = ['*.md merge=union', '*.org merge=union']

export class PreconditionFailed extends Error {}

function joinUrl (base, rel) {
  return base.replace(/\/+$/, '') + '/' + rel.split('/').map(encodeURIComponent).join('/')
}

export class WebDAVClient {
  constructor ({ url, username, password, fetchImpl }) {
    this.url = url
    this.fetch = fetchImpl || globalThis.fetch
    this.headers = {}
    if (username || password) {
      this.headers.Authorization = 'Basic ' + Buffer.from(`${username || ''}:${password || ''}`).toString('base64')
    }
  }

  async request (method, rel, { headers = {}, body } = {}) {
    return this.fetch(joinUrl(this.url, rel), {
      method,
      headers: { ...this.headers, ...headers },
      body
    })
  }

  // Returns {text, etag} or null when the file does not exist.
  async getText (rel) {
    const res = await this.request('GET', rel)
    if (res.status === 404) return null
    if (!res.ok) throw new Error(`WebDAV GET ${rel}: ${res.status}`)
    return { text: await res.text(), etag: res.headers.get('etag') }
  }

  async getBuffer (rel) {
    const res = await this.request('GET', rel)
    if (!res.ok) throw new Error(`WebDAV GET ${rel}: ${res.status}`)
    return Buffer.from(await res.arrayBuffer())
  }

  async put (rel, body, headers = {}) {
    const res = await this.request('PUT', rel, { body, headers })
    if (res.status === 412) throw new PreconditionFailed(`WebDAV PUT ${rel}: precondition failed`)
    if (!res.ok) throw new Error(`WebDAV PUT ${rel}: ${res.status}`)
  }

  // Creates every collection on the way to `rel` (MKCOL is not recursive).
  // The remote folder itself is created too; its parents must exist.
  async mkdirp (rel) {
    let cur = ''
    for (const part of ['', ...rel.split('/').filter(Boolean)]) {
      cur = cur ? `${cur}/${part}` : part
      const res = await this.request('MKCOL', cur ? cur + '/' : '')
      // 405: already exists. Some servers answer 409/301 for existing folders too.
      if (!res.ok && ![405, 301, 409].includes(res.status)) {
        throw new Error(`WebDAV MKCOL ${cur || this.url}: ${res.status}`)
      }
    }
  }

  // Names of the files directly inside the collection `rel`.
  async list (rel) {
    const res = await this.request('PROPFIND', rel.replace(/\/?$/, '/'), {
      headers: { Depth: '1', 'Content-Type': 'application/xml' },
      body: '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>'
    })
    if (res.status === 404) return []
    if (!res.ok) throw new Error(`WebDAV PROPFIND ${rel}: ${res.status}`)
    const xml = await res.text()
    const names = []
    for (const m of xml.matchAll(/<(?:[\w-]+:)?href>([^<]+)<\/(?:[\w-]+:)?href>/gi)) {
      const href = decodeURIComponent(m[1].trim())
      if (href.endsWith('/')) continue
      names.push(href.split('/').pop())
    }
    return names
  }
}

export class WebDAVGitSync {
  // git:      (args, {cwd, input}) => Promise<{exitCode, stdout, stderr}>
  // dir:      the graph folder (work tree)
  // branch:   remote branch name
  constructor ({ git, dir, client, branch = 'main', log = () => {} }) {
    this.gitImpl = git
    this.dir = dir
    this.client = client
    this.branch = branch
    this.log = log
    this.refPath = `refs/heads/${branch}`
  }

  async git (args, opts = {}) {
    const res = await this.gitImpl(args, { cwd: this.dir, ...opts })
    if (res.exitCode !== 0 && !opts.allowFail) {
      throw new Error(`git ${args.join(' ')}: ${res.stderr || res.stdout}`)
    }
    return res
  }

  async gitOut (args, opts) {
    return (await this.git(args, opts)).stdout.trim()
  }

  async gitDir () {
    const dir = await this.gitOut(['rev-parse', '--git-dir'])
    return path.resolve(this.dir, dir)
  }

  async localHead () {
    const res = await this.git(['rev-parse', '--verify', '-q', 'HEAD'], { allowFail: true })
    return res.exitCode === 0 ? res.stdout.trim() : null
  }

  async hasCommit (sha) {
    const res = await this.git(['cat-file', '-e', `${sha}^{commit}`], { allowFail: true })
    return res.exitCode === 0
  }

  // Markdown/org files merge by keeping both sides' lines instead of
  // stopping on a conflict. Set in info/attributes so the graph is untouched.
  async ensureMergeAttributes () {
    const file = path.join(await this.gitDir(), 'info', 'attributes')
    const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
    const missing = MERGE_ATTRIBUTES.filter(l => !existing.split('\n').includes(l))
    if (missing.length) {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.appendFileSync(file, (existing && !existing.endsWith('\n') ? '\n' : '') + missing.join('\n') + '\n')
    }
  }

  // Downloads packs we don't have yet; returns the remote tip (or null) and its ETag.
  async fetch () {
    const ref = await this.client.getText(this.refPath)
    if (!ref) return { sha: null, etag: null }
    const sha = ref.text.trim()
    if (!(await this.hasCommit(sha))) {
      const packDir = path.join(await this.gitDir(), 'objects', 'pack')
      fs.mkdirSync(packDir, { recursive: true })
      const names = await this.client.list('objects/pack')
      const idxs = names.filter(n => /^pack-[0-9a-f]+\.idx$/.test(n))
      for (const idx of idxs) {
        const base = idx.slice(0, -4)
        if (fs.existsSync(path.join(packDir, idx))) continue
        this.log(`downloading ${base}`)
        const pack = await this.client.getBuffer(`objects/pack/${base}.pack`)
        const index = await this.client.getBuffer(`objects/pack/${idx}`)
        // .pack first: git ignores a pack until its .idx is present.
        fs.writeFileSync(path.join(packDir, `${base}.pack`), pack)
        fs.writeFileSync(path.join(packDir, idx), index)
      }
      if (!(await this.hasCommit(sha))) {
        throw new Error(`remote ref ${sha} is missing objects; refusing to update`)
      }
    }
    await this.git(['update-ref', REMOTE_REF, sha])
    return { sha, etag: ref.etag }
  }

  // Merges the remote tip into the work tree. Returns the new local HEAD.
  async integrate (remoteSha) {
    const head = await this.localHead()
    if (!remoteSha) return head
    if (!head) {
      // Fresh device: adopt the remote history. Files already in the folder
      // stay as they are and show up as local changes in the next commit.
      await this.git(['reset', '--mixed', remoteSha])
      await this.git(['checkout', '--', '.'], { allowFail: true })
      return remoteSha
    }
    if (head === remoteSha) return head
    const isAncestor = (a, b) => this.git(['merge-base', '--is-ancestor', a, b], { allowFail: true })
      .then(r => r.exitCode === 0)
    if (await isAncestor(remoteSha, head)) return head
    await this.ensureMergeAttributes()
    const msg = `Merge changes from WebDAV (${os.hostname()})`
    const res = await this.git(['merge', '--no-edit', '--allow-unrelated-histories', '-m', msg, REMOTE_REF], { allowFail: true })
    if (res.exitCode !== 0) {
      // Something union merge can't handle (binary assets, delete vs edit):
      // keep the local version of those files; the other side stays in history.
      this.log(`merge conflict, keeping local versions: ${res.stdout}`)
      await this.git(['merge', '--abort'], { allowFail: true })
      await this.git(['merge', '--no-edit', '--allow-unrelated-histories', '-X', 'ours', '-m', msg, REMOTE_REF])
    }
    return this.localHead()
  }

  async pushPack (head, remoteSha) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'logseq-webdav-'))
    try {
      const input = head + '\n' + (remoteSha ? `^${remoteSha}\n` : '')
      const hash = await this.gitOut(['pack-objects', '--revs', '--quiet', path.join(tmp, 'pack')], { input })
      if (!hash) return
      await this.client.mkdirp('objects/pack')
      const base = `pack-${hash}`
      await this.client.put(`objects/pack/${base}.pack`, fs.readFileSync(path.join(tmp, `${base}.pack`)))
      await this.client.put(`objects/pack/${base}.idx`, fs.readFileSync(path.join(tmp, `${base}.idx`)))
      this.log(`uploaded ${base}`)
      // Keep a copy so the next fetch doesn't download our own pack back.
      const packDir = path.join(await this.gitDir(), 'objects', 'pack')
      fs.mkdirSync(packDir, { recursive: true })
      fs.copyFileSync(path.join(tmp, `${base}.pack`), path.join(packDir, `${base}.pack`))
      fs.copyFileSync(path.join(tmp, `${base}.idx`), path.join(packDir, `${base}.idx`))
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  }

  // Not every server's ETag changes on a same-size rewrite within one second
  // (inode-mtime-size ETags), so the ref is also re-read just before the PUT.
  // If an update still slips through, nothing is lost: the other device keeps
  // its commits locally and merges them back on its next sync.
  async updateRemoteRef (head, etag, remoteSha) {
    if (etag) {
      const current = await this.client.getText(this.refPath)
      if (!current || current.text.trim() !== remoteSha) {
        throw new PreconditionFailed('remote ref changed')
      }
    }
    await this.client.mkdirp('refs/heads')
    const headers = etag ? { 'If-Match': etag } : { 'If-None-Match': '*' }
    await this.client.put(this.refPath, head + '\n', headers)
    if (!etag) {
      await this.client.put('HEAD', `ref: ${this.refPath}\n`)
    }
  }

  // One full round: fetch, merge, push. Commit local edits before calling.
  // Returns {status: 'up-to-date' | 'pulled' | 'pushed', head}.
  async sync ({ retries = 3 } = {}) {
    for (let attempt = 0; ; attempt++) {
      const { sha: remoteSha, etag } = await this.fetch()
      const before = await this.localHead()
      const head = await this.integrate(remoteSha)
      if (!head || head === remoteSha) {
        return { status: before === head ? 'up-to-date' : 'pulled', head }
      }
      try {
        await this.pushPack(head, remoteSha)
        await this.updateRemoteRef(head, etag, remoteSha)
        await this.git(['update-ref', REMOTE_REF, head])
        return { status: 'pushed', head }
      } catch (e) {
        if (e instanceof PreconditionFailed && attempt < retries) {
          this.log('remote moved while pushing, retrying')
          continue
        }
        throw e
      }
    }
  }
}
