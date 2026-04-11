# Elastic Stack Sandbox

This directory contains the first realistic local stack for `kibtrace`.

It is intentionally lightweight:

- single-node Elasticsearch
- Kibana
- Filebeat
- Postgres
- one fake app

## Goal

Give `kibtrace` a realistic Elastic-backed incident source without dragging in Fleet or Kibana automation.

## Intended Usage

1. copy `.env.example` to `.env`
2. start the stack with Docker Compose
3. let the fake app generate logs
4. inspect the documents in Kibana Discover
5. design `kibtrace fetch` against Elasticsearch, not Kibana

## First Index Pattern

The current scaffold ships logs into:

- `kibtrace-sandbox-*`

That keeps the first `fetch` contract simple and predictable.

## Notes

- security is intentionally simplified for the first scaffold
- logs are shipped from files through Filebeat, not sent directly to Elasticsearch
- the fake app is deterministic enough to regenerate the same incident family repeatedly
