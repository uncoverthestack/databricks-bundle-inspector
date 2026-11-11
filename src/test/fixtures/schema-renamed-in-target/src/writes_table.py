# Databricks notebook source
schema = dbutils.widgets.get("schema")
spark.table(f"workspace.{schema}.orders").count()

# COMMAND ----------

df = spark.table("workspace.dbi_sales.orders")
df.write.saveAsTable("workspace.dbi_sales.orders_copy")
