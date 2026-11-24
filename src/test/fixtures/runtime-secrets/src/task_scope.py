# Databricks notebook source
password = dbutils.secrets.get(dbutils.widgets.get("task_scope"), "pw")
