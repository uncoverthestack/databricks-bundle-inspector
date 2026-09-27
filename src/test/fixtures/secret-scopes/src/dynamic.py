# Databricks notebook source
scope_name = dbutils.widgets.get("scope")
pw = dbutils.secrets.get(scope=scope_name, key="db_password")
