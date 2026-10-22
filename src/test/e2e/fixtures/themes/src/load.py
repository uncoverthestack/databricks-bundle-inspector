# Databricks notebook source
region = dbutils.widgets.get("region")
country = dbutils.widgets.get("country")
print(region, country)
