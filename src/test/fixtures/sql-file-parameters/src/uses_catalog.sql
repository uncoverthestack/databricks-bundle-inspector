SELECT count(*) AS n
FROM IDENTIFIER(:catalog || '.information_schema.tables');
