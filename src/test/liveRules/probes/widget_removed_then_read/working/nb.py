# Databricks notebook source
dbutils.widgets.text("needed", "x")
print(dbutils.widgets.get("needed"))
