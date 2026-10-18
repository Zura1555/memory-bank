export const OPERATION_CHECKS = {
  api_adapter: {
    client_api_access: "Before use, verify the exact client API endpoint, account, and required authentication and authorization are available.",
    client_operation_limits: "Before use, confirm that the current client's exact tenant and endpoint accept the requested operation and limits below. Acceptance remains unconfirmed until verified.",
    result_status_duplicates: "Before use, verify result, status, and duplicate-handling semantics for the exact operation.",
    environment_boundary: "Before use, verify the deployment environment and explicit write/production boundary for this operation.",
  },
  recovery_handover: {
    operating_authority: "Before use, verify current primary and backup owners, escalation path, and decision authority.",
    checkpoint_replay: "Before use, verify the target checkpoint and replay behavior for this operation.",
    witnessed_acceptance: "Before use, verify signed acceptance evidence and a newly witnessed exercise of this operation.",
    environment_boundary: "Before use, verify the deployment environment and explicit write/production boundary for this operation.",
  },
  data_mapping: {
    field_identity: "Before use, verify field identity, filters, and record-identity rules against the current source and target.",
    reconciliation: "Before use, verify reconciliation rules and expected results for mapped records.",
    environment_boundary: "Before use, verify the deployment environment and explicit write/production boundary for this operation.",
  },
  access_provisioning: {
    identity_scope: "Before use, verify the exact identity, granted scope, and authorization for this operation.",
    revocation: "Before use, verify how access is revoked and confirm revocation behavior.",
    environment_boundary: "Before use, verify the deployment environment and explicit write/production boundary for this operation.",
  },
} as const;

export type OperationKind = keyof typeof OPERATION_CHECKS;
export type OperationCheckKind = {
  [Operation in OperationKind]: keyof typeof OPERATION_CHECKS[Operation]
}[OperationKind];

export function renderOperationCheck(operation: OperationKind, kind: OperationCheckKind, requestQuotes: readonly string[]): string {
  const text = (OPERATION_CHECKS[operation] as Partial<Record<OperationCheckKind, string>>)[kind];
  if (!text) throw new Error("UNKNOWN_OPERATION_CHECK");
  if (kind !== "client_operation_limits") return text;
  if (requestQuotes.length !== 1) throw new Error("OPERATION_LIMIT_REQUEST_REQUIRED");
  return `${text} Current request: ${requestQuotes[0]}`;
}
