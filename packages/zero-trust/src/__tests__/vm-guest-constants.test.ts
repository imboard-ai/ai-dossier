/** The guest agent is Python inside the VM, so it cannot import the controller's
 * constants. These pairs must agree or the relay, the report or the env checks break
 * only in the real-VM CI job; this test catches the drift on every run. */
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ENVIRONMENT_ROOT, MAX_REPORT_BYTES, REPORT_DIR, REPORT_FILE } from '../vm/adapter';
import { MAX_ENV_NAME_BYTES, MAX_ENV_VALUE_BYTES, MAX_ENV_VARS } from '../vm/broker';
import { AGENT_SOURCE_PATH } from '../vm/local-qemu';
import { RELAY_KEY_BYTES } from '../vm/provision-channel';
import {
  GUEST_RELAY_PORT,
  PHASE_OEM_PREFIX,
  SCOPE_OEM_PREFIX,
  WORKER_RELAY,
} from '../vm/qemu-args';

const agent = fs.readFileSync(AGENT_SOURCE_PATH, 'utf8');

/** The value of a top-level `NAME = <literal>` assignment in agent.py. */
function pythonConstant(name: string): string | number {
  const match = new RegExp(`^${name} = (.+)$`, 'm').exec(agent);
  if (!match) throw new Error(`agent.py has no ${name}`);
  const literal = match[1].trim();
  const text = /^b?"([^"]*)"$/.exec(literal);
  if (text) return text[1];
  if (/^[0-9 *]+$/.test(literal))
    return literal.split('*').reduce((product, factor) => product * Number(factor.trim()), 1);
  throw new Error(`unsupported literal for ${name}: ${literal}`);
}

describe('guest agent constants match the controller', () => {
  it.each([
    ['RELAY_PORT', GUEST_RELAY_PORT],
    ['PROV_GATEWAY', WORKER_RELAY.host],
    ['RELAY_WORKER_PORT', WORKER_RELAY.port],
    ['RELAY_KEY_BYTES', RELAY_KEY_BYTES],
    ['REPORT_MOUNT', REPORT_DIR],
    ['REPORT_FILE', REPORT_FILE],
    ['MAX_REPORT', MAX_REPORT_BYTES],
    ['ENV_MOUNT', ENVIRONMENT_ROOT],
    ['SCOPE_OEM', SCOPE_OEM_PREFIX],
    ['PHASE_OEM', PHASE_OEM_PREFIX],
    ['MAX_ENV_VARS', MAX_ENV_VARS],
    ['MAX_ENV_NAME', MAX_ENV_NAME_BYTES],
    ['MAX_ENV_VALUE_BYTES', MAX_ENV_VALUE_BYTES],
  ] as const)('%s', (name, expected) => {
    expect(pythonConstant(name)).toBe(expected);
  });

  it('the provisioning gateway lies inside the provisioning subnet', () => {
    const subnet = String(pythonConstant('PROV_SUBNET'));
    expect(subnet).toBe(`${WORKER_RELAY.host.split('.').slice(0, 3).join('.')}.0/24`);
  });
});
