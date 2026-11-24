# Databricks notebook source
scope = dbutils.widgets.get("shared_scope")
password = dbutils.secrets.get(scope=scope, key="pw")
