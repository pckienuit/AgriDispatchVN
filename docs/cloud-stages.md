# IS402 branch delivery gates

Implementation branch: `cloud/is402-2026-11-24`, from `22b56ae9d7f342e2b434c4cbf18c06c407d11476`. Plan approved by project lead in chat on 17 November 2026, including staged commits and publishing this branch/PR. No merge to main, force-push, paid provision or public release is implied by that approval.

## Commit sequence

| Stage | Output | Target handoff |
| --- | --- | --- |
| G0 | API contract, invariant/role/config agreement, branch rules | 18 November |
| G1 | Account process, registration/login/session and DB-backed throttle | 18 November |
| G2 | Service catalog, provider/machine/operator profiles and fields | 18–19 November |
| G3 | Quote snapshot, persisted booking/events and scoped idempotency | 19 November |
| G4 | First API-backed UI and two-service Compose | 19–20 November |
| G5 | Coop clustering, atomic package claim and schedule conflicts | 20 November |
| G6 | Recruitment, offers and capacity-safe acceptance | 20 November |
| G7 | Shift execution, acceptance and external payment records | 20–21 November |
| G8 | Cancellation/postponement and versioned dispute remedies | 21 November |
| G9 | Private evidence files and thumbnail Function | 21 November |
| G10 | Remaining role UI, activity/notifications and minimal administration | 22 November |
| G11 | Reproducible synthetic generator and sanity checks | start 19, finish 22 November |
| G12 | Load/region scripts and real measurements | start 19, finish 22 November |
| G13 | SHA images, CI/CD integration with approved Azure targets | 20–22 November, parallel |
| G14 | Regression, readiness, blue/green and data-safe rollback | 22 November |
| G15 | IS402-specific evidence index, report and offline demo runbook | 23 November |

These are targets, not evidence of completion. G4 is the early handoff; infrastructure and CI work start with scaffold and must not wait for all extended workflows. Recruitment is mandatory, not an optional stretch. Prior demo thresholds, fees, speed rules and legal claims are not accepted business constants. Start with explicit request data and manual grouping, not an unverified optimizer.

## Approved postponement boundary

Project lead approved in chat on 18 November 2026: postpone a whole claimed package only before any shift starts. Every distinct actual booking owner and the assigned provider must personally consent to the same latest proposal version; proposing does not count as consent. A coordinating coop may propose but cannot sign for an owner; a coop that actually owns a booking retains that owner's authority. Keep the current schedule until consent is complete and the new interval passes machine/operator conflict checks plus the operator's accepted commitment covering the entire interval. Keep prior windows and consents as history; booking quote/request snapshots remain unchanged. No automatic fees, refunds, blame, timeout consent or assumed 3–5 day limit. This records scope approval, not implemented or deployed acceptance.

## Ownership and handoff

Application developer supplies runnable code, schema, seed, tests, API changes and commit SHA. Infra owner Hơn checks credit/quota/SKU, prepares approved app/DB/Blob/permissions and returns target configuration plus logs. CI owner Duyên integrates pipeline, cross-service/cloud tests, Function invocation, load measurement and presentation evidence. Developer assists their code; owners must still run and understand their part. Never edit the same workflow/Compose file concurrently without assigning ownership.

## Commit/test policy

- Small stage-specific commits include runnable checks, not placeholders. Add tests first, observe expected failure, then implement and rerun.
- Run lint, unit and relevant disposable-DB integration checks before handoff; record actual commands and failures, never invent results.
- Use explicit staged paths and review staged diff. Fixes after handoff are separate commits; no amended shared history.
- Applied migrations are immutable. Use new compatible migrations; app rollback selects old image, never drops data.
- Tests and generated datasets must not reset shared data. Seed records labelled synthetic; no survey/personal data in source.
- UI uses plain JS/CSS, genuine API state and accessible mobile/desktop flows. No silent mock fallback.

## Cloud blockers and safeguards

Allowed-region policy last read: koreacentral, uaenorth, japaneast, indonesiacentral, centralindia. Recheck policy, service SKU and quota before provisioning. None of these region names proves availability.

Spend cap is 50% Student credit remaining at start, based on a timestamped actual balance. This cap includes a second benchmark region, storage, logs, network and cleanup interval. No Pay-As-You-Go or money outside credit. Budget notifications are not hard caps. No billable resources until balance and estimate are verified and approved. Destructive cleanup needs separate approval.

Assignment lists Registry, AKS, Azure DevOps, Monitor, Web Apps, Jenkins, Terraform and Key Vault. Proposed App Service/GitHub Actions substitutions remain lecturer-confirmation gaps, not claimed exemptions. Four-page/service mapping and whether >4 GB means DB or DB+objects remain explicit open assessment questions. They do not block local app implementation.

Report/demo artifacts are separate from IE104/IE106. Freeze technical evidence by end 22 November, report by noon 23 November, rehearse that evening. Report on 24 November with smoke checks only; exact presentation time still unverified. Public registered repo receives only approved clean release after privacy review, never internal academic files or secrets.
