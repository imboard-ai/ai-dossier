/** The guest agent (Python, baked into the image) and the host broker (TypeScript)
 * share a wire contract. Nothing compiles them together, so this test reads the
 * agent's constants and fails the moment either side drifts. */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BROKER_PROTOCOL, MAX_FILE_BYTES, MAX_FRAME_BYTES, MAX_STREAM_BYTES } from '../vm/broker';
import { bakeUserData } from '../vm/cloud-init';
import { AGENT_SOURCE_PATH } from '../vm/local-qemu';
import { BROKER_PORT_NAME, SCOPE_OEM_PREFIX } from '../vm/qemu-args';

const AGENT = fs.readFileSync(AGENT_SOURCE_PATH, 'utf8');

/** A top-level `NAME = <value>` assignment from agent.py. */
function constant(name: string): string {
  const match = new RegExp(`^${name} = (.+)$`, 'm').exec(AGENT);
  if (!match) throw new Error(`agent.py has no constant ${name}`);
  return (match[1] as string).trim();
}

/** Integer products such as `4 * 1024 * 1024`; anything else is refused. */
function integer(name: string): number {
  const expression = constant(name);
  if (!/^\d+( \* \d+)*$/.test(expression)) throw new Error(`${name} is not an integer product`);
  return expression.split(' * ').reduce((product, factor) => product * Number(factor), 1);
}

/** A Python string or bytes literal. */
function text(name: string): string {
  const match = /^b?"([^"\\]*)"$/.exec(constant(name));
  if (!match) throw new Error(`${name} is not a plain string literal`);
  return match[1] as string;
}

describe('guest agent ↔ host broker contract', () => {
  it('opens the virtio-serial port QEMU is given', () => {
    expect(text('PORT')).toBe(`/dev/virtio-ports/${BROKER_PORT_NAME}`);
  });

  it('reads the scope from the SMBIOS OEM string the controller sets', () => {
    expect(text('SCOPE_OEM')).toBe(SCOPE_OEM_PREFIX);
  });

  it('answers the hello with the protocol the host expects', () => {
    expect(AGENT).toContain(`"hello": "${BROKER_PROTOCOL}"`);
  });

  it('caps lines, streams and files exactly as the host does', () => {
    expect(integer('MAX_LINE')).toBe(MAX_FRAME_BYTES);
    expect(integer('MAX_STREAM')).toBe(MAX_STREAM_BYTES);
    expect(integer('MAX_FILE')).toBe(MAX_FILE_BYTES);
  });

  it('runs the container images and workspace the bake creates', () => {
    const userData = bakeUserData(AGENT);
    const script = Buffer.from(
      /path: \/usr\/local\/lib\/zt\/bake\.sh\n.*\n.*\n {4}content: (\S+)/.exec(userData)?.[1] ?? '',
      'base64'
    ).toString('utf8');
    for (const tag of Object.values(JSON.parse(constant('IMAGES')) as Record<string, string>))
      expect(script).toContain(`docker build -t ${tag} `);
    expect(script).toContain(text('WORKSPACE'));
  });

  it('refuses constants it cannot read rather than passing silently', () => {
    expect(() => constant('NO_SUCH_CONSTANT')).toThrow(/no constant/);
    expect(() => integer('PORT')).toThrow(/integer product/);
    expect(() => text('MAX_LINE')).toThrow(/string literal/);
  });
});

const PYTHON = spawnSync('python3', ['--version']).status === 0;

describe.skipIf(!PYTHON)('guest agent exec errors', () => {
  /** op_exec in vm-root scope against a temporary workspace, via python3. */
  function exec(cwd: string): unknown {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'zt-agent-'));
    try {
      const script = [
        'import json, sys',
        'sys.path.insert(0, sys.argv[1])',
        'import agent',
        'agent.WORKSPACE = sys.argv[2]',
        'request = {"argv": ["/nonexistent-zt"], "cwd": sys.argv[3], "profile": "node", "timeoutMs": 1000}',
        'print(json.dumps(agent.op_exec(request, "vm-root", 1)))',
      ].join('\n');
      const result = spawnSync(
        'python3',
        ['-c', script, path.dirname(AGENT_SOURCE_PATH), workspace, cwd],
        { encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } }
      );
      expect(result.stderr).toBe('');
      return JSON.parse(result.stdout);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  }

  it('reports a missing executable as command_not_found', () => {
    expect(exec('')).toEqual({ ok: false, error: 'command_not_found' });
  });

  it('reports a missing working directory as workdir_missing, not a missing command', () => {
    expect(exec('missing')).toEqual({ ok: false, error: 'workdir_missing' });
  });
});
