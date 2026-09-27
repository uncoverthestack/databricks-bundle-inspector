# Databricks notebook source
k = dbutils.secrets.get(scope="nested-scope", key="k")
