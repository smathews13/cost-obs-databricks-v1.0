# V2 Product — Databricks Expert Questions

Questions for a Databricks enterprise/platform expert to inform implementation of the four V2 features.
Context: we are building a Databricks Apps cost observability product that reads system tables,
surfaces spend analytics, and is deployed as a native Databricks App (SP auth, serverless SQL warehouse).

---

## Feature 1 — Unity AI Gateway Cost Intelligence

### System Tables & Data Availability
1. What is the exact system table name and schema for AI Gateway request logs?
   We've seen references to `system.ai.gateway_usage` — is that the correct path, and is it GA or still preview?
2. What columns are available? Specifically looking for:
   `token_count_input`, `token_count_output`, `model_name`, `provider`, `user_identity`,
   `workspace_id`, `latency_ms`, `dbu_cost`, `external_provider_cost`, `request_tags`, `endpoint_name`.
   Which of these are confirmed present?
3. What is the latency of data appearing in the table — near-real-time, 15-min delay, or daily batch?
4. Is there a separate table for budget policy state (current consumption vs limit per user/workspace/account)?

### Coverage — What Traffic Is Captured
5. Are Foundation Model API requests (DBRX, Llama 3, etc.) routed through AI Gateway automatically,
   or does the workspace admin have to configure endpoints explicitly?
6. Is Genie (AI/BI) traffic attributed through AI Gateway? Can we see Genie token spend
   broken out by space or by user?
7. Are MCP tool calls (Model Context Protocol) captured in gateway logs, or only direct model completions?
8. If an application calls an external model (OpenAI, Anthropic) through a Databricks external model
   endpoint, does the external provider cost appear in system tables or only the DBU gateway overhead?

### Budget & Rate Limit APIs
9. Can we read AI Gateway budget policy limits programmatically — e.g., the configured monthly cap
   per user or per workspace? Is this exposed via REST, SDK (`w.ai_gateway`?), or only in the UI?
10. Is there an API to read current budget consumption state (e.g., "user X has consumed $180 of their $200 limit")?
11. What happens when a budget limit is hit — hard block or soft alert? Can the enforcement mode be
    read via API so we can surface it accurately in the UI?
12. Are request-level tags (cost center, team, use case) set by the caller at request time,
    or can they be applied retroactively via policy?

### Permissions
13. What permissions does a service principal need to `SELECT` from AI Gateway system tables?
    Is it the same `USE CATALOG system` grant as other system tables, or does it require a separate enablement step?

---

## Feature 2 — Production-Grade Alerting

### Delivery Infrastructure
14. What delivery channels does the Databricks Notification Destinations API support?
    We know Slack webhook — does it also support email, PagerDuty, Microsoft Teams, and generic webhooks?
    What's the endpoint: `/api/2.0/notification-destinations`?
15. Is the Notification Destinations API available via the Python SDK (`w.notification_destinations`)?
16. Are there rate limits on delivery — e.g., max N notifications per hour per destination?
17. For email delivery specifically: does Databricks send on our behalf, or do we need to supply SMTP credentials?
    Can the "from" address be customized?

### Per-User Budget Alerts
18. For alerting when an individual user crosses a spend threshold, what's the recommended
    query pattern? Can we efficiently query `system.billing.usage` filtered by
    `identity_metadata.run_as_user_name` for same-day spend, or is there too much latency?
19. Is there a pre-aggregated system table for per-user daily spend we should use instead
    of scanning raw `system.billing.usage`?

### Databricks SQL Alerts as an Alternative
20. Can a Databricks App create and manage SQL Alerts programmatically via `w.alerts`?
    What's the alert check frequency — minimum polling interval?
21. If SQL Alerts are the right delivery mechanism, can the alert notification go to a
    Notification Destination we configure, or is it limited to email of the alert owner?

### Scheduling & Reliability in Apps Context
22. Our app runs as a Databricks App (pod-based, suspends after idle). What's the recommended
    pattern for running scheduled alert checks (e.g., every 15 minutes) in an App that may be
    suspended? Should we use a Databricks Job as the scheduler and call back to the App API,
    or is there a native App scheduling mechanism?
23. Can a Databricks App write rows to a Delta table (for alert history / audit log) using its
    own SP, without requiring user auth for every write?

---

## Feature 3 — Workspace Budget API Integration

### API Availability & Schema
24. Is the Budgets API GA? We see `/api/2.0/budgets` referenced — is the current SDK method
    `w.budgets.list()` / `w.budgets.get(budget_id)`?
25. What does a budget object look like? Specifically:
    - `budget_name`, `amount`, `period` (monthly/quarterly/annual), `start_date`
    - `filter` — what dimensions can a budget be scoped to? (workspace ID, tag key/value, cluster policy, SKU?)
    - `alert_thresholds` — are these part of the budget object or a separate resource?
    - `status` — is there a `consumed` field or do we need to compute it from usage data?
26. Is there an account-level budget API (across all workspaces) separate from the workspace-level one?
    We want to show both workspace and account-level budget progress.
27. If a budget has a tag-based filter (e.g., `team=data-eng`), can we get the corresponding
    tagged spend from `system.billing.usage` using the same filter criteria, so we can compute
    "consumed % of budget" without manual mapping?

### Permissions
28. What permission does the app's SP need to call the Budgets API read endpoints?
    Is it a workspace-level permission (Account Admin? Billing Admin?) or can any SP with
    `CAN_USE` on the workspace read budget definitions?

### Budget vs AI Gateway Budgets
29. Are Workspace Budgets (the `/api/2.0/budgets` API) and AI Gateway per-user/per-workspace
    budgets the same system or separate? Will a single "Budgets" view in our app need to pull
    from two different APIs?

---

## Feature 4 — Lakebase Integration

### Connection & Authentication
30. What is the connection pattern for a Databricks App connecting to a Lakebase (managed Postgres) instance?
    Specifically: is the connection string passed as an App environment variable, derived from the SDK,
    or available via a metadata API?
31. What authentication method does Lakebase use from an App context — service principal OAuth token,
    username/password, or IAM-based? Is there a short-lived credential refresh pattern we need to implement?
32. Is there a Databricks Python SDK method to retrieve the Lakebase JDBC/psycopg2 connection string,
    or do customers configure it manually in `app.yaml`?

### Driver & Compatibility
33. Can we connect using standard `psycopg2` or `asyncpg`, or is there a Databricks-specific driver required?
34. Are there any known Postgres feature limitations in Lakebase we should design around?
    Specifically: JSONB operators, array types, `ON CONFLICT DO UPDATE` (upsert), `LISTEN/NOTIFY`,
    and row-level security — which are supported?

### Performance & Operations
35. What is the typical P99 latency for Lakebase point reads vs a Delta table query through
    a serverless SQL warehouse? We're targeting <10ms for role lookups on every request.
36. What connection pool size is recommended for a FastAPI app with ~20 concurrent requests?
    Is there a max connections limit per Lakebase instance?
37. Is Lakebase HA with automatic failover? What's the RTO/RPO? Is there a maintenance window?
38. How do we handle the case where Lakebase is unavailable — can we fall back to Delta reads
    gracefully without the app going down?

### Data Migration
39. What's the recommended pattern for migrating existing data from Delta tables to Lakebase at
    first startup? Can we use `spark.read.table()` → pandas → psycopg2 batch insert,
    or is there a higher-throughput path (e.g., Databricks COPY INTO for Postgres)?
40. Are there backup/restore options for Lakebase, or do we need to maintain a Delta copy
    as a backup source of truth?

### Multi-Tenancy
41. For a multi-workspace deployment (one App instance, multiple Databricks workspaces),
    should we use one Lakebase instance shared across workspaces, or one per workspace?
    What isolation guarantees does Lakebase provide at the schema/database level?

---

## General Platform Questions

42. Is there a Databricks Apps SDK or documented pattern for Apps calling back to the
    Databricks REST API using the App's own SP credentials (not the forwarded user token)?
    We use this today for DDL operations — want to confirm it's a supported pattern.
43. What is the Databricks Apps pod suspension policy? We've observed ~10 min idle timeout —
    is this configurable, and is there a way to keep the pod warm without a heartbeat hack?
44. For Apps deployed across multiple workspaces (e.g., a customer with 5 Databricks workspaces),
    is the recommended deployment model one App per workspace, or is there a multi-workspace
    App deployment pattern we should know about?
