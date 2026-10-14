FICTIONAL SOURCE — Synthetic client-onboarding request. No real client or system is represented.

# Harbor Research: air-gapped operator access

Date stated: 2025-06-09

Harbor Research requires provisioning two operators in an air-gapped lab with hardware-backed smart cards. The environment has no network route to an identity provider or external service during normal operation. Smart-card enrollment must remain local; the client has not provided card middleware, certificate policy, or approved offline identity authority details.

The request asks for least-privilege access to a local data-review application. No network connection, cloud directory, or SSO enrollment is permitted. Acceptance depends on the client security officer validating the card trust chain and local account lifecycle. No existing implementation from this client is supplied.
