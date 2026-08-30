export type CodexServerRequestReply =
  | { result: Record<string, unknown> }
  | { error: { code: number; message: string } };

const FILE_APPROVAL_METHOD = 'item/fileChange/requestApproval';
const PERMISSIONS_APPROVAL_METHOD = 'item/permissions/requestApproval';
const V1_APPROVAL_METHODS = new Set(['execCommandApproval', 'applyPatchApproval']);

export function codexApprovalReply(
  method: string,
  params: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
): CodexServerRequestReply | undefined {
  if (V1_APPROVAL_METHODS.has(method)) {
    return { result: { decision: 'approved_for_session' } };
  }
  if (!method.endsWith('/requestApproval')) return undefined;

  if (method === PERMISSIONS_APPROVAL_METHOD) {
    return { result: { permissions: grantedPermissions(params.permissions, env), scope: 'session' } };
  }
  if (method === FILE_APPROVAL_METHOD) {
    return { result: { decision: 'acceptForSession' } };
  }

  const decision = commandDecision(params.availableDecisions);
  return { result: { decision } };
}

export function codexApprovalNote(
  method: string,
  params: Record<string, unknown>,
  reply: CodexServerRequestReply,
  env: NodeJS.ProcessEnv,
): string {
  const result = 'result' in reply ? reply.result : {};
  const decision = typeof result.decision === 'string'
    ? result.decision
    : method === PERMISSIONS_APPROVAL_METHOD
      ? 'session permissions'
      : 'session approval';
  let note = `codex asked for ${method}; cezar-plus auto-approved (${decision}), bypass permissions`;

  if (method !== PERMISSIONS_APPROVAL_METHOD && commandDecisionWasFallback(params.availableDecisions)) {
    note += `; offered decisions: ${formatOfferedDecisions(params.availableDecisions)}`;
  }
  if (method === PERMISSIONS_APPROVAL_METHOD && env.CEZ_CODEX_NETWORK === '0' && hasNetwork(params.permissions)) {
    note += '; network permission withheld because CEZ_CODEX_NETWORK=0';
  }
  return note;
}

function grantedPermissions(value: unknown, env: NodeJS.ProcessEnv): Record<string, unknown> {
  const permissions = isRecord(value) ? { ...value } : {};
  if (env.CEZ_CODEX_NETWORK === '0') delete permissions.network;
  return permissions;
}

function commandDecision(value: unknown): string {
  if (value === undefined || value === null) return 'acceptForSession';
  if (Array.isArray(value) && value.includes('acceptForSession')) return 'acceptForSession';
  if (Array.isArray(value) && value.includes('accept')) return 'accept';
  return 'accept';
}

function commandDecisionWasFallback(value: unknown): boolean {
  return value !== undefined && value !== null && (!Array.isArray(value)
    || (!value.includes('acceptForSession') && !value.includes('accept')));
}

function formatOfferedDecisions(value: unknown): string {
  try {
    const encoded = JSON.stringify(value);
    return encoded && encoded.length <= 240 ? encoded : String(value);
  } catch {
    return String(value);
  }
}

function hasNetwork(value: unknown): boolean {
  return isRecord(value) && Object.prototype.hasOwnProperty.call(value, 'network');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

