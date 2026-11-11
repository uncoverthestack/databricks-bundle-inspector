CREATE OR REFRESH STREAMING TABLE orders_silver
AS SELECT * FROM STREAM(orders_bronze) WHERE order_id IS NOT NULL;

CREATE OR REFRESH MATERIALIZED VIEW orders_by_region
AS SELECT r.region, COUNT(*) AS orders
FROM orders_silver o
JOIN main.reference.regions r ON o.region_id = r.id
GROUP BY r.region;
