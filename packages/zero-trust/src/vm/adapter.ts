/** Provider-neutral disposable-VM contract (PRD §5.4). Implementations own the
 * hypervisor; callers only see typed lifecycle and broker operations. */
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

/** PRD §5.1 defaults: 4 vCPU, 8 GiB RAM, 20 GiB scratch, 20 minutes per command. */
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
    readonly leftoverPaths: readonly string[]
  ) {
    super('VM teardown incomplete');
    this.name = 'VmCleanupError';
  }
}

/** Raised when the guest breaks protocol; the VM is tainted and must be destroyed. */
export class BrokerError extends Error {
  constructor(readonly code: string) {
    super(`Worker broker rejected: ${code}`);
    this.name = 'BrokerError';
  }
}
