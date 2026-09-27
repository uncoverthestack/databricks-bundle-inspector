# Databricks notebook source
token = dbutils.secrets.get(scope="app_scope", key="api_token")
