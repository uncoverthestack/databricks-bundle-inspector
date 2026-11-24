# Databricks notebook source
team = "sales"
password = dbutils.secrets.get(scope=f"{team}-kv", key="pw")
