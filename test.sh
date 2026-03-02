#!/bin/bash

curl -X POST http://127.0.0.1:9371/exists \
  -H "Content-Type: application/json" \
  -d '{
    "queries": [
      { "id": "a", "doi": "10.1038/s41562-024-01867-y" },
      { "id": "b", "title": "Neuro2Semantic" }
    ]
  }'
