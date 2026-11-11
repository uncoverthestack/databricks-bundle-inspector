-- Raw orders from files.
CREATE OR REFRESH STREAMING TABLE orders_bronze
AS SELECT * FROM STREAM read_files('${landing}/orders', format => 'json');
