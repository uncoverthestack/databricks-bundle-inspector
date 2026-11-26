# Databricks notebook source
name = "other"
dbutils.widgets.text("other", "y")
print(dbutils.widgets.get(name))
print(dbutils.widgets.get("needed"))
