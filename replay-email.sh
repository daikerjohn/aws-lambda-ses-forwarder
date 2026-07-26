#!/bin/bash

eml_file=$1
if [[ "$eml_file" == "" ]]; then
  echo "Must provide email file"
  exit 1
fi

AWS_PROFILE=sesforwarder-replay node replay.cjs $eml_file replay-config.json --send --replay-config replay-config.json

sleep 3
