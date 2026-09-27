# Databricks notebook source
# MAGIC %run ./child_setup $env="prod"

# COMMAND ----------

catalog = dbutils.widgets.get("catalog")
