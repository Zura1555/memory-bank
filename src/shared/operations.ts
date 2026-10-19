export const OPERATION_CHECKS = {
  api_adapter: {
    client_api_access: "Before use, verify the exact client API endpoint, account, and required authentication and authorization are available.",
    client_operation_limits: "Before use, confirm that the current client's exact tenant and endpoint accept the requested operation and limits below. Acceptance remains unconfirmed until verified.",
    result_status_duplicates: "Before use, verify result, status, and duplicate-handling semantics for the exact operation.",
    environment_boundary: "Before use, verify the deployment environment and explicit write/production boundary for this operation.",
  },
  recovery_handover: {
    operating_authority: "Before use, verify current primary and backup owners, escalation path, decision authority, and the requested escalation duration, unit, and triggering event.",
    checkpoint_replay: "Before use, block recovery unless the target checkpoint and replay behavior are explicit and verified; if either is missing or unclear, do not proceed.",
    witnessed_acceptance: "Before use, verify the requested acceptance criteria and signed evidence, and require a newly witnessed exercise of this operation; historical test results do not satisfy current acceptance proof or establish production readiness.",
    environment_boundary: "Before use, verify the deployment environment and explicit write/production boundary for this operation.",
  },
  data_mapping: {
    field_identity: "Before use, verify field identity, filters, and record-identity rules against the current source and target.",
    reconciliation: "Before use, verify reconciliation rules and expected results for mapped records.",
    completion_feasibility: "Before use, validate current-client feasibility for the exact workload or timing requirement below as part of the complete accepted/rejected reconciliation target. Combine this result with the same operation's other scope and timing checks; this one bound span need not repeat their constraints. Do not infer missing scope, deadline, duration, or trigger. Feasibility remains unconfirmed until the complete target is validated; it is not a demonstrated capability.",
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
export const REQUIRED_OPERATION_CHECKS = {
  api_adapter: ["client_api_access", "result_status_duplicates", "environment_boundary"],
  recovery_handover: ["operating_authority", "checkpoint_replay", "witnessed_acceptance", "environment_boundary"],
  data_mapping: ["field_identity", "reconciliation", "environment_boundary"],
  access_provisioning: ["identity_scope", "revocation", "environment_boundary"],
} as const satisfies {
  [Operation in OperationKind]: readonly (keyof typeof OPERATION_CHECKS[Operation])[];
};


export function renderOperationCheck(operation: OperationKind, kind: OperationCheckKind, requestQuotes: readonly string[]): string {
  const text = (OPERATION_CHECKS[operation] as Partial<Record<OperationCheckKind, string>>)[kind];
  if (!text) throw new Error("UNKNOWN_OPERATION_CHECK");
  if ((kind === "client_operation_limits" || kind === "completion_feasibility") && requestQuotes.length !== 1) {
    throw new Error(kind === "client_operation_limits" ? "OPERATION_LIMIT_REQUEST_REQUIRED" : "COMPLETION_TARGET_REQUEST_REQUIRED");
  }
  if (requestQuotes.length === 0) return text;
  if (requestQuotes.length !== 1) throw new Error("OPERATION_CHECK_REQUEST_INVALID");
  return `${text} Verify the exact requirement below for this check's responsibility before use. Current request: ${requestQuotes[0]}`;
}
