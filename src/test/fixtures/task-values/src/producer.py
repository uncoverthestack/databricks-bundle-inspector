# Databricks notebook source
dbutils.jobs.taskValues.set(key="row_count", value=42)
dbutils.jobs.taskValues.set("run_id", "abc")
