# Databricks notebook source
dbutils.widgets.text("region", "eu")

# COMMAND ----------

# MAGIC %sql
# MAGIC SELECT * FROM events WHERE region = :region AND day = getArgument('run_day')
