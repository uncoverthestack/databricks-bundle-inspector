# Databricks notebook source
for name in ["a", "b"]:
    print(dbutils.widgets.get(name))
