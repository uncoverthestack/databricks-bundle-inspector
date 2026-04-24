-- Databricks notebook source

SELECT 1;

-- COMMAND ----------

SELECT
try_secret('sample-test', 'db-username') AS db_username,
try_secret('sample-test', 'db-pwd') AS db_pwd,
try_secret('sample-test', 'db-jdbc-url') AS db_jdbc_url;
