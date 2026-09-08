# SuperCool Finances — Working Agreement (CLAUDE.md)

This file is the **harness definition** for working in this repository: how we
build (methodology), who does what (the agent workflow), how we document, and how
the repo is laid out. It stays general on purpose — the concrete, component-level
detail lives in `specs/`, and the design rationale in `docs/`.

## What this project is (in one breath)

SuperCool Finances is a **safety-critical service for managing customer account
balances**: customer money must never be created, lost, or moved without
authorization. The system separates a **public customer surface** from a
**private admin surface** behind a gateway, keeps an **authoritative transactional
core** plus a **derived read model** for analytics, and is orchestrated with
**Docker Compose**. That is the *macro*; everything below is *how we build it*, not
*what it is*. For what it is, read `docs/`; for what to build and in what order,
read `specs/`.

## Methodology — top-down, macro → micro

- Build from the **macro** (architecture, moving parts) down to the **micro** (each
  component's internals), one component at a time, in the order set by `specs/`.
- **Heuristic:** if a piece of the micro won't fall into place, stop and **revisit
  the macro** — a correct macro makes the micro fall out with little friction.
  Persistent friction in the small is a signal the design in the large is wrong.
- **Escalate, don't work around.** If the micro still won't fit after looking back
  at the macro, **stop and escalate to the developer** — never invent a silent
  local workaround. Where possible, bring **at most three** candidate solutions
  derived from the macro (for each: how it resolves the misfit from macro down to
  micro, and its trade-offs). The **developer has the final word**; wait for that
  decision before proceeding.
- **Open questions are resolved with the developer, not guessed.** The `open
  questions` a spec carries are settled with the developer *before or at*
  implementation — same escalation path. Don't assume an answer to keep moving.
- `specs/` is the **source of truth** for *what* to build per component, and each
  spec ends with a **Definition of Done** that is the acceptance gate. Don't invent
  scope beyond the active spec; if a spec is wrong, fix the spec (and, if needed,
  the macro) *before* writing code.

## The agent workflow (harness)

The **main session is the orchestrator.** It decomposes the work into **steps**
sized by scope — **a step is the unit of work, not a spec.** A single spec may take
several steps; each step is built, reviewed, and shipped **as its own PR**. The
orchestrator splits work so a step is small enough to review in one pass, then runs
the sub-agents (defined in **`.claude/agents/`**) in order for that step.

Three roles per step; keep them **distinct** — no role grades its own work:

1. **Implementor** — builds the step's functionality to satisfy the relevant part
   of the spec and the repo conventions. Produces code only.
2. **Test writer** — writes the tests for that step **from the spec, not from the
   implementor's code** (so tests encode *intended* behavior): unit, integration,
   and the money-safety suites the step calls for. Follows the **Testing
   discipline** below.
3. **Self-reviewer** — runs **only after the implementor and test writer both
   finish and the verification gate is green**. It reviews the step's **code and
   tests together** via a **generate-then-evaluate loop**: it produces findings
   (bugs, security, performance, correctness, maintainability, conventions, **and
   test quality** — severity High/Medium/Low, each with a concrete fix), then an
   evaluator pass cross-checks each against the diff — removing false positives,
   recalibrating severity, adding missed **Medium+** issues — capped at **two
   iterations**. It returns actionable feedback **split for the implementor and the
   test writer**; they fix, it re-checks. A clean pass (or all findings resolved)
   is the gate to open the PR.

**Pipeline (per step):**
`implement + write tests → verification gate (build · tests · lint) → self-review (fix loop) → PR`

Harness rules:

- The orchestrator **sizes steps to the scope** — small enough to build and review
  in one pass — and opens **one PR per step**.
- A **verification gate** runs before the self-review: the code must **build**, the
  **test suite must pass**, and **lint/format** must be clean. It's mechanical (no
  judgment — the CI a script would run); failures bounce back to the implementor /
  test writer, never to the reviewer.
- The **self-reviewer does not start** until the implementor *and* the test writer
  both report done *and* the gate is green — reviewing half-built or broken work
  wastes the pass.
- Feedback is **specific and actionable** (exact file/line + a concrete fix) and
  **calibrated honestly** — not everything is High.
- Reviews are **advisory-but-gating**: a High finding blocks the PR until fixed, or
  explicitly waived with a written reason.
- **Never commit secrets.** A hardcoded secret is always a High finding, flagged
  immediately.

## Git & PR conventions

- **Never push to `main`.** All work lands via **pull requests**; `main` advances
  only by merging a reviewed PR.
- **One PR per step** — the scope-sized unit the orchestrator defined, so review
  stays small (a spec may span several step PRs).
- **Branch per step**, named for the work (e.g. `storage-compose-spine`,
  `balance-ledger-schema`, `fix-otp-expiry`).
- **Descriptive commits**; **no secrets in history** — commit `*.example` env files
  only.
- A PR is opened only **after the self-review passes** (or its findings are
  resolved / waived with a written reason).

## Documentation discipline

- **Documentation lives in a `docs/` folder inside each code folder** — one per
  service and per frontend (e.g. `services/balance-service/docs/`). That folder
  holds the real documentation: how the component works, its modules, contracts,
  and local decisions.
- **Inline documentation is minimal.** In code, document only what the code cannot
  say for itself: a public contract, a non-obvious *why*, an invariant. No narrated
  walkthroughs, no comments that restate the code.
- **Cross-cutting** design (architecture, decisions, threat model) stays in the
  **repo-root `docs/`**; **per-component** docs stay in that component's `docs/`.
  Never scatter design notes across source files.
- When behavior changes, **update that component's `docs/` in the same change** —
  docs are part of the Definition of Done, not an afterthought.

## Testing discipline

- **Quality over quantity.** A test's worth is whether it can **fail on a real
  defect** — never the count or the coverage number. Prefer a small, sharp suite
  that exercises real behavior and edge cases over many shallow tests.
- **Never** write coverage-padding, assertion-free or tautological tests
  (`expect(x).toBe(x)`, "it renders"), tests that only confirm a mock was called, or
  over-mocking that mocks away the logic under test. If a meaningful test can't be
  written, **say why** instead of writing a hollow one.
- **Tests live in each component's `tests/` folder**, segregated from `src/`.
- **What to prove is per-component** — each spec's Definition of Done names the
  specific proofs that component needs (e.g. concurrency, idempotency, holds,
  reconciliation). **How to write them** is the test-writer agent's method. This
  file sets the standard both follow.

## Repository layout (monorepo)

Each app is **self-contained and atomic** in its own folder: **no cross-folder
imports, no shared code**. Each folder could be extracted to its own repository —
the monorepo is a **delivery convenience only**, and the structure must be kept
that way. Components share **conventions, not code or databases**.

> **Consequence:** where two components must agree on a contract — e.g. the
> transaction event shape between the balance service and the analytics server —
> each keeps its **own copy**, kept in sync via the spec, which is the contract of
> record. Duplication here is the accepted price of independence.

```
supercool-finances/
├── docker-compose.yml          # orchestrator — ROOT level, the spine (grows one service at a time)
├── CLAUDE.md                   # this file
├── docs/                       # cross-cutting design (architecture, decisions, threat model)
├── specs/                      # build specs — source of truth per component
├── services/
│   ├── balance-service/        # NestJS backend — own folder
│   │   ├── src/                # production code
│   │   ├── tests/              # test suite — segregated from src
│   │   └── docs/
│   └── analytics-server/       # NestJS backend — own folder
│       ├── src/
│       ├── tests/
│       └── docs/
├── web/
│   ├── client/                 # customer SPA — own folder
│   │   ├── src/
│   │   ├── tests/
│   │   └── docs/
│   ├── otp/                    # OTP SPA — own folder
│   │   ├── src/
│   │   ├── tests/
│   │   └── docs/
│   └── admin/                  # admin SPA — own folder
│       ├── src/
│       ├── tests/
│       └── docs/
├── infra/                      # runtime config + env per architectural component (one subfolder each)
│   ├── nginx-public/
│   ├── nginx-internal/
│   ├── kong-public/
│   ├── kong-internal/
│   ├── keycloak/               # keycloak runtime config/env
│   ├── postgres/               # db init scripts
│   ├── redis/
│   └── mongo/
└── tools/                      # utilities kept out of service source
    ├── seed/                   # DB seed scripts/data (customers, accounts, limits, clearing accounts)
    └── keycloak/               # realm export + provisioning scripts
```

Layout rules:

- **`docker-compose.yml` is at the root** and is the spine — every component plugs
  into it, and it grows one service at a time as specs are built.
- **Each frontend and each backend gets its own top-level folder** (under `web/`
  and `services/`), with its own build, dependencies, and `docs/`.
- **Tests live in a dedicated `tests/` folder** in each component, **segregated
  from `src/`** — production code and the test suite never intermingle.
- **Architectural-component config lives under `infra/`**, one subfolder per
  component (nginx ×2, kong ×2, keycloak, and the datastore init) — config and env
  files, not code.
- **Utilities live under `tools/`** — DB seeding and keycloak provisioning — kept
  out of the services' source.
- **No secrets in the repo:** commit `*.example` env files only; real secrets stay
  local / in Docker secrets.

## Out of scope

This is a **self-contained prototype**, not a production deployment. **No CI/CD, no
cloud infrastructure, no vendor-specific services** (managed load balancers, CDNs,
managed identity, etc.) — the whole system runs via `docker-compose`. If a decision
seems to call for one of those, that's a signal to **simplify or mock**, not to add
deployment machinery.

---

For *what* to build and in *what order*, start at `specs/README.md`.
