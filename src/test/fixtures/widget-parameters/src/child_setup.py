# Databricks notebook source
dbutils.widgets.text("region", "eu")
env = dbutils.widgets.get("env")
region = dbutils.widgets.get("region")
batch_id = dbutils.widgets.get("batch_id")
