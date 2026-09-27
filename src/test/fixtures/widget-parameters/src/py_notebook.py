# Databricks notebook source
dbutils.widgets.text("env", "dev")

# COMMAND ----------

catalog = dbutils.widgets.get("catalog")
schema = dbutils.widgets.get("schema")
env = dbutils.widgets.get("env")
run_date = dbutils.widgets.get("run_date")
