# Databricks notebook source
dbutils.widgets.text(name="dashboard_id", defaultValue="")

# COMMAND ----------

config = load_config(widgets=dbutils.widgets)
