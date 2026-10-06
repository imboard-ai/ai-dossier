/** Controller-generated cloud-init for the trusted bake. Runs only pinned inputs;
 * no repository or model content ever reaches this document. */
import { PROFILE_PINS } from './profile';

export const BAKE_RESULT_MARKER = 'ZT-BAKE-RESULT';
export const BAKE_FAILED_MARKER = 'ZT-BAKE-FAILED';

function dockerfile(packages: readonly string[]): string {
  const base = `${PROFILE_PINS.containerBase.image}@${PROFILE_PINS.containerBase.digest}`;
  return [
    `FROM ${base}`,
    'USER root',
    // Tools are installed at image build time; runtime sudo and every setuid/setgid
    // bit are removed so no in-container path regains privilege.
    `RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ${packages.join(' ')} \\`,
    ' && SUDO_FORCE_REMOVE=yes apt-get purge -y sudo && apt-get autoremove -y \\',
    ' && rm -rf /etc/sudoers /etc/sudoers.d /var/lib/apt/lists/* \\',
    ' && find / -xdev -type f -perm /6000 -exec chmod ug-s {} +',
    'USER 1000:1000',
    '',
  ].join('\n');
}

function indent(text: string, spaces: number): string {
  const pad = ' '.repeat(spaces);
  return text
    .split('\n')
    .map((line) => (line ? pad + line : line))
    .join('\n');
}

const AGENT_UNIT = `[Unit]
Description=zero-trust worker broker
After=docker.service
Requires=docker.service

[Service]
ExecStart=/usr/bin/python3 /usr/local/lib/zt/agent.py
Restart=always
RestartSec=1

[Install]
WantedBy=multi-user.target
`;

/** The bake script prints exactly one result marker line to the serial console. */
const BAKE_SCRIPT = `#!/bin/bash
set -euo pipefail
trap 'echo ${BAKE_FAILED_MARKER} line=$LINENO > /dev/ttyS0; poweroff' ERR
export DEBIAN_FRONTEND=noninteractive
apt-get purge -y snapd unattended-upgrades || true
systemctl disable --now ssh.socket ssh.service || true
systemctl mask ssh.socket ssh.service apt-daily.timer apt-daily-upgrade.timer
passwd -l root
docker build -t zt-node:profile /var/lib/zt/build/node
docker build -t zt-python:profile /var/lib/zt/build/python
docker image rm ${PROFILE_PINS.containerBase.image}@${PROFILE_PINS.containerBase.digest} || true
node_id=$(docker image inspect --format '{{.Id}}' zt-node:profile)
python_id=$(docker image inspect --format '{{.Id}}' zt-python:profile)
install -d -o 1000 -g 1000 -m 0700 /var/lib/zt/workspace
rm -rf /var/lib/zt/build
systemctl enable zt-agent.service
apt-get clean
cloud-init clean --logs
touch /etc/cloud/cloud-init.disabled
fstrim -av || true
echo "${BAKE_RESULT_MARKER} {\\"node\\":\\"$node_id\\",\\"python\\":\\"$python_id\\"}" > /dev/ttyS0
sync
poweroff
`;

export function bakeUserData(agentSource: string): string {
  const files: [string, string, string][] = [
    ['/usr/local/lib/zt/agent.py', '0700', agentSource],
    ['/etc/systemd/system/zt-agent.service', '0644', AGENT_UNIT],
    ['/etc/modules-load.d/zt-dmi-sysfs.conf', '0644', 'dmi_sysfs\n'],
    ['/var/lib/zt/build/node/Dockerfile', '0644', dockerfile(PROFILE_PINS.containerProfiles.node)],
    [
      '/var/lib/zt/build/python/Dockerfile',
      '0644',
      dockerfile(PROFILE_PINS.containerProfiles.python),
    ],
    ['/usr/local/lib/zt/bake.sh', '0700', BAKE_SCRIPT],
  ];
  const writeFiles = files
    .map(
      ([path, mode, content]) =>
        `  - path: ${path}\n    permissions: '${mode}'\n    encoding: b64\n    content: ${Buffer.from(content).toString('base64')}`
    )
    .join('\n');
  return [
    '#cloud-config',
    // No default user, no passwords, no SSH: the broker port is the only way in.
    'users: []',
    'disable_root: true',
    'ssh_pwauth: false',
    'package_update: true',
    'packages:',
    '  - docker.io',
    'write_files:',
    writeFiles,
    'runcmd:',
    indent('- [/usr/local/lib/zt/bake.sh]', 2),
    '',
  ].join('\n');
}

export function bakeMetaData(instanceId: string): string {
  return `instance-id: ${instanceId}\nlocal-hostname: zt-bake\n`;
}
