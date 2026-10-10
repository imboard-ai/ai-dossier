/** Closed CLI parsing and dispatch. All output uses shared renderers or this fixed
 * message table. Provider exception messages and unknown codes are never emitted. */
import fs from 'node:fs';
import { runConfigInput, validateRunConfig } from '../dist/controller/config.js';
import { renderMetricsHuman, renderMetricsJson } from '../dist/metrics/outcomes.js';
import { assertSecretFree } from '../dist/redaction.js';
import { renderHuman, renderJson } from '../dist/status.js';

const COMMANDS = Object.freeze({
  start: {
    required: ['config', 'root'],
    optional: ['confirm-author', 'author-name', 'author-email'],
  },
  resume: { required: ['root', 'run'], optional: ['revise'] },
  'pr-edit': { required: ['root', 'run', 'title', 'body-file'], optional: [] },
  withdraw: { required: ['root', 'run', 'reason', 'explanation'], optional: [] },
  'cancel-action': { required: ['root', 'run'], optional: [] },
  status: { required: ['root', 'run'], optional: ['json'] },
  pause: { required: ['root', 'run', 'reason'], optional: [] },
  cancel: { required: ['root', 'run', 'reason'], optional: [] },
  approve: { required: ['root', 'run', 'checkpoint', 'digest'], optional: [] },
  reject: { required: ['root', 'run', 'checkpoint', 'digest', 'reason'], optional: [] },
  authorize: { required: ['root', 'run'], optional: [] },
  'kill-all': { required: ['root', 'reason'], optional: [] },
  metrics: { required: ['root'], optional: ['json'] },
  adoption: { required: ['root', 'run', 'note'], optional: [] },
  sweep: { required: ['root'], optional: ['apply'] },
  export: { required: ['root', 'run', 'out'], optional: [] },
});
const BOOLEAN = new Set(['confirm-author', 'revise', 'json', 'apply']);
export const USAGE =
  'Usage: zt-run <start|resume|pr-edit|withdraw|cancel-action|status|pause|cancel|approve|reject|authorize|kill-all|metrics|adoption|sweep|export> --root <dir> [command options]';
const HELP = `${USAGE}\nstart --config <file.json> [--confirm-author] [--author-name <name>] [--author-email <email>]\nresume --run <id> [--revise]\nstatus --run <id> [--json]\npause --run <id> --reason <text>\ncancel --run <id> --reason <text>\napprove --run <id> --checkpoint <plan|patch|verification> --digest <sha256>\nreject --run <id> --checkpoint <plan|patch|verification> --digest <sha256> --reason <text>\nauthorize --run <id>\nkill-all --reason <text>\nmetrics [--json]\nadoption --run <id> --note <text>\nsweep [--apply]\nexport --run <id> --out <file>`;
const ERROR_CODES = new Set([
  'invalid_input',
  'invalid_control',
  'nothing_to_pause',
  'cleanup_required',
  'terminal',
  'invalid_config',
  'unknown_key',
  'invalid_issue_url',
  'invalid_contributor',
  'invalid_author_approval',
  'unsupported_environment',
  'invalid_model_profile',
  'invalid_env_name',
  'invalid_budget',
  'missing_rate',
  'invalid_checkpoints',
  'invalid_limits',
  'invalid_signer_key',
  'invalid_github_app',
  'invalid_retention',
  'invalid_resume_run_id',
  'secret_detected',
  'author_confirmation_required',
  'author_confirmation_declined',
  'author_approval_missing',
  'author_approval_mismatch',
  'author_email_unverified',
  'author_identity_unavailable',
  'revision_unavailable',
  'root_mismatch',
  'store_locked',
  'invalid_store',
  'invalid_run_id',
  'snapshot_expired',
  'checkpoint_invalid',
  'checkpoint_stale',
  'checkpoint_closed',
  'checkpoint_not_open',
  'busy',
  'not_running',
  'invalid_outcome',
  'invalid_journal',
  'step_failed',
  'admission_closed',
  'driver_failed',
  'recovery_failed',
  'operation_failed',
  'incident_active',
  'authorization_denied',
  'authorization_expired',
  'exchange_failed',
  'app_misconfigured',
  'revoke_failed',
  'loopback_unavailable',
  'state_mismatch',
  'invalid_callback',
]);
const INPUT_CODES = new Set([
  'invalid_input',
  'invalid_config',
  'unknown_key',
  'invalid_issue_url',
  'invalid_contributor',
  'invalid_author_approval',
  'invalid_model_profile',
  'invalid_env_name',
  'invalid_budget',
  'missing_rate',
  'invalid_checkpoints',
  'invalid_limits',
  'invalid_signer_key',
  'invalid_github_app',
  'invalid_retention',
  'invalid_resume_run_id',
  'invalid_run_id',
  'secret_detected',
  'root_mismatch',
  'checkpoint_invalid',
]);
function refuse(code) {
  throw Object.assign(new Error(), { code });
}
function parse(argv) {
  if (!Array.isArray(argv) || argv.some((v) => typeof v !== 'string')) refuse('invalid_input');
  if (argv.length === 1 && ['--help', '-h', 'help'].includes(argv[0])) return { help: true };
  const [command, ...rest] = argv;
  if (!Object.hasOwn(COMMANDS, command ?? '')) refuse('invalid_input');
  const spec = COMMANDS[command];
  const opts = Object.create(null);
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    if (!flag.startsWith('--')) refuse('invalid_input');
    const key = flag.slice(2);
    if (![...spec.required, ...spec.optional].includes(key) || Object.hasOwn(opts, key))
      refuse('invalid_input');
    if (BOOLEAN.has(key)) opts[key] = true;
    else {
      const value = rest[++i];
      if (!value || value.startsWith('--') || value.trim() !== value) refuse('invalid_input');
      opts[key] = value;
    }
  }
  if (spec.required.some((key) => !Object.hasOwn(opts, key))) refuse('invalid_input');
  assertSecretFree(opts);
  // biome-ignore lint/suspicious/noControlCharactersInRegex: CLI control text cannot select paths or spoof output.
  if (Object.values(opts).some((v) => typeof v === 'string' && /[\u0000-\u001f\u007f]/u.test(v)))
    refuse('invalid_input');
  if (opts.run && !/^ztc-[a-f0-9]{16}-run-1$/u.test(opts.run)) refuse('invalid_input');
  if (opts.checkpoint && !['plan', 'patch', 'verification'].includes(opts.checkpoint))
    refuse('invalid_input');
  if (opts.digest && !/^[a-f0-9]{64}$/u.test(opts.digest)) refuse('invalid_input');
  if (opts.reason && (!opts.reason.trim() || opts.reason.length > 500)) refuse('invalid_input');
  if (opts.note && (!opts.note.trim() || opts.note.length > 2000)) refuse('invalid_input');
  if (
    command === 'withdraw' &&
    (!['maintainer_request', 'user_instruction'].includes(opts.reason) ||
      opts.explanation.length > 2000)
  )
    refuse('invalid_input');
  if (opts.title && opts.title.length > 256) refuse('invalid_input');
  return { command, opts };
}
function readConfig(file) {
  let fd;
  try {
    fd = fs.openSync(
      file,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK
    );
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 1024 * 1024) refuse('invalid_config');
    const raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(fd)));
    const config = validateRunConfig(raw);
    if (config.resumeRunId) refuse('invalid_resume_run_id');
    return config;
  } catch (error) {
    if (ERROR_CODES.has(error?.code)) throw error;
    refuse('invalid_config');
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}
const exitFor = (status) =>
  ['blocked', 'failed', 'unsupported', 'cancelled', 'blocked_cleanup'].includes(status.state)
    ? 2
    : 0;
function authorizationLine(url) {
  assertSecretFree(url);
  const u = new URL(url);
  if (
    u.origin !== 'https://github.com' ||
    u.pathname !== '/login/oauth/authorize' ||
    u.username ||
    u.password ||
    u.hash ||
    [...u.searchParams.keys()].some(
      (k) =>
        ![
          'client_id',
          'redirect_uri',
          'state',
          'code_challenge',
          'code_challenge_method',
          'login',
          'allow_signup',
        ].includes(k)
    )
  )
    refuse('operation_failed');
  return `authorization_url: ${JSON.stringify(u.href)}`;
}
/** createController constructs the command facade; production entry binds the real
 * composed controller. Tests inject this factory, never environment overrides. */
export async function main(argv, { createController, out, err, confirmAuthor } = {}) {
  let parsed;
  try {
    parsed = parse(argv);
    if (parsed.help) {
      out(HELP);
      return 0;
    }
    const { command, opts } = parsed;
    // Invalid configuration must fail before any OAuth, controller or store effects.
    const config = command === 'start' ? readConfig(opts.config) : undefined;
    const controller = await createController({
      root: opts.root,
      onAuthorizationUrl: (url) => out(authorizationLine(url)),
    });
    let status;
    switch (command) {
      case 'start': {
        if (!opts['confirm-author'] && !confirmAuthor) refuse('author_confirmation_required');
        const author = await controller.prepareAuthor(config, {
          name: opts['author-name'],
          email: opts['author-email'],
        });
        // Reuse the closed config approval validator before displaying or persisting.
        const approved = validateRunConfig({ ...runConfigInput(config), authorApproval: author });
        out(`author_identity: ${JSON.stringify(approved.authorApproval)}`);
        if (!opts['confirm-author'] && (await confirmAuthor(approved.authorApproval)) !== true)
          refuse('author_confirmation_declined');
        status = await controller.start(approved);
        break;
      }
      case 'resume':
        status = await controller.resume(opts.run, { revise: Boolean(opts.revise) });
        break;
      case 'pr-edit':
      case 'withdraw':
      case 'cancel-action': {
        const result = await controller.prAction(
          opts.run,
          command === 'pr-edit'
            ? { kind: 'edit', title: opts.title, bodyFile: opts['body-file'] }
            : command === 'withdraw'
              ? { kind: 'withdraw', reason: opts.reason, explanation: opts.explanation }
              : { kind: 'cancel-action' }
        );
        assertSecretFree(result);
        if (typeof result?.link !== 'string' || typeof result?.instructions !== 'string')
          refuse('operation_failed');
        const link = new URL(result.link);
        if (
          link.origin !== 'https://github.com' ||
          !/^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9][0-9]*$/u.test(link.pathname) ||
          link.search ||
          link.hash ||
          link.username ||
          link.password
        )
          refuse('operation_failed');
        out(`contributor_link: ${JSON.stringify(link.href)}`);
        out(`instructions: ${JSON.stringify(result.instructions)}`);
        if (result.title) out(`prepared_title: ${JSON.stringify(result.title)}`);
        if (result.bodyFile) out(`prepared_body_file: ${JSON.stringify(result.bodyFile)}`);
        return 0;
      }
      case 'status':
        status = await controller.status(opts.run);
        break;
      case 'pause':
      case 'cancel': {
        const request = await controller[command](opts.run, opts.reason);
        if (
          request?.kind !== command ||
          request?.runId !== opts.run ||
          !/^[a-f0-9-]{36}$/u.test(request?.id ?? '')
        )
          refuse('operation_failed');
        out(`${command}_requested: ${JSON.stringify(request.id)}`);
        return 0;
      }
      case 'approve':
        status = await controller.approve(opts.run, {
          point: opts.checkpoint,
          digest: opts.digest,
        });
        break;
      case 'reject':
        status = await controller.reject(
          opts.run,
          { point: opts.checkpoint, digest: opts.digest },
          opts.reason
        );
        break;
      case 'authorize':
        status = await controller.authorize(opts.run);
        break;
      case 'adoption':
        status = await controller.adoption(opts.run, opts.note);
        break;
      case 'kill-all': {
        const statuses = await controller.killAll(opts.reason);
        for (const s of statuses) out(renderHuman(s));
        out('incident_stop: completed');
        return statuses.some((s) => s.state === 'blocked_cleanup') ? 2 : 0;
      }
      case 'metrics': {
        const metrics = await controller.metrics();
        out(opts.json ? renderMetricsJson(metrics) : renderMetricsHuman(metrics));
        return 0;
      }
      case 'sweep': {
        const result = await controller.sweep({ apply: Boolean(opts.apply) });
        if (
          typeof result.applied !== 'boolean' ||
          ![result.contributions, result.files].every((v) => Number.isSafeInteger(v) && v >= 0)
        )
          refuse('operation_failed');
        out(
          `sweep: ${JSON.stringify({ applied: result.applied, contributions: result.contributions, files: result.files })}`
        );
        return 0;
      }
      case 'export':
        await controller.export(opts.run, opts.out);
        out('export: completed');
        return 0;
      default:
        refuse('invalid_input');
    }
    out(opts.json ? renderJson(status) : renderHuman(status));
    return exitFor(status);
  } catch (error) {
    let code =
      error?.name === 'SecretRedactionError'
        ? 'secret_detected'
        : error?.name === 'StoreLockedError'
          ? 'store_locked'
          : error?.code;
    if (!ERROR_CODES.has(code)) code = 'operation_failed';
    err(`error: ${code}`);
    const exit = code === 'store_locked' || code === 'busy' ? 4 : INPUT_CODES.has(code) ? 3 : 2;
    if (exit === 3) err(USAGE);
    return exit;
  }
}
