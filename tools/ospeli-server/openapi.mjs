// The OpenAPI description of the site server's HTTP API, built from the command registry.
// Never written by hand: a new command appears here by itself.
export const API_VERSION = 'v1';

const ENVELOPE_ERROR = {
  type: 'object', required: ['ok', 'error'],
  properties: {
    ok: { type: 'boolean', enum: [false] },
    synthetic: { type: 'boolean' },
    error: {
      type: 'object', required: ['code', 'message', 'fix'],
      properties: {
        code: { type: 'string', enum: ['invalid-input', 'unknown-command', 'forbidden', 'not-found', 'conflict', 'agents-off', 'unauthorized', 'rate-limited', 'idempotency-key-reused'] },
        message: { type: 'string', description: 'What happened.' },
        fix: { type: 'string', description: 'What to do next.' },
        detail: { type: 'object' },
      },
    },
  },
};

// JSON Schema as the registry writes it is valid OpenAPI 3.1 schema; only a type list with
// "null" needs no change in 3.1 either. Deep copy so the registry is never touched.
const copy = (v) => JSON.parse(JSON.stringify(v));

export function buildOpenApi(commands, { serverVersion = '0.1.0' } = {}) {
  const paths = {
    '/api/v1/health': { get: { operationId: 'health', summary: 'Is the server up. No key needed. Holds no site data.', security: [], responses: { 200: { description: 'The server is running.' } } } },
    '/api/v1/whoami': { get: { operationId: 'whoami', summary: 'Who this key is: agent name, role, units, end date, the dial setting and limits. Call it first.', responses: { 200: { description: 'The agent this key belongs to.' }, 401: { $ref: '#/components/responses/Error' } } } },
    '/api/v1/commands': { get: { operationId: 'listCommands', summary: 'Every command with its schemas, roles and an example. No key needed.', security: [], responses: { 200: { description: 'The command list.' } } } },
    '/api/v1/openapi.json': { get: { operationId: 'openapi', summary: 'This file.', security: [], responses: { 200: { description: 'OpenAPI 3.1 document.' } } } },
  };
  for (const c of commands) {
    const agentNote = !c.agentsMayCall ? 'People only: a call with an agent key is refused and recorded.'
      : c.kind === 'read' ? 'With an agent key: runs as a read and is recorded in the audit trail.'
        : 'With an agent key: queued as a proposal. Nothing changes until a person accepts it.';
    paths[`/api/v1/commands/${c.name}`] = {
      post: {
        operationId: c.name,
        summary: c.summary,
        description: `${agentNote} Roles: ${c.roles.join(', ')}.${c.freeText ? ` ${c.freeText}` : ''}`,
        'x-ospeli-kind': c.kind,
        'x-ospeli-roles': copy(c.roles),
        'x-ospeli-agents-may-call': c.agentsMayCall,
        'x-ospeli-needs-a-person': c.kind === 'write',
        parameters: c.kind === 'write' && c.agentsMayCall ? [{ $ref: '#/components/parameters/IdempotencyKey' }] : [],
        requestBody: {
          required: true,
          content: { 'application/json': {
            schema: { type: 'object', additionalProperties: false, required: ['input'], properties: { input: copy(c.input), dryRun: { type: 'boolean', description: 'True: every check runs and the answer says what would happen. Nothing is read, queued or changed.' } } },
            example: { input: copy(c.example?.input ?? {}) },
          } },
        },
        responses: {
          200: { description: 'The command ran (a read), was queued as a proposal (a write), or was a dry run.', content: { 'application/json': { schema: {
            type: 'object', required: ['ok', 'synthetic', 'command', 'result'],
            properties: {
              ok: { type: 'boolean', enum: [true] }, synthetic: { type: 'boolean' }, command: { type: 'string' },
              result: c.kind === 'read' ? copy(c.output) : { type: 'object', description: 'For an agent: { status: "proposed", proposal }. For a dry run: { status: "dry-run", would }.' },
              replayed: { type: 'boolean', description: 'True when this Idempotency-Key was used before and the first proposal is returned again.' },
              untrustedText: { type: 'string' },
            },
          } } } },
          default: { $ref: '#/components/responses/Error' },
        },
      },
    };
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'Ospeli site server API',
      version: serverVersion,
      description: 'Runs on a site\'s own computer. Every call needs an agent key that a person at the site gave out; everything that arrives over this API is recorded as an agent, never as a person. Agents read and propose; a person accepts or declines. Agent access is Off until a person switches it on. Synthetic data only in this version. Generated from the command registry.',
    },
    servers: [{ url: '/', description: 'This site server' }],
    security: [{ agentKey: [] }],
    paths,
    components: {
      securitySchemes: { agentKey: { type: 'http', scheme: 'bearer', description: 'Authorization: Bearer osk_… (shown once when a person adds the agent at the server).' } },
      parameters: { IdempotencyKey: { name: 'Idempotency-Key', in: 'header', required: false, schema: { type: 'string', pattern: '^[A-Za-z0-9._:-]{8,128}$' }, description: 'Send the same key when you retry a write: the proposal queued the first time is returned and nothing is queued twice. Kept for 24 hours. The same key with a different body is refused.' } },
      responses: { Error: { description: 'Refused. error.message says what happened, error.fix what to do next.', content: { 'application/json': { schema: ENVELOPE_ERROR } } } },
    },
  };
}
