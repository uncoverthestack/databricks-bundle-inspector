# Databricks notebook source
dbutils.widgets.text("needed", "x")
name = "other"
a = dbutils.widgets.get(name)
b = dbutils.widgets.get("needed")
