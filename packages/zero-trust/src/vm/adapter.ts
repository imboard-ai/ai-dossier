/** Provider-neutral disposable-VM contract (PRD §5.4). Implementations own the
 * hypervisor; callers only see typed lifecycle and broker operations. */
import type { Journal } from '../journal';
import { assertNoSecrets } from '../redaction';
import { ReasonCode } from '../state';

export type Accelerator = 'kvm' | 'tcg';
export type AcceleratorRequest = Accelerator | 'auto';
/** `container` is the only production scope. `vm-root` runs probes as root in
 * the guest so the suite can prove the host-side boundary holds after an
 * assumed container escape; it is set by the controller, never by a request. */
export type ExecScope = 'container' | 'vm-root';
export type ContainerProfile = 'node' | 'python';

export interface VmLimits {
  readonly vcpus: number;
  readonly memoryMiB: number;
  readonly diskGiB: number;
  /** Per-command wall clock before TCG scaling. */
  readonly commandTimeoutMs: number;
}

/** PRD §5.1 defaults: 4 vCPU, 8 GiB RAM, 20 GiB scratch, 20 minutes per command. Space
 * beyond the 16 GiB baked disk is not usable until the root partition is grown. */
export const DEFAULT_LIMITS: VmLimits = Object.freeze({
  vcpus: 4,
  memoryMiB: 8192,
  diskGiB: 20,
  commandTimeoutMs: 20 * 60 * 1000,
});

export interface VmSpec {
  readonly runId: string;
  readonly limits: VmLimits;
  readonly scope: ExecScope;
}

export interface VmHandle {
  readonly vmId: string;
  readonly runId: string;
  readonly accelerator: Accelerator;
  readonly profileDigest: string;
  readonly scope: ExecScope;
}

export interface ExecRequest {
  readonly profile: ContainerProfile;
  readonly argv: readonly string[];
  /** Relative to the worker workspace. */
  readonly cwd?: string;
  readonly timeoutMs?: number;
}

export interface ExecResult {
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly truncated: boolean;
  readonly durationMs: number;
}

export interface VmListing {
  readonly vmId: string;
  readonly runId: string;
  readonly pid: number | null;
  readonly alive: boolean;
  readonly paths: readonly string[];
}

export interface VmAdapter {
  create(spec: VmSpec): Promise<VmHandle>;
  exec(handle: VmHandle, request: ExecRequest): Promise<ExecResult>;
  putFile(
    handle: VmHandle,
    relativePath: string,
    bytes: Buffer,
    executable?: boolean
  ): Promise<void>;
  getFile(handle: VmHandle, relativePath: string): Promise<Buffer>;
  /** One deletion attempt; throws VmCleanupError with what is left behind. */
  destroy(handle: Pick<VmHandle, 'vmId' | 'runId'>): Promise<void>;
  listByRun(runId: string): Promise<VmListing[]>;
}

export type UnsupportedDetail =
  | 'unsupported_os'
  | 'unsupported_arch'
  | 'qemu_missing'
  | 'qemu_img_missing'
  | 'iso_tool_missing'
  | 'kvm_unavailable'
  | 'profile_image_missing'
  | 'profile_image_mismatch'
  | 'profile_image_untrusted'
  | 'socket_path_too_long'
  | 'kill_switch_engaged';

export class UnsupportedEnvironmentError extends Error {
  readonly reasonCode = ReasonCode.UnsupportedEnvironment;
  constructor(
    readonly detail: UnsupportedDetail,
    message: string
  ) {
    super(`Execution profile refused (${ReasonCode.UnsupportedEnvironment}/${detail}): ${message}`);
    this.name = 'UnsupportedEnvironmentError';
  }
}

export class VmCleanupError extends Error {
  constructor(
    readonly leftoverPids: readonly number[],
    readonly leftoverPaths: readonly string[],
    /** The VM this failure belongs to, when known. */
    readonly vmId?: string
  ) {
    super(
      `VM teardown incomplete${vmId ? ` for ${vmId}` : ''}: ${leftoverPids.length} process(es) [${leftoverPids.join(', ')}], ` +
        `${leftoverPaths.length} path(s) [${leftoverPaths.join(', ')}] left behind`
    );
    this.name = 'VmCleanupError';
  }
}

/** Broker failure. Host-side request rejections and `guest_*` error replies
 * leave the VM usable; a protocol violation by the guest taints it
 * (`BrokerClient.tainted`) and the VM must be destroyed. */
export class BrokerError extends Error {
  constructor(readonly code: string) {
    super(`Worker broker rejected: ${code}`);
    this.name = 'BrokerError';
  }
}

/** Appends a VM lifecycle event to a journal dedicated to VM events, after
 * checking every string in it, nested values included, for secret material. */
export function appendVmEvent(
  journal: Journal | undefined,
  at: Date,
  event: Record<string, unknown>
): void {
  if (!journal) return;
  const scan = (value: unknown): void => {
    if (typeof value === 'string') assertNoSecrets(value);
    else if (Array.isArray(value)) value.forEach(scan);
    else if (value !== null && typeof value === 'object') Object.values(value).forEach(scan);
  };
  scan(event);
  journal.append({ v: 1, at: at.toISOString(), ...event });
}
