/** In-memory `VmAdapter` for controller tests (#1095). It runs nothing: exec results are
 * scripted per argv (`on`), else by a function that can look at the VM's uploaded files, and it
 * enforces the same host-side phase rules as `LocalQemuAdapter`: `package_proxy` only in
 * provisioning, `endProvisioning` only once, a destroyed VM refuses everything. */
import type {
  ExecRequest,
  ExecResult,
  NetworkPhase,
  VmAdapter,
  VmHandle,
  VmListing,
  VmSpec,
} from '../vm/adapter';
import { BrokerError, VmCleanupError } from '../vm/adapter';

export interface FakeExecScript {
  readonly exitCode?: number | null;
  readonly timedOut?: boolean;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly truncated?: boolean;
  readonly durationMs?: number;
  /** Returned only when the request asked for a report; `null` means none was written. */
  readonly report?: Buffer | string | null;
}

export interface FakeVm {
  readonly handle: VmHandle;
  readonly spec: VmSpec;
  phase: NetworkPhase;
  destroyed: boolean;
  readonly files: Map<string, { bytes: Buffer; executable: boolean }>;
}

export type FakeScript = (request: ExecRequest, vm: FakeVm) => FakeExecScript | undefined;

export interface FakeCall {
  readonly op: 'create' | 'exec' | 'putFile' | 'getFile' | 'endProvisioning' | 'destroy';
  readonly vmId: string;
  /** VM phase when the call was made (exec), else undefined. */
  readonly phase?: NetworkPhase;
  readonly request?: ExecRequest;
  readonly path?: string;
}

/** A junit report with `suites` suites of one passing (or failing) test case each. */
export function junit(suites: number, failing = false): Buffer {
  const cases = Array.from(
    { length: suites },
    (_, i) =>
      `<testsuite name="s${i}"><testcase name="t${i}">${failing ? '<failure/>' : ''}</testcase></testsuite>`
  ).join('');
  return Buffer.from(`<testsuites>${cases}</testsuites>`, 'utf8');
}

export class FakeVmAdapter implements VmAdapter {
  readonly vms = new Map<string, FakeVm>();
  readonly calls: FakeCall[] = [];
  /** How many of the next `destroy` calls fail with `VmCleanupError`. */
  failDestroy = 0;
  /** Error to throw from `create` (once), e.g. an `UnsupportedEnvironmentError`. */
  failCreate: Error | null = null;
  private readonly byArgv = new Map<string, FakeExecScript>();
  private sequence = 0;

  constructor(private readonly script?: FakeScript) {}

  /** Scripts the result for an exact argv (joined by spaces). */
  on(argv: readonly string[] | string, result: FakeExecScript): this {
    this.byArgv.set(typeof argv === 'string' ? argv : argv.join(' '), result);
    return this;
  }

  private live(handle: Pick<VmHandle, 'vmId'>): FakeVm {
    const vm = this.vms.get(handle.vmId);
    if (!vm || vm.destroyed) throw new BrokerError('unknown_vm');
    return vm;
  }

  async create(spec: VmSpec): Promise<VmHandle> {
    if (this.failCreate) {
      const error = this.failCreate;
      this.failCreate = null;
      throw error;
    }
    const phase = spec.phase ?? 'verification';
    if (phase === 'provisioning' && !spec.proxyTarget) throw new BrokerError('proxy_required');
    const handle: VmHandle = Object.freeze({
      vmId: `fake-${++this.sequence}`,
      runId: spec.runId,
      accelerator: 'tcg',
      profileDigest: 'fake',
      scope: spec.scope,
    });
    this.vms.set(handle.vmId, { handle, spec, phase, destroyed: false, files: new Map() });
    this.calls.push({ op: 'create', vmId: handle.vmId, phase });
    return handle;
  }

  async exec(handle: VmHandle, request: ExecRequest): Promise<ExecResult> {
    const vm = this.live(handle);
    this.calls.push({ op: 'exec', vmId: handle.vmId, phase: vm.phase, request });
    if (request.network === 'package_proxy' && vm.phase !== 'provisioning')
      throw new BrokerError('network_not_allowed');
    const scripted = this.byArgv.get(request.argv.join(' ')) ?? this.script?.(request, vm) ?? {};
    const report = scripted.report;
    return {
      exitCode: scripted.exitCode === undefined ? 0 : scripted.exitCode,
      timedOut: scripted.timedOut ?? false,
      stdout: scripted.stdout ?? '',
      stderr: scripted.stderr ?? '',
      truncated: scripted.truncated ?? false,
      durationMs: scripted.durationMs ?? 1,
      ...(request.report
        ? { report: typeof report === 'string' ? Buffer.from(report, 'utf8') : (report ?? null) }
        : {}),
    };
  }

  async putFile(
    handle: VmHandle,
    relativePath: string,
    bytes: Buffer,
    executable = false
  ): Promise<void> {
    const vm = this.live(handle);
    this.calls.push({ op: 'putFile', vmId: handle.vmId, path: relativePath });
    vm.files.set(relativePath, { bytes: Buffer.from(bytes), executable });
  }

  async getFile(handle: VmHandle, relativePath: string): Promise<Buffer> {
    const vm = this.live(handle);
    this.calls.push({ op: 'getFile', vmId: handle.vmId, path: relativePath });
    const file = vm.files.get(relativePath);
    if (!file) throw new BrokerError('guest_not_found');
    return Buffer.from(file.bytes);
  }

  async endProvisioning(handle: VmHandle): Promise<void> {
    const vm = this.live(handle);
    this.calls.push({ op: 'endProvisioning', vmId: handle.vmId, phase: vm.phase });
    if (vm.phase !== 'provisioning') throw new BrokerError('not_provisioning');
    vm.phase = 'verification';
  }

  async destroy(handle: Pick<VmHandle, 'vmId' | 'runId'>): Promise<void> {
    this.calls.push({ op: 'destroy', vmId: handle.vmId });
    if (this.failDestroy > 0) {
      this.failDestroy--;
      throw new VmCleanupError([], [`fake:${handle.vmId}`], handle.vmId);
    }
    const vm = this.vms.get(handle.vmId);
    if (vm) vm.destroyed = true;
  }

  async listByRun(runId: string): Promise<VmListing[]> {
    return [...this.vms.values()]
      .filter((vm) => vm.handle.runId === runId && !vm.destroyed)
      .map((vm) => ({ vmId: vm.handle.vmId, runId, pid: null, alive: true, paths: [] }));
  }

  /** VMs created and not destroyed. */
  liveVms(): FakeVm[] {
    return [...this.vms.values()].filter((vm) => !vm.destroyed);
  }

  /** Exec calls, in order. */
  execs(): (FakeCall & { request: ExecRequest })[] {
    return this.calls.filter((c): c is FakeCall & { request: ExecRequest } => c.op === 'exec');
  }
}
