# Databricks notebook source
dbutils.widgets.text("needed", "x")
dbutils.widgets.remove("needed")
print(dbutils.widgets.get("needed"))
