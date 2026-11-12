CREATE FLOW orders_backfill AS
INSERT ONCE INTO orders_silver BY NAME
SELECT * FROM main.archive.orders_2024;

CREATE OR REFRESH MATERIALIZED VIEW orders_audit
AS SELECT * FROM ${audit_source}.orders;
