#!/bin/bash
# Check for compliance artifacts that should not be in the codebase

FORBIDDEN_PHRASES=(
  "100% pronto"
  "gate alcançado"
  "Prompt [0-9][0-9]* —"
)

EXIT_CODE=0

for phrase in "${FORBIDDEN_PHRASES[@]}"; do
  echo "Checking for '$phrase'..."
  if rg -q "$phrase" src/ supabase/functions/; then
    echo "ERROR: Found forbidden compliance artifact '$phrase' in the following files:"
    rg -l "$phrase" src/ supabase/functions/
    EXIT_CODE=1
  fi
done

if [ $EXIT_CODE -eq 0 ]; then
  echo "Compliance check passed: No artifacts found."
else
  echo "Compliance check failed."
fi

exit $EXIT_CODE
