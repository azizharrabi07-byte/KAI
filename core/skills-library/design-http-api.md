---
name: design-http-api
description: Designs or changes an HTTP API contract against fixed REST guidelines, covering resources, methods, status codes, problem details, pagination, concurrency, security and versioning, and keeps its OpenAPI document, Swagger UI and Bruno collection in the same change. Use when endpoints or routes are designed, added, changed or removed, when an OpenAPI document or Bruno collection is written, when an API change is reviewed, or when a feature needs a backend endpoint even though nobody says "API".
---

An HTTP API is a contract other code builds against. A contract that reinvents HTTP semantics or ships without its documentation can only be corrected later with a breaking change, so the rules apply while designing, not in review afterwards.

The rules live in the references; each step names the file it needs. A project convention that contradicts a rule wins inside that project, but name the contradiction to the caller as a conflict instead of passing over it. A departure from a MUST rule carries its reason in the OpenAPI document.

## 1. Fix the per-API choices

Several rules ask for one choice per API. Deciding them per endpoint is how one API ends up with two casings. Look for recorded values in the OpenAPI document, `CLAUDE.md` or `AGENTS.md`, `docs/adr/` and the architecture issue.

| Choice | Default when nothing is recorded |
|---|---|
| Field and query parameter casing | `camelCase` |
| Enum value casing | `UPPER_SNAKE_CASE` |
| Resource ID format | UUIDv7 |
| Pagination | cursor |
| Patch format | JSON Merge Patch |
| Major version | path prefix `/v1` |
| OpenAPI document and Bruno collection location | existing ones, otherwise ask |

For each choice without a recorded value, propose the default to the caller and record the agreed value where the project keeps its conventions. Inside a run nobody can answer, such as `implement-ticket`, stop and report the missing choice instead.

**Done when** every choice in the table has a recorded value.

## 2. Model resources, methods and status codes

Read [resources, methods and status codes](references/resources-and-methods.md).

- Resources are plural nouns in `kebab-case`, nested at most two levels. A state transition such as a cancellation becomes a sub-resource, not a verb in the path.
- The method follows its semantics: `GET` without side effects, `PUT` replaces fully, `PATCH` with a declared patch media type, `DELETE` idempotent.
- List every status code an operation can return, including `401`, `403`, `404`, `409`, `422` and `429` where they apply. Codes nobody listed become `500` in the implementation.

**Done when** every operation has a path, a method and its complete list of status codes.

## 3. Define errors and payloads

Read [errors and payloads](references/errors-and-payloads.md).

- Every `4xx` and `5xx` is `application/problem+json` with a stable `type` URI; clients program against `type`, so each operation lists the `type` values it can return.
- Every field gets its type from the types table: timestamps in UTC with `Z`, money as decimal string plus currency, integers above 2^53 as strings.
- Responses are objects, never bare arrays; empty collections are `[]`.

**Done when** every error response names its problem `type` and every field has a type from the table.

## 4. Decide state and load behaviour

Read [collections, concurrency, caching and idempotency](references/collections-and-state.md) when the change has a collection, a mutable resource, a `POST` with a business effect or an operation that runs longer than about two seconds.

- Collections: cursor pagination, capped `limit`, allowlisted filters and a total sort order.
- Mutable resources: `ETag` on `GET`, `If-Match` on writes, `412` and `428`.
- Every response: explicit `Cache-Control`, `Vary` where the response varies.
- `POST` with a business effect: `Idempotency-Key`.
- Long-running work: `202` with a job resource.

**Done when** each of the five points is either specified for the affected operations or named as not applicable.

## 5. Secure the operations

Read [security and data minimisation](references/security-and-privacy.md) when the change touches authentication, CORS, rate limits, client-supplied URLs, webhooks or personal data.

Every operation, whether or not the file is read:

- names its authentication and the scopes or roles it needs, and authorises per resource instance, because a check per endpoint lets one customer read another's objects;
- validates the request against the schema before business logic, with `additionalProperties: false` and bounded strings, numbers and arrays;
- carries no personal data or secrets in its path or query string.

**Done when** every operation names its auth and scopes and has bounded request schemas, and no path or query holds personal data.

## 6. Classify changes to existing operations

Skip this step for new operations. Otherwise read [versioning, evolution and documentation](references/evolution-and-contract.md).

Classify every change to an existing operation as non-breaking or breaking. A breaking change needs a new major version, and that decision belongs to the caller: stop and ask. Deprecated operations get `Deprecation` and `Sunset` headers.

**Done when** every change to an existing operation is classified, and every breaking one is decided by the caller.

## 7. Update the contract artifacts

Read [contract artifacts](references/contract-artifacts.md).

In the same change as the design or code:

- the OpenAPI 3.1 document describes every added or changed operation completely and drops removed ones;
- Swagger UI serves that same document and is not publicly reachable in production;
- the Bruno collection has one request per operation, with assertions for status code, content type and the headers the rules require.

An endpoint whose OpenAPI entry or Bruno request lags behind is undocumented for every client and every reviewer, so the artifacts are part of the change, not a follow-up.

**Done when** every added or changed operation is in the OpenAPI document and has a Bruno request with assertions, and every removed operation is gone from both.

## 8. Check and report

Go through [the checklist](references/checklist.md) for the operations touched. When the change also configures a server, reverse proxy, compression, health endpoints or metrics, read [transport and observability](references/operations.md) as well.

Report to the caller:

- the per-API choices and where they are recorded,
- conflicts between rules and project conventions, quoting both,
- departures from MUST rules with their reasons,
- checklist items marked not applicable, with one reason each.

**Done when** every checklist item is ticked or marked not applicable with a reason, and the report is given.
