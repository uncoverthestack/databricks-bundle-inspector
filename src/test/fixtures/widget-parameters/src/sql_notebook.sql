-- Databricks notebook source
CREATE WIDGET TEXT limit_rows DEFAULT '10';

-- COMMAND ----------

SELECT * FROM IDENTIFIER(:catalog || '.' || :schema) LIMIT :limit_rows;

-- COMMAND ----------

SELECT '${region}' AS region, ts::string, raw:owner, '12:30' AS not_a_widget FROM events;
