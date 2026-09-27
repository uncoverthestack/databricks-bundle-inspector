# Databricks notebook source
catalog = dbutils.widgets.get("catalog")
schema = dbutils.widgets.get("schema")
source_table = dbutils.widgets.get("source_table")
processing_date = dbutils.widgets.get("processing_date")

print(f"Preparing {catalog}.{schema} from {source_table} for {processing_date}")
