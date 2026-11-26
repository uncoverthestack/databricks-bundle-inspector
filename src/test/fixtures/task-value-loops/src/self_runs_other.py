# Databricks notebook source
# MAGIC %run ./other

# COMMAND ----------

v = dbutils.jobs.taskValues.get(taskKey="selfread", key="never_set")
