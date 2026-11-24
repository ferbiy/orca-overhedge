// Runs INSIDE the smoke container only (throwaway HOME). Never prints the auth token.
const fs = require('fs'), net = require('net'), path = require('path')
const meta = JSON.parse(fs.readFileSync(path.join(process.env.HOME, '.config/orca/orca-runtime.json'), 'utf8'))
const ep = (meta.transports || []).find((t) => t.kind === 'unix')?.endpoint
const calls = [
  ['accounts.migrateClaudeChats', { to: 'nobody', allOn: 'nobody', dryRun: true }],
  ['accounts.migrateClaudeChats', { to: 'nobody', chatIds: ['no-such-chat'], dryRun: true }],
  ['accounts.migrateClaudeChats', {}],
  ['accounts.noSuchMethodForComparison', {}]
]
let i = 0
const next = () => {
  if (i >= calls.length) return
  const [method, params] = calls[i++]
  const s = net.connect(ep); let buf = ''
  s.on('data', (d) => { buf += d; let k; while ((k = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, k); buf = buf.slice(k + 1)
    if (line.includes('_keepalive')) continue
    const r = JSON.parse(line); delete r._meta
    console.log(`### ${method} ${JSON.stringify(params)}\n${JSON.stringify(r).slice(0, 600)}`); s.end(); next() } })
  s.on('error', (e) => { console.log(`### ${method} socket error ${e.message}`); next() })
  s.write(JSON.stringify({ id: 'probe-' + i, authToken: meta.authToken, method, params }) + '\n')
}
console.log('endpoint kind unix:', !!ep); next()
