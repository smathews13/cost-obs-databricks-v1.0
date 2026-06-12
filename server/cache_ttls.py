"""Central cache TTL constants.

All cache durations in seconds. Change a policy here; it propagates everywhere.
"""

# --- Delta response cache (delta_cache_put) ---
BUNDLE = 1800          # Analytics bundles: 30 min — expensive aggregations, low churn
BUNDLE_FILTERED = 1800  # Same bundles when a workspace filter is active: 30 min (filter is a WHERE clause, not fresher data)
KPI = 300              # KPI endpoints: 5 min — users expect near-real-time numbers
TREND = 1800           # Timeseries / trend data: 30 min
INFRA = 1800           # Infrastructure cost bundles: 30 min

# --- In-memory / TTLCache ---
STALE_KPI = 3600       # Last-known-good KPI fallback: 1 h
QUERY_CACHE = 7200     # Raw query cache (db.py): 2 h
PIPELINE_NAMES = 3600  # Pipeline name lookup: 1 h
GROUP_MEMBERSHIP = 3600  # SCIM group membership: 1 h
PERMISSIONS = 60       # User role lookup: 60 s — balance freshness vs warehouse load
APP_NAME = 3600        # Databricks App name list: 1 h
APP_RESOURCES = 1800   # App SDK resource list: 30 min
THUMBNAIL = 600        # App thumbnail: 10 min
OWNER = 3600           # Table owner lookup: 1 h
TABLES_STATUS = 900    # Settings tables status: 15 min
HEALTH = 1800          # Warehouse health recommendations: 30 min
MV_CHECK = 1800        # MV availability re-check: 30 min — MVs only vanish on rebuild
ALERTS_CHECK = 300     # Alert config cache: 5 min
CLOUD_STATUS = 300     # AWS / Azure / GCP data availability: 5 min
