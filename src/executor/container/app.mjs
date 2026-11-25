import { readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'

// docker exec authenticates the host and selects the protected service UID.
const args = [
  'app-server',
  '--listen',
  'stdio://',
  '-c',
  'model_provider="ticket"',
  '-c',
  'model_providers.ticket.name="Ticket provider"',
  '-c',
  'model_providers.ticket.base_url="http://127.0.0.1:4021"',
  '-c',
  'model_providers.ticket.env_key="TICKET_MODEL_LEASE"',
  '-c',
  'model_providers.ticket.wire_api="responses"',
  '-c',
  'model_providers.ticket.supports_websockets=false',
  '-c',
  'shell_environment_policy.inherit="none"',
  '-c',
  'shell_environment_policy.set={PATH="/usr/local/bin:/usr/bin:/bin",HOME="/tmp/project",HTTP_PROXY="http://127.0.0.1:4020",HTTPS_PROXY="http://127.0.0.1:4020",http_proxy="http://127.0.0.1:4020",https_proxy="http://127.0.0.1:4020",NO_PROXY="",no_proxy="",CURL_CA_BUNDLE="/relay/ca.pem",REQUESTS_CA_BUNDLE="/relay/ca.pem",NODE_EXTRA_CA_CERTS="/relay/ca.pem",SSL_CERT_FILE="/relay/ca.pem",GIT_SSL_CAINFO="/relay/ca.pem"}',
]
const app = spawn('codex', args, {
  stdio: 'inherit',
  cwd: '/history',
  env: {
    PATH: '/usr/local/bin:/usr/bin:/bin',
    HOME: '/history',
    CODEX_HOME: '/history',
    CODEX_EXEC_SERVER_URL: 'ws://127.0.0.1:4022',
    TICKET_MODEL_LEASE: readFileSync('/service/proxy-token', 'utf8'),
  },
})
app.once('error', (e) => {
  console.error(e.message)
  process.exitCode = 1
})
app.once('exit', (code) => process.exit(code ?? 1))
